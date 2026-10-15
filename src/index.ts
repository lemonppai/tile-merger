import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePattern, isImageFile, parseTilePath } from './core/pattern';
import { buildPlan } from './core/layout';
import {
  EXT_BY_FORMAT,
  countOutputCells,
  inspectTiles,
  layoutTemplate,
  mergeTiles,
  normalizeOutLayout,
  resolveFormat,
} from './core/merge';
import { openSource } from './core/source';
import type { MergePlan, MergeTilesResult, OutputFormat, OutputMode } from './core/types';
import { askConfirm, askInput, askSelect, separator, type ChoiceOrSeparator } from './ui/ask';
import { browseInteractively, promptOutputName } from './ui/browser';
import { dialogDisabled, openInFileManager, pickDirectory, pickZipFiles } from './ui/dialog';
import { createProgressRenderer, logger } from './ui/logger';

export { buildPlan, inspectTiles, layoutTemplate, mergeTiles, openSource, resolveFormat };
export type * from './core/types';

/** 单张整图超过该字节数时提示内存风险（约 2GB RGBA） */
const SINGLE_MODE_MEMORY_WARN_BYTES = 2 * 1024 ** 3;

export interface CliOptions {
  inputs: string[];
  output?: string;
  name?: string;
  mode: OutputMode;
  format?: OutputFormat;
  background?: string | null;
  pattern?: string | null;
  outLayout?: string | null;
  tms: boolean;
  quality?: number;
  concurrency?: number;
  keepEmpty: boolean;
  overwrite: boolean;
  yes: boolean;
  noDialog: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
}

function normalizeFormat(value: string | undefined): OutputFormat | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'png') return 'png';
  if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg';
  if (normalized === 'webp') return 'webp';
  throw new Error(`不支持的输出格式：${value}（可选 png / jpg / webp）`);
}

/** 解析命令行参数 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputs: [],
    mode: 'tiles',
    tms: false,
    keepEmpty: false,
    overwrite: true,
    yes: false,
    noDialog: false,
    debug: false,
    help: false,
    version: false,
  };

  const pushInput = (raw: string): void => {
    for (const part of raw.split(/[,;]/)) {
      const value = part.trim().replace(/^"(.*)"$/, '$1');
      if (value) options.inputs.push(value);
    }
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? '';
    let inline: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > -1) {
        inline = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    const next = (): string | undefined => (inline !== undefined ? inline : argv[++i]);

    switch (arg) {
      case '-i':
      case '--input':
        pushInput(next() ?? '');
        break;
      case '-o':
      case '--output':
        options.output = next();
        break;
      case '-n':
      case '--name':
        options.name = next();
        break;
      case '--single':
        options.mode = 'single';
        break;
      case '--tiles':
        options.mode = 'tiles';
        break;
      case '-f':
      case '--format':
        options.format = normalizeFormat(next());
        break;
      case '-b':
      case '--background':
        options.background = next() ?? null;
        break;
      case '--pattern':
        options.pattern = next() ?? null;
        break;
      case '--out-layout':
        options.outLayout = next() ?? null;
        break;
      case '--quality':
        options.quality = Number(next());
        break;
      case '-c':
      case '--concurrency':
        options.concurrency = Number(next());
        break;
      case '--keep-empty':
        options.keepEmpty = true;
        break;
      case '--tms':
        options.tms = true;
        break;
      case '--no-overwrite':
        options.overwrite = false;
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '--no-dialog':
        options.noDialog = true;
        break;
      case '-d':
      case '--debug':
        options.debug = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
        // 裸路径按图层输入处理
        pushInput(arg);
    }
  }

  return options;
}

const HELP = `
tile-merger — 瓦片图层合并工具

把「基本图层」与「标注图层」按瓦片坐标对齐叠加，输出合并后的瓦片目录（或一整张图片）。

用法：
  tile-merger                              # 交互式引导（推荐）
  tile-merger -i ./base -i ./label -o ./out --yes

默认输出模式（tiles）：按坐标目录结构输出合并后的瓦片，例如
  ./out/3/1/2.png      即 z=3, x=1, y=2 这一格的合并结果
输出结构与输入一致：{z}/{x}/{y}.png（各图层按同坐标叠加成一张）。
只要有一个图层带层级信息，z 就会保留；全部图层都没有层级信息时才退化为 {x}/{y}.png。
只需指定输出文件夹，无需指定文件名。

参数：
  -i, --input <路径>       图层文件夹或 .zip（可重复，按顺序从下往上叠加：第 1 个在最底层）
  -o, --output <目录>      输出文件夹（不存在会自动创建）
      --single             改为输出「一整张合并图片」而非瓦片目录
  -n, --name <文件名>      仅 --single 模式需要，如 merged.png
  -f, --format <格式>      输出格式 png | jpg | webp（缺省 png；single 模式按文件名后缀）
  -b, --background <色值>  背景色，如 #ffffff（缺省透明，JPEG 输出时缺省白色）
      --pattern <模板>     自定义坐标模板，如 "{z}/{x}/{y}"、"{x}_{y}"（缺省自动识别）
      --out-layout <模板>  自定义输出结构，如 "{z}/{x}/{y}"、"{x}/{y}/{z}"、
                           "{z}/{x}_{y}"（缺省 {z}/{x}/{y}，无层级时 {x}/{y}）
      --tms                输入为 TMS 坐标系（Y 轴自下而上），对所有图层统一生效
      --quality <1-100>    jpg/webp 质量，缺省 90
  -c, --concurrency <n>    tiles 模式并发数，缺省 min(8, CPU 核数)
      --keep-empty         完全透明的瓦片也写出（缺省跳过）
      --no-overwrite       已存在的瓦片/文件不覆盖（tiles 模式跳过并提示）
  -y, --yes                跳过所有交互（需同时提供 --input/--output）
      --no-dialog          不使用系统文件选择对话框，改用内置浏览器
  -d, --debug              输出调试信息
  -h, --help               查看帮助
  -v, --version            查看版本
`.trim();

const VERSION = '1.2.0';

const labelOf = (p: string): string => path.basename(p);

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const pad = (text: string, width: number): string => {
  // 中文按 2 个字符宽度计算，保证列对齐
  let len = 0;
  for (const char of text) len += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - len));
};

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

/** 打印当前图层顺序 */
function printOrder(inputs: string[]): void {
  console.log('');
  console.log(`  ${logger.dim('叠加顺序（下 → 上）')}`);
  inputs.forEach((input, index) => {
    const tag = index === 0 ? '基本图层' : '标注图层';
    console.log(`   ${pad(`${index + 1}. ${labelOf(input)}`, 46)} ${logger.dim(tag)}`);
  });
  console.log('');
}

/** 输出结构展示用的层级值：存在多个层级时保留 {z} 占位 */
const zoomDisplayOf = (plan: MergePlan): number | null | 'any' =>
  (plan.zooms ?? []).length > 1 ? 'any' : plan.z;

/** 打印合并计划 */
function printPlan(
  plan: MergePlan,
  mode: OutputMode,
  format: OutputFormat,
  outLayout?: string | null,
): void {
  console.log('');
  for (const layer of plan.layers) {
    const kind = layer.kind === 'zip' ? '压缩包' : '文件夹';
    const zoom = layer.z === null ? '混合' : `z=${layer.z}`;
    console.log(
      `   ${pad(`${layer.index + 1}. ${layer.label}`, 40)} ${logger.dim(`[${kind}] ${layer.tiles.length} 张瓦片  ${zoom}`)}`,
    );
    if (layer.skipped.length) {
      console.log(
        `      ${logger.dim(`已忽略 ${layer.skipped.length} 个无法解析坐标的文件，如 ${layer.skipped[0]}`)}`,
      );
    }
  }
  console.log('');
  console.log(
    `   网格范围   ${plan.minX},${plan.minY} → ${plan.maxX},${plan.maxY}（${plan.cols} × ${plan.rows} 格）`,
  );
  console.log(`   单瓦片尺寸 ${plan.tileWidth} × ${plan.tileHeight}`);
  if (mode === 'tiles') {
    const holes = plan.holes > 0 ? logger.dim(`（${plan.holes} 格无覆盖，不输出）`) : '';
    console.log(
      `   输出结构   ${logger.accent(layoutTemplate(zoomDisplayOf(plan), format, outLayout))}  共 ${countOutputCells(plan)} 张瓦片${holes}`,
    );
  } else {
    console.log(`   输出尺寸   ${plan.width} × ${plan.height} px（一整张图片）`);
  }
  console.log(`   瓦片总数   ${plan.totalTiles} 张`);
  console.log('');
}

/** 让用户选择一批图层来源 */
async function pickSources(): Promise<string[]> {
  const useDialog = !dialogDisabled();
  const choices: ChoiceOrSeparator<string>[] = [];
  if (useDialog) {
    choices.push({ name: '📁 选择图层文件夹（系统对话框）', value: 'dialog-dir' });
    choices.push({ name: '🗜️  选择 zip 压缩包（系统对话框，可多选）', value: 'dialog-zip' });
  }
  choices.push({ name: '📂 使用内置文件浏览器', value: 'browse' });
  choices.push({ name: '⌨️  手动输入路径', value: 'manual' });
  choices.push(separator());
  choices.push({ name: '✖️  取消', value: 'cancel' });

  const method = await askSelect<string>({
    message: '通过哪种方式选择图层来源？',
    choices,
  });

  if (method === 'dialog-dir') {
    const picked = pickDirectory('请选择瓦片图层文件夹');
    if (!picked) logger.warn('未选择任何文件夹');
    return picked ? [picked] : [];
  }

  if (method === 'dialog-zip') {
    const picked = pickZipFiles('请选择瓦片图层压缩包（可多选）');
    if (!picked.length) logger.warn('未选择任何压缩包');
    return picked;
  }

  if (method === 'browse') {
    const picked = await browseInteractively({ message: '选择图层来源', mode: 'source' });
    return picked ? [picked] : [];
  }

  if (method === 'manual') {
    const raw = await askInput({
      message: '请输入图层路径（多个用逗号分隔，按输入顺序从下往上叠加）',
    });
    return raw
      .split(/[,;]/)
      .map((item) => item.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
  }

  return [];
}

/** 校验并添加一个图层输入，同时做一次轻量体检 */
async function addInput(inputs: string[], raw: string, cli: CliOptions): Promise<void> {
  const resolved = path.resolve(raw);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) {
    logger.error(`路径不存在：${resolved}`);
    return;
  }
  if (stat.isFile() && !/\.zip$/i.test(resolved)) {
    logger.error(`只支持图层文件夹或 .zip 压缩包：${resolved}`);
    return;
  }

  try {
    const source = await openSource(resolved);
    const files = await source.list();
    const images = files.filter(isImageFile);
    const pattern = cli.pattern ? compilePattern(cli.pattern) : null;
    let parsed = 0;
    const zooms = new Set<number>();
    for (const file of images) {
      const coord = parseTilePath(file, pattern);
      if (coord) {
        parsed += 1;
        if (coord.z !== null) zooms.add(coord.z);
      }
    }

    inputs.push(resolved);
    const kind = stat.isDirectory() ? '文件夹' : '压缩包';
    if (!images.length) {
      logger.warn(`已添加「${source.label}」，但其中没有图片文件`);
    } else if (!parsed) {
      logger.warn(
        `已添加「${source.label}」，但 ${images.length} 张图片都无法解析坐标（可尝试 --pattern 指定模板）`,
      );
    } else {
      const zoom =
        zooms.size === 1 ? `，z=${[...zooms][0]}` : zooms.size > 1 ? `，混合层级 ${zooms.size} 个` : '';
      logger.success(`已添加：${source.label}（${kind}，识别到 ${parsed} 张瓦片${zoom}）`);
    }
  } catch (error) {
    logger.error(`添加失败：${(error as Error).message}`);
  }
}

/** 调整图层叠加顺序 */
async function reorderInputs(inputs: string[]): Promise<void> {
  for (;;) {
    if (inputs.length < 2) {
      logger.info('少于 2 个图层，无需排序');
      return;
    }
    const choices: ChoiceOrSeparator<number>[] = inputs.map((input, index) => ({
      name: `${index + 1}. ${labelOf(input)}${index === 0 ? logger.dim('  ← 最底层') : ''}`,
      value: index,
    }));
    choices.push(separator(), { name: '✅ 完成', value: -1 });

    const index = await askSelect<number>({
      message: '选择要调整的图层（第 1 项在最底层）',
      choices,
    });
    if (index < 0) return;

    const action = await askSelect<string>({
      message: `对「${labelOf(inputs[index])}」执行`,
      choices: [
        { name: '↑  向上一层（覆盖更多图层）', value: 'up' },
        { name: '↓  向下一层', value: 'down' },
        { name: '⏫  移到最顶层', value: 'top' },
        { name: '⏬  移到最底层（作为基本图层）', value: 'bottom' },
        separator(),
        { name: '↩️  返回', value: 'back' },
      ],
    });

    const [item] = inputs.splice(index, 1);
    if (action === 'up') inputs.splice(Math.min(inputs.length, index + 1), 0, item);
    else if (action === 'down') inputs.splice(Math.max(0, index - 1), 0, item);
    else if (action === 'top') inputs.push(item);
    else if (action === 'bottom') inputs.unshift(item);
    else inputs.splice(index, 0, item);

    if (action !== 'back') printOrder(inputs);
  }
}

/** 移除图层 */
async function removeInput(inputs: string[]): Promise<void> {
  for (;;) {
    const choices: ChoiceOrSeparator<number>[] = inputs.map((input, index) => ({
      name: `${index + 1}. ${labelOf(input)}`,
      value: index,
    }));
    choices.push(separator(), { name: '✅ 完成', value: -1 });

    const index = await askSelect<number>({ message: '选择要移除的图层', choices });
    if (index < 0) return;

    const [removed] = inputs.splice(index, 1);
    logger.success(`已移除：${labelOf(removed)}`);
    if (!inputs.length) return;
    printOrder(inputs);
  }
}

/** 交互式收集图层输入 */
async function collectInputs(inputs: string[], cli: CliOptions): Promise<void> {
  for (;;) {
    if (!inputs.length) {
      const picked = await pickSources();
      for (const item of picked) await addInput(inputs, item, cli);
      if (!inputs.length) return;
      continue;
    }

    printOrder(inputs);
    const action = await askSelect<string>({
      message: '图层操作',
      choices: [
        { name: '➕ 继续添加图层', value: 'add' },
        { name: '🔀 调整图层叠加顺序', value: 'reorder' },
        { name: '🗑️  移除某个图层', value: 'remove' },
        separator(),
        { name: `✅ 开始合并（共 ${inputs.length} 个图层）`, value: 'done' },
        { name: '✖️  退出', value: 'quit' },
      ],
    });

    if (action === 'add') {
      const picked = await pickSources();
      for (const item of picked) await addInput(inputs, item, cli);
    } else if (action === 'reorder') {
      await reorderInputs(inputs);
    } else if (action === 'remove') {
      await removeInput(inputs);
      if (!inputs.length) return;
    } else if (action === 'done') {
      return;
    } else {
      inputs.length = 0;
      return;
    }
  }
}

/** 选择输出文件夹 */
async function promptOutputDir(): Promise<string> {
  const cwd = process.cwd();
  if (!dialogDisabled()) {
    const picked = pickDirectory('请选择合并结果的输出文件夹');
    if (picked) return picked;
  }
  const method = await askSelect<string>({
    message: '选择输出文件夹的方式',
    choices: [
      { name: `📁 使用当前目录：${cwd}`, value: 'cwd' },
      { name: '📂 使用内置文件浏览器选择', value: 'browse' },
      { name: '⌨️  手动输入路径', value: 'manual' },
    ],
  });
  if (method === 'cwd') return cwd;
  if (method === 'browse') {
    const picked = await browseInteractively({ message: '选择输出文件夹', mode: 'dir', startDir: cwd });
    return picked ?? cwd;
  }
  const raw = await askInput({ message: '请输入输出文件夹路径', default: cwd });
  const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
  return path.resolve(trimmed || cwd);
}

function printResult(result: MergeTilesResult): void {
  console.log('');
  logger.success('合并完成');
  console.log('');
  if (result.mode === 'single') {
    console.log(`   ${pad('输出文件', 12)} ${logger.accent(result.outputPath ?? '')}`);
    console.log(`   ${pad('图片尺寸', 12)} ${result.width} × ${result.height} px`);
  } else {
    console.log(`   ${pad('输出目录', 12)} ${logger.accent(result.outputDir)}`);
    console.log(`   ${pad('目录结构', 12)} ${result.layout}`);
    console.log(
      `   ${pad('输出瓦片', 12)} ${result.tileCount} 张（单张 ${result.width} × ${result.height}）`,
    );
    console.log(
      `   ${pad('网格', 12)} ${result.cols} × ${result.rows} 格${result.holes > 0 ? `（${result.holes} 格无覆盖）` : ''}`,
    );
    if (result.emptySkipped > 0) {
      console.log(`   ${pad('跳过', 12)} ${result.emptySkipped} 张完全透明`);
    }
  }
  console.log(`   ${pad('图层数量', 12)} ${result.layerCount} 个图层`);
  if (result.z !== null) console.log(`   ${pad('层级 z', 12)} ${result.z}`);
  console.log(`   ${pad('文件大小', 12)} ${fmtBytes(result.bytes)}`);
  console.log(`   ${pad('耗时', 12)} ${(result.durationMs / 1000).toFixed(2)} s`);
  if (result.warnings.length) {
    console.log('');
    for (const warning of result.warnings) logger.warn(warning);
  }
  console.log('');
}

/**
 * 主编排入口：交互式引导 + 命令行参数双通道
 */
export async function generate(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(HELP);
    return;
  }
  if (cli.version) {
    console.log(VERSION);
    return;
  }
  if (cli.noDialog) process.env.TILE_MERGER_NO_DIALOG = '1';
  const outLayout = cli.outLayout ?? null;
  if (outLayout) normalizeOutLayout(outLayout);

  const mode = cli.mode;
  const interactive = !cli.yes;
  if (interactive && !process.stdin.isTTY) {
    throw new Error(
      '当前环境不是交互式终端，无法进行选择操作。请改用非交互模式，例如：' +
        'tile-merger -i ./base -i ./label -o ./out --yes',
    );
  }

  let step = 0;
  const head = (text: string): void => {
    const marks = ['①', '②', '③', '④', '⑤'];
    const label = interactive ? `${marks[step++] ?? '•'} ` : '';
    logger.title(`${label}${text}`);
  };
  const inputs = [...cli.inputs];

  // ① 图层输入
  if (!inputs.length) {
    if (!interactive) {
      throw new Error('未提供图层输入（--input），且已用 --yes 跳过交互式选择');
    }
    head('选择图层来源');
    console.log(logger.dim('   第 1 个图层在最底层（基本图层），后续图层依次叠加在上面（标注图层）'));
    await collectInputs(inputs, cli);
    if (!inputs.length) {
      logger.warn('未选择任何图层，已退出');
      return;
    }
  } else {
    for (const input of inputs) {
      if (!(await exists(path.resolve(input)))) {
        throw new Error(`输入路径不存在：${path.resolve(input)}`);
      }
    }
  }

  // ② 输出文件夹
  let outputDir = cli.output;
  if (!outputDir) {
    if (!interactive) throw new Error('缺少输出文件夹（--output）');
    head('选择输出文件夹');
    outputDir = await promptOutputDir();
  }

  // ③ 输出文件名（仅单图模式需要）
  let outputName = cli.name;
  if (mode === 'single' && !outputName) {
    if (!interactive) throw new Error('--single 模式需要指定输出文件名（--name）');
    head('输入输出文件名');
    const defaultName = `merged${cli.format ? EXT_BY_FORMAT[cli.format] : '.png'}`;
    outputName = await promptOutputName(defaultName);
  }

  // ④ 解析图层坐标
  head('解析图层坐标');
  const progress = createProgressRenderer();
  let plan: MergePlan;
  try {
    plan = await inspectTiles(inputs, {
      pattern: cli.pattern,
      tms: cli.tms,
      onProgress: (event) => progress.update(`${event.message} ...`),
    });
  } finally {
    progress.done();
  }

  const format: OutputFormat = cli.format ?? 'png';
  printPlan(plan, mode, format, outLayout);

  if (cli.debug) {
    for (const layer of plan.layers) {
      console.log(
        logger.dim(
          `   [debug] ${layer.path} → ${layer.minX},${layer.minY} ~ ${layer.maxX},${layer.maxY}`,
        ),
      );
    }
  }

  // 单图模式的内存风险提示
  if (mode === 'single') {
    const needBytes = plan.width * plan.height * 4;
    if (needBytes > SINGLE_MODE_MEMORY_WARN_BYTES) {
      logger.warn(`整张图片画布约需 ${fmtBytes(needBytes)} 内存，建议改用默认的瓦片输出模式`);
      if (interactive && !(await askConfirm({ message: '是否继续？', default: false }))) {
        return;
      }
    }
  }

  const target =
    mode === 'single'
      ? path.join(
          path.resolve(outputDir),
          resolveFormat(path.basename(outputName ?? 'merged.png'), cli.format).name,
        )
      : `${path.resolve(outputDir)}${path.sep}${layoutTemplate(zoomDisplayOf(plan), format, outLayout)}`;

  if (interactive) {
    const ok = await askConfirm({
      message: `将输出到 ${target}，确认开始合并？`,
      default: true,
    });
    if (!ok) {
      logger.warn('已取消');
      return;
    }
  }

  const result = await mergeTiles({
    inputs,
    outputDir,
    mode,
    outputName,
    format: cli.format,
    background: cli.background,
    pattern: cli.pattern,
    outLayout,
    tms: cli.tms,
    quality: cli.quality,
    concurrency: cli.concurrency,
    keepEmpty: cli.keepEmpty,
    overwrite: cli.overwrite,
    plan,
    onProgress: (event) => {
      const percent = event.total > 1 ? ` [${Math.round((event.current / event.total) * 100)}%]` : '';
      progress.update(`${event.message}${percent}`);
    },
  });
  progress.done();

  printResult(result);

  if (interactive) {
    const shouldOpen = await askConfirm({
      message: '是否打开输出目录？',
      default: true,
    });
    if (shouldOpen) openInFileManager(result.outputDir);
  }
}

/** 判断是否作为主模块直接运行 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

process.on('uncaughtException', (error) => {
  const name = (error as Error)?.name;
  if (name === 'ExitPromptError' || name === 'AbortPromptError') {
    console.log(`\n${logger.dim('已取消操作')}`);
    process.exit(0);
  }
  throw error;
});

if (isMainModule()) {
  generate().catch((error: unknown) => {
    const name = (error as Error)?.name;
    if (name === 'ExitPromptError' || name === 'AbortPromptError') {
      console.log(`\n${logger.dim('已取消操作')}`);
      process.exit(0);
    }
    logger.error((error as Error).message ?? String(error));
    process.exit(1);
  });
}
