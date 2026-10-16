import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { resolveCompression, type ResolvedCompression } from './compress';
import { buildPlan } from './layout';
import { openSource } from './source';
import { scanLayer } from './scan';
import type {
  LayerInfo,
  MergePlan,
  MergeTilesOptions,
  MergeTilesResult,
  OutputFormat,
  TileRef,
} from './types';

/** 解析 #RGB / #RRGGBB / #RRGGBBAA 背景色 */
export function parseColor(input: string): { r: number; g: number; b: number; alpha: number } {
  const hex = input.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
    throw new Error(`无法识别的颜色值：${input}（支持 #RGB / #RRGGBB / #RRGGBBAA）`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    alpha: full.length === 8 ? parseInt(full.slice(6, 8), 16) : 255,
  };
}

export const FORMAT_BY_EXT: Record<string, OutputFormat> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
};

export const EXT_BY_FORMAT: Record<OutputFormat, string> = {
  png: '.png',
  jpeg: '.jpg',
  webp: '.webp',
};

/** 由输出文件名推断格式；显式指定 format 时以它为准并纠正后缀 */
export function resolveFormat(
  outputName: string,
  format?: OutputFormat,
): { name: string; format: OutputFormat } {
  const ext = path.extname(outputName).toLowerCase();
  const detected = FORMAT_BY_EXT[ext];

  if (format) {
    const stem = detected ? outputName.slice(0, -ext.length) : outputName;
    return { name: `${stem}${EXT_BY_FORMAT[format]}`, format };
  }
  if (detected) return { name: outputName, format: detected };
  return { name: `${outputName}.png`, format: 'png' };
}

/** 支持的输出结构占位符 */
const OUT_TOKEN = /\{(x|y|z|ext)\}/gi;

/** 输出结构展示值：`'any'` 表示保留 {z} 占位（存在多个层级时使用） */
export type LayoutZoom = number | null | 'any';

/** 校验并归一化输出结构模板，如 `{z}/{x}/{y}` */
export function normalizeOutLayout(template: string): string {
  const tpl = template.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!tpl) throw new Error('输出结构模板不能为空');
  if (/(^|\/)\.\.(\/|$)/.test(tpl)) throw new Error(`输出结构模板不能包含 ".."：${template}`);
  if (!/\{x\}/i.test(tpl) || !/\{y\}/i.test(tpl)) {
    throw new Error(`输出结构模板必须包含 {x} 与 {y}，例如 "{z}/{x}/{y}"（当前：${template}）`);
  }
  if (/[<>:"|?*]/.test(tpl)) throw new Error(`输出结构模板包含非法字符：${template}`);
  const unknown = tpl.replace(OUT_TOKEN, '').match(/\{[^}]*\}/);
  if (unknown) {
    throw new Error(`输出结构模板含未知占位符 ${unknown[0]}（仅支持 {z} {x} {y} {ext}）`);
  }
  return tpl;
}

/** 缺省输出结构：有层级用 `{z}/{x}/{y}`，完全没有层级信息时退化为 `{x}/{y}` */
function defaultOutLayout(zoom: LayoutZoom): string {
  return zoom === null ? '{x}/{y}' : '{z}/{x}/{y}';
}

/**
 * 输出目录结构（用于展示），如 `3/{x}/{y}.png`。
 * zoom 传具体数值时替换 {z}；传 null 表示无层级；传 'any' 时保留 {z} 占位。
 */
export function layoutTemplate(
  zoom: LayoutZoom,
  format: OutputFormat,
  outLayout?: string | null,
): string {
  const ext = EXT_BY_FORMAT[format];
  const tpl = outLayout ? normalizeOutLayout(outLayout) : defaultOutLayout(zoom);
  const zoomToken = zoom === 'any' ? '{z}' : zoom === null ? '' : String(zoom);
  const out = tpl
    .replace(/\{ext\}/gi, ext.replace(/^\./, ''))
    .replace(/\{z\}/gi, zoomToken)
    .split('/')
    .filter(Boolean)
    .join('/');
  return /\.[A-Za-z0-9]+$/.test(out) ? out : `${out}${ext}`;
}

/** 展开输出结构模板（模板需已通过 normalizeOutLayout 校验） */
function applyLayout(
  template: string,
  coord: { x: number; y: number; z: number | null },
  format: OutputFormat,
): string {
  const ext = EXT_BY_FORMAT[format];
  const out = template
    .replace(/\{x\}/gi, String(coord.x))
    .replace(/\{y\}/gi, String(coord.y))
    .replace(/\{z\}/gi, coord.z === null ? '' : String(coord.z))
    .replace(/\{ext\}/gi, ext.replace(/^\./, ''))
    .split('/')
    .filter(Boolean)
    .join('/');
  return /\.[A-Za-z0-9]+$/.test(out) ? out : `${out}${ext}`;
}

/** 把模板展开为某个坐标的输出相对路径（带模板校验） */
export function expandOutLayout(
  template: string,
  coord: { x: number; y: number; z: number | null },
  format: OutputFormat,
): string {
  return applyLayout(normalizeOutLayout(template), coord, format);
}

/** 判断 RGBA 缓冲区是否存在半透明/透明像素 */
function hasTransparency(src: Uint8Array, pixels: number): boolean {
  for (let i = 3; i < pixels * 4; i += 4) {
    if (src[i] !== 255) return true;
  }
  return false;
}

/** 判断 RGBA 缓冲区是否完全透明 */
function isBlank(src: Uint8Array, pixels: number): boolean {
  for (let i = 3; i < pixels * 4; i += 4) {
    if (src[i] !== 0) return false;
  }
  return true;
}

/**
 * 把一张瓦片绘制到画布上（source-over 叠加）。
 * src 为 RGBA 原始像素（channels 固定 4）。
 */
function drawTile(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  offsetX: number,
  offsetY: number,
): void {
  const x0 = Math.max(0, offsetX);
  const y0 = Math.max(0, offsetY);
  const x1 = Math.min(canvasWidth, offsetX + srcWidth);
  const y1 = Math.min(canvasHeight, offsetY + srcHeight);
  if (x1 <= x0 || y1 <= y0) return;

  const opaque = !hasTransparency(src, srcWidth * srcHeight);

  for (let y = y0; y < y1; y++) {
    const srcY = y - offsetY;
    let s = (srcY * srcWidth + (x0 - offsetX)) * 4;
    let d = (y * canvasWidth + x0) * 4;

    if (opaque) {
      // 不透明瓦片（常见于底图 JPEG / 非透明 PNG）：直接覆盖，速度最快
      for (let x = x0; x < x1; x++) {
        canvas[d] = src[s];
        canvas[d + 1] = src[s + 1];
        canvas[d + 2] = src[s + 2];
        canvas[d + 3] = 255;
        s += 4;
        d += 4;
      }
      continue;
    }

    for (let x = x0; x < x1; x++) {
      const sa = src[s + 3] / 255;
      if (sa !== 0) {
        if (sa === 1) {
          canvas[d] = src[s];
          canvas[d + 1] = src[s + 1];
          canvas[d + 2] = src[s + 2];
          canvas[d + 3] = 255;
        } else {
          const da = canvas[d + 3] / 255;
          const keep = da * (1 - sa);
          const outA = sa + keep;
          if (outA <= 0) {
            canvas[d] = 0;
            canvas[d + 1] = 0;
            canvas[d + 2] = 0;
            canvas[d + 3] = 0;
          } else {
            canvas[d] = (src[s] * sa + canvas[d] * keep) / outA + 0.5;
            canvas[d + 1] = (src[s + 1] * sa + canvas[d + 1] * keep) / outA + 0.5;
            canvas[d + 2] = (src[s + 2] * sa + canvas[d + 2] * keep) / outA + 0.5;
            canvas[d + 3] = outA * 255 + 0.5;
          }
        }
      }
      s += 4;
      d += 4;
    }
  }
}

/** 解码一张瓦片为 RGBA 原始像素；尺寸不一致时拉伸到目标尺寸 */
async function decodeTile(
  buffer: Buffer,
  targetWidth: number,
  targetHeight: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  const decoded = await sharp(buffer, { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (decoded.info.width === targetWidth && decoded.info.height === targetHeight) {
    return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
  }

  const resized = await sharp(decoded.data, {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels },
    limitInputPixels: false,
  })
    .resize(targetWidth, targetHeight, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data: resized.data, width: resized.info.width, height: resized.info.height };
}

/** 创建 sharp 编码管线 */
function encode(
  canvas: Uint8Array,
  width: number,
  height: number,
  format: OutputFormat,
  options: Pick<RenderContext, 'quality' | 'pngCompressionLevel' | 'pngColors' | 'background'>,
) {
  const pipeline = sharp(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength), {
    raw: { width, height, channels: 4 },
    limitInputPixels: false,
  });

  if (format === 'jpeg') {
    // JPEG 无 alpha 通道，需要压平到背景色
    return pipeline
      .flatten({ background: options.background })
      .jpeg({ quality: options.quality, mozjpeg: true });
  }
  if (format === 'webp') {
    // 质量 100 走 webp 的无损模式
    return options.quality >= 100
      ? pipeline.webp({ lossless: true, effort: 4 })
      : pipeline.webp({ quality: options.quality });
  }
  // PNG：默认无损压缩；档位启用调色板量化时限制色数以换取更小体积
  return options.pngColors
    ? pipeline.png({
        compressionLevel: options.pngCompressionLevel,
        palette: true,
        colours: options.pngColors,
        effort: 7,
        dither: 1,
      })
    : pipeline.png({ compressionLevel: options.pngCompressionLevel });
}

/** 打开全部输入源并扫描为图层信息 */
export async function inspectTiles(
  inputs: string[],
  options: Pick<MergeTilesOptions, 'pattern' | 'tms' | 'onProgress'> = {},
): Promise<MergePlan> {
  if (!inputs?.length) throw new Error('请至少提供一个图层（文件夹或 zip 文件）');

  const layers: LayerInfo[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const source = await openSource(inputs[i]);
    options.onProgress?.({
      phase: 'scan',
      layerIndex: i,
      layerCount: inputs.length,
      layerLabel: source.label,
      current: i,
      total: inputs.length,
      message: `扫描图层 ${i + 1}/${inputs.length}：${source.label}`,
    });
    layers.push(await scanLayer(source, i, { pattern: options.pattern, tms: options.tms }));
  }

  const plan = buildPlan(layers);
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.path)) {
      plan.warnings.push(`图层「${layer.label}」被重复添加（${layer.path}）`);
    }
    seen.add(layer.path);
  }
  return plan;
}

/** 一个输出格：同一坐标、同一层级上需要叠加的瓦片（按图层顺序，下层在前） */
interface Cell {
  x: number;
  y: number;
  z: number | null;
  tiles: TileRef[];
}

/**
 * 把所有图层的瓦片按坐标分组。
 * - 同一 (x,y) 上层级不同的瓦片会拆成多张输出，避免把不同缩放级别叠在一起；
 * - 没有层级信息的瓦片（二维目录结构）并入该坐标上的层级，参与叠加。
 */
function collectCells(plan: MergePlan): Cell[] {
  interface Group {
    x: number;
    y: number;
    zoomed: Map<number, TileRef[]>;
    flat: TileRef[];
  }

  const groups = new Map<string, Group>();
  for (const layer of plan.layers) {
    // 外层按图层遍历，天然保证同格内下层瓦片排在前面
    for (const ref of layer.tiles) {
      const key = `${ref.coord.x},${ref.coord.y}`;
      let group = groups.get(key);
      if (!group) {
        group = { x: ref.coord.x, y: ref.coord.y, zoomed: new Map(), flat: [] };
        groups.set(key, group);
      }
      if (ref.coord.z === null) {
        group.flat.push(ref);
        continue;
      }
      const list = group.zoomed.get(ref.coord.z);
      if (list) list.push(ref);
      else group.zoomed.set(ref.coord.z, [ref]);
    }
  }

  const cells: Cell[] = [];
  for (const group of groups.values()) {
    const zooms = [...group.zoomed.keys()].sort((a, b) => a - b);
    if (!zooms.length) {
      cells.push({ x: group.x, y: group.y, z: null, tiles: group.flat });
      continue;
    }
    // 无层级信息的瓦片并入最低层级那一格，并按图层顺序重新排序
    const primary = group.zoomed.get(zooms[0])!;
    cells.push({
      x: group.x,
      y: group.y,
      z: zooms[0],
      tiles: [...primary, ...group.flat].sort((a, b) => a.layerIndex - b.layerIndex),
    });
    for (const zoom of zooms.slice(1)) {
      cells.push({ x: group.x, y: group.y, z: zoom, tiles: group.zoomed.get(zoom)! });
    }
  }
  return cells;
}

/** 实际需要输出的瓦片（格）数量：同一坐标上的不同层级会算作多张 */
export function countOutputCells(plan: MergePlan): number {
  return collectCells(plan).length;
}

/** 并发池：按上限并发执行任务 */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

interface RenderContext {
  format: OutputFormat;
  /** 本次输出使用的压缩档位 */
  compression: ResolvedCompression;
  /** 编码用质量百分比（jpeg/webp 生效） */
  quality: number;
  /** png 压缩等级（无损） */
  pngCompressionLevel: number;
  /** png 调色板色数；null 表示不量化 */
  pngColors: number | null;
  background: string;
  backgroundFill: { r: number; g: number; b: number; alpha: number } | null;
  overwrite: boolean;
  keepEmpty: boolean;
  skipped: string[];
}

function createContext(options: MergeTilesOptions, format: OutputFormat): RenderContext {
  const compression = resolveCompression({
    compression: options.compression ?? null,
    quality: options.quality ?? null,
  });
  return {
    format,
    compression,
    quality: compression.quality,
    pngCompressionLevel: compression.pngCompressionLevel,
    // 只有 png 会用到调色板量化
    pngColors: format === 'png' ? compression.pngColors : null,
    background: options.background ?? '#ffffff',
    backgroundFill: options.background ? parseColor(options.background) : null,
    overwrite: options.overwrite !== false,
    keepEmpty: options.keepEmpty === true,
    skipped: [],
  };
}

/** 用背景色填充一整块画布 */
function fillBackground(
  canvas: Uint8Array,
  pixels: number,
  fill: { r: number; g: number; b: number; alpha: number } | null,
): void {
  if (!fill) return;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    canvas[o] = fill.r;
    canvas[o + 1] = fill.g;
    canvas[o + 2] = fill.b;
    canvas[o + 3] = fill.alpha;
  }
}

/** 把一组瓦片叠加到一块新画布上；全部解码失败时返回 null */
async function composeCell(
  cell: Cell,
  width: number,
  height: number,
  context: RenderContext,
): Promise<Uint8Array | null> {
  const canvas = new Uint8Array(width * height * 4);
  fillBackground(canvas, width * height, context.backgroundFill);

  let drew = false;
  for (const ref of cell.tiles) {
    try {
      const buffer = await ref.source.read(ref.relPath);
      const decoded = await decodeTile(buffer, width, height);
      drawTile(canvas, width, height, decoded.data, decoded.width, decoded.height, 0, 0);
      drew = true;
    } catch (error) {
      if (context.skipped.length < 10) {
        context.skipped.push(`${ref.source.label}/${ref.relPath}（${(error as Error).message}）`);
      }
    }
  }
  return drew ? canvas : null;
}

/** 模式一：按坐标目录结构输出合并后的瓦片（如 `3/1/2.png`） */
async function renderTiles(
  plan: MergePlan,
  options: MergeTilesOptions,
  startedAt: number,
): Promise<MergeTilesResult> {
  const format = options.format ?? 'png';
  const ext = EXT_BY_FORMAT[format];
  const { tileWidth, tileHeight } = plan;
  const cells = collectCells(plan);
  const outRoot = path.resolve(options.outputDir);
  await fs.mkdir(outRoot, { recursive: true });

  // 层级信息：只要瓦片里有 z 就保留，不因为个别图层没有 z 而整体丢掉
  const zooms = plan.zooms ?? (plan.z === null ? [] : [plan.z]);
  const hasZoom = zooms.length > 0;
  // 无层级信息的瓦片沿用全局唯一层级，保证输出结构统一
  const soleZoom = zooms.length === 1 ? zooms[0] : null;

  const template = options.outLayout
    ? normalizeOutLayout(options.outLayout)
    : defaultOutLayout(hasZoom ? 'any' : null);
  if (/\{z\}/i.test(template) && !hasZoom) {
    throw new Error(
      '输出结构包含 {z}，但输入图层没有任何层级信息；请改用 --out-layout "{x}/{y}"，或确认瓦片目录结构',
    );
  }
  const hasZoomToken = /\{z\}/i.test(template);

  const context = createContext(options, format);

  const displayCache = new Map<number | null, string>();
  const displayOf = (zoom: number | null): string => {
    const hit = displayCache.get(zoom);
    if (hit !== undefined) return hit;
    const value = layoutTemplate(zoom, format, options.outLayout);
    displayCache.set(zoom, value);
    return value;
  };

  let written = 0;
  let emptySkipped = 0;
  let existingSkipped = 0;
  let bytes = 0;
  let done = 0;
  const usedLayouts = new Set<string>();
  const flatFallback: string[] = [];

  const limit =
    options.concurrency && options.concurrency > 0
      ? options.concurrency
      : Math.min(8, Math.max(1, os.cpus().length));

  await pool(cells, limit, async (cell) => {
    const canvas = await composeCell(cell, tileWidth, tileHeight, context);
    try {
      if (!canvas) return;

      // 合并后完全透明 → 无可见内容，默认不输出
      if (!context.keepEmpty && isBlank(canvas, tileWidth * tileHeight)) {
        emptySkipped += 1;
        return;
      }

      const zoom = cell.z ?? soleZoom;
      let rel: string;
      if (zoom === null && hasZoomToken) {
        // 多个层级共存时个别格缺少层级信息，只能退到 {x}/{y}
        rel = `${cell.x}/${cell.y}${ext}`;
        if (flatFallback.length < 5) flatFallback.push(rel);
      } else {
        rel = applyLayout(template, { x: cell.x, y: cell.y, z: zoom }, format);
      }
      const target = path.join(outRoot, rel);

      if (!context.overwrite) {
        const exists = await fs
          .access(target)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          existingSkipped += 1;
          return;
        }
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      await encode(canvas, tileWidth, tileHeight, format, context).toFile(target);
      const stat = await fs.stat(target);
      bytes += stat.size;
      written += 1;
      usedLayouts.add(displayOf(zoom));
    } finally {
      done += 1;
      if (done % 10 === 0 || done === cells.length) {
        options.onProgress?.({
          phase: 'merge',
          layerIndex: plan.layers.length - 1,
          layerCount: plan.layers.length,
          layerLabel: '输出瓦片',
          current: done,
          total: cells.length,
          message: `合并输出瓦片 ${done}/${cells.length}`,
        });
      }
    }
  });

  const layout =
    usedLayouts.size === 0
      ? layoutTemplate(hasZoom && zooms.length > 1 ? 'any' : plan.z, format, options.outLayout)
      : usedLayouts.size === 1
        ? [...usedLayouts][0]
        : `混合（${[...usedLayouts].sort().join('、')}）`;

  const warnings = [...plan.warnings];
  if (context.skipped.length) {
    warnings.push(`部分瓦片解码失败已跳过：${context.skipped.join('；')}`);
  }
  if (flatFallback.length) {
    warnings.push(
      `存在多个层级时，部分瓦片缺少层级信息，已按 {x}/{y} 输出：` +
        `${flatFallback.join('、')}${flatFallback.length >= 5 ? ' 等' : ''}`,
    );
  }
  if (existingSkipped > 0) {
    warnings.push(`输出目录中已存在 ${existingSkipped} 个同名瓦片，按 --no-overwrite 跳过未覆盖`);
  }
  if (emptySkipped > 0) {
    warnings.push(`${emptySkipped} 个瓦片合并后完全透明，未输出（如需保留请加 --keep-empty）`);
  }
  if (plan.holes > 0) {
    warnings.push(`${plan.holes} 个网格位置没有任何图层覆盖，未生成瓦片`);
  }

  return {
    mode: 'tiles',
    outputDir: outRoot,
    format,
    width: tileWidth,
    height: tileHeight,
    cols: plan.cols,
    rows: plan.rows,
    layout,
    tileCount: written,
    emptySkipped,
    bytes,
    compression: {
      id: context.compression.id,
      label: context.compression.label,
      quality: context.compression.quality,
      pngColors: context.pngColors,
    },
    layerCount: plan.layers.length,
    holes: plan.holes,
    zooms,
    z: plan.z,
    durationMs: Date.now() - startedAt,
    layers: plan.layers.map((layer) => ({
      label: layer.label,
      path: layer.path,
      kind: layer.kind,
      tiles: layer.tiles.length,
      z: layer.z,
    })),
    warnings,
  };
}

/** 模式二：输出一整张合并后的完整图片 */
async function renderSingle(
  plan: MergePlan,
  options: MergeTilesOptions,
  startedAt: number,
): Promise<MergeTilesResult> {
  const rawName = (options.outputName ?? 'merged.png').trim();
  const safeName = path.basename(rawName);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error(`非法的输出文件名：${rawName}`);
  }
  const { name, format } = resolveFormat(safeName, options.format);
  const outRoot = path.resolve(options.outputDir);
  const outPath = path.join(outRoot, name);
  const { width, height, tileWidth, tileHeight, minX, minY } = plan;

  if (options.overwrite === false) {
    const exists = await fs
      .access(outPath)
      .then(() => true)
      .catch(() => false);
    if (exists) throw new Error(`输出文件已存在：${outPath}（如需覆盖请移除 --no-overwrite）`);
  }

  const context = createContext({ ...options, overwrite: true, keepEmpty: true }, format);
  const canvas = new Uint8Array(width * height * 4);
  fillBackground(canvas, width * height, context.backgroundFill);

  let drawn = 0;
  const total = plan.totalTiles;

  for (const layer of plan.layers) {
    options.onProgress?.({
      phase: 'merge',
      layerIndex: layer.index,
      layerCount: plan.layers.length,
      layerLabel: layer.label,
      current: drawn,
      total,
      message: `叠加图层 ${layer.index + 1}/${plan.layers.length}：${layer.label}`,
    });

    for (const ref of layer.tiles) {
      try {
        const buffer = await ref.source.read(ref.relPath);
        const decoded = await decodeTile(buffer, tileWidth, tileHeight);
        drawTile(
          canvas,
          width,
          height,
          decoded.data,
          decoded.width,
          decoded.height,
          (ref.coord.x - minX) * tileWidth,
          (ref.coord.y - minY) * tileHeight,
        );
      } catch (error) {
        if (context.skipped.length < 10) {
          context.skipped.push(`${ref.source.label}/${ref.relPath}（${(error as Error).message}）`);
        }
      }
      drawn += 1;
      if (drawn % 25 === 0 || drawn === total) {
        options.onProgress?.({
          phase: 'merge',
          layerIndex: layer.index,
          layerCount: plan.layers.length,
          layerLabel: layer.label,
          current: drawn,
          total,
          message: `叠加图层 ${layer.index + 1}/${plan.layers.length}：${layer.label}`,
        });
      }
    }
  }

  await fs.mkdir(outRoot, { recursive: true });

  options.onProgress?.({
    phase: 'encode',
    layerIndex: plan.layers.length - 1,
    layerCount: plan.layers.length,
    layerLabel: '输出',
    current: 0,
    total: 1,
    message: `编码输出 ${width}×${height} ${format.toUpperCase()}`,
  });

  await encode(canvas, width, height, format, context).toFile(outPath);

  const stat = await fs.stat(outPath);
  const warnings = [...plan.warnings];
  if (context.skipped.length) {
    warnings.push(`部分瓦片解码失败已跳过：${context.skipped.join('；')}`);
  }
  if (plan.holes > 0) {
    warnings.push(`网格中有 ${plan.holes} 个位置无任何图层覆盖（保留为透明/背景色）`);
  }

  return {
    mode: 'single',
    outputPath: outPath,
    outputDir: outRoot,
    format,
    width,
    height,
    cols: plan.cols,
    rows: plan.rows,
    layout: '{x}/{y}',
    tileCount: 1,
    emptySkipped: 0,
    bytes: stat.size,
    compression: {
      id: context.compression.id,
      label: context.compression.label,
      quality: context.compression.quality,
      pngColors: context.pngColors,
    },
    layerCount: plan.layers.length,
    holes: plan.holes,
    zooms: plan.zooms ?? (plan.z === null ? [] : [plan.z]),
    z: plan.z,
    durationMs: Date.now() - startedAt,
    layers: plan.layers.map((layer) => ({
      label: layer.label,
      path: layer.path,
      kind: layer.kind,
      tiles: layer.tiles.length,
      z: layer.z,
    })),
    warnings,
  };
}

/** 执行合并并按模式输出 */
export async function mergeTiles(options: MergeTilesOptions): Promise<MergeTilesResult> {
  const mode = options.mode ?? 'tiles';
  if (mode !== 'tiles' && mode !== 'single') {
    throw new Error(`不支持的输出模式：${mode}（可选 tiles / single）`);
  }
  if (!options.outputDir) throw new Error('请指定输出文件夹');
  if (!options.inputs?.length) throw new Error('请至少提供一个图层（文件夹或 zip 文件）');

  const startedAt = Date.now();
  const plan = options.plan ?? (await inspectTiles(options.inputs, options));

  return mode === 'single'
    ? renderSingle(plan, options, startedAt)
    : renderTiles(plan, options, startedAt);
}
