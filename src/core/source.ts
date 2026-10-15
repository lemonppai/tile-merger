import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { SourceKind, TileSource } from './types';

/** 统一转成 POSIX 分隔符，便于跨平台解析坐标 */
export const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** 递归收集目录下所有文件的相对路径 */
async function walkDir(root: string, dir: string = root, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(root, full, out);
    } else if (entry.isFile()) {
      out.push(toPosix(path.relative(root, full)));
    }
  }
  return out;
}

/** 打开一个图层输入源（文件夹或 zip） */
export async function openSource(rawPath: string, label?: string): Promise<TileSource> {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('图层输入路径为空');
  }
  const abs = path.resolve(rawPath.trim().replace(/^"(.*)"$/, '$1'));
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) {
    throw new Error(`输入路径不存在：${abs}`);
  }

  if (stat.isDirectory()) {
    const kind: SourceKind = 'dir';
    return {
      kind,
      path: abs,
      label: label ?? path.basename(abs),
      list: () => walkDir(abs),
      read: (rel) => fs.readFile(path.join(abs, rel)),
    };
  }

  if (stat.isFile() && /\.zip$/i.test(abs)) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(abs);
    } catch (error) {
      throw new Error(`无法读取 zip 压缩包：${abs}（${(error as Error).message}）`);
    }
    const entryMap = new Map<string, AdmZip.IZipEntry>();
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const key = toPosix(entry.entryName).replace(/^\.?\//, '');
      if (key) entryMap.set(key, entry);
    }
    return {
      kind: 'zip',
      path: abs,
      label: label ?? path.basename(abs),
      list: async () => [...entryMap.keys()],
      read: async (rel) => {
        const entry = entryMap.get(toPosix(rel).replace(/^\.?\//, ''));
        if (!entry) throw new Error(`压缩包内找不到条目：${rel}`);
        return entry.getData();
      },
    };
  }

  throw new Error(`不支持的输入类型（需要图层文件夹或 .zip 文件）：${abs}`);
}
