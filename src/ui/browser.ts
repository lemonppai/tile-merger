import fs from 'node:fs/promises';
import path from 'node:path';
import { askInput, askSelect, separator, type ChoiceOrSeparator } from './ask';

export type BrowseMode = 'source' | 'dir';

type BrowseAction =
  | { action: 'pick'; name?: string }
  | { action: 'enter'; name: string }
  | { action: 'up' }
  | { action: 'manual' }
  | { action: 'cancel' };

/**
 * 内置终端文件浏览器。
 * 当原生系统对话框不可用时（无 GUI / 远程终端）作为兜底方案，
 * 让用户逐层进入目录，选择「当前目录」或某个 .zip 压缩包。
 */
export async function browseInteractively(options: {
  message: string;
  mode: BrowseMode;
  startDir?: string;
}): Promise<string | null> {
  let cwd = path.resolve(options.startDir ?? process.cwd());

  for (;;) {
    const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const zips =
      options.mode === 'source'
        ? entries
            .filter((entry) => entry.isFile() && /\.zip$/i.test(entry.name))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
        : [];

    const choices: ChoiceOrSeparator<BrowseAction>[] = [];
    choices.push({ name: `✅ 使用当前目录：${cwd}`, value: { action: 'pick' } });
    for (const dir of dirs) {
      choices.push({ name: `📁 ${dir}/`, value: { action: 'enter', name: dir } });
    }
    for (const zip of zips) {
      choices.push({ name: `🗜️  ${zip}`, value: { action: 'pick', name: zip } });
    }
    choices.push(separator());
    const parent = path.dirname(cwd);
    if (parent !== cwd) choices.push({ name: '⬆️  返回上级目录', value: { action: 'up' } });
    choices.push({ name: '⌨️  手动输入路径', value: { action: 'manual' } });
    choices.push({ name: '✖️  取消', value: { action: 'cancel' } });

    const hint =
      options.mode === 'source'
        ? '可选：图层文件夹，或 .zip 瓦片压缩包'
        : '选择一个文件夹作为输出目录';
    const answer = await askSelect<BrowseAction>({
      message: `${options.message}\n  ${hint}\n  当前目录：${cwd}`,
      choices,
      pageSize: 16,
    });

    switch (answer.action) {
      case 'pick':
        return answer.name ? path.join(cwd, answer.name) : cwd;
      case 'enter':
        cwd = path.join(cwd, answer.name);
        break;
      case 'up':
        cwd = path.dirname(cwd);
        break;
      case 'manual': {
        const raw = await askInput({
          message: '请输入路径（绝对路径，或相对于当前目录）',
          default: cwd,
        });
        const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
        if (!trimmed) break;
        const resolved = path.resolve(trimmed);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat) {
          console.log(`  ✖️  路径不存在：${resolved}`);
          break;
        }
        if (options.mode === 'source' && stat.isFile() && !/\.zip$/i.test(resolved)) {
          console.log('  ✖️  请选择文件夹或 .zip 压缩包');
          break;
        }
        if (options.mode === 'dir' && !stat.isDirectory()) {
          console.log('  ✖️  请选择一个文件夹');
          break;
        }
        return resolved;
      }
      default:
        return null;
    }
  }
}

/** 手动输入输出文件名（自动校验后缀） */
export async function promptOutputName(defaultName = 'merged.png'): Promise<string> {
  return askInput({
    message: '请输入合并后的输出文件名',
    default: defaultName,
    validate: (value: string) => {
      const name = (value ?? '').trim();
      if (!name) return '文件名不能为空';
      if (/[\\/]/.test(name)) return '文件名不能包含路径分隔符';
      if (name === '.' || name === '..') return '非法的文件名';
      if (!/\.(png|jpe?g|webp)$/i.test(name)) return '请使用 .png / .jpg / .webp 后缀';
      return true;
    },
  });
}
