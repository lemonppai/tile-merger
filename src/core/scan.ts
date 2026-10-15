import sharp from 'sharp';
import { compilePattern, isImageFile, parseTilePath } from './pattern';
import type { LayerInfo, TileCoord, TileRef, TileSource } from './types';

export interface ScanOptions {
  /** 自定义路径模板 */
  pattern?: string | null;
  /** 输入为 TMS 坐标系（Y 轴自下而上） */
  tms?: boolean;
}

/** 探测瓦片尺寸时的采样上限 */
const SIZE_SAMPLE = 24;
/** 保留的无法解析路径样本上限 */
const SKIP_SAMPLE = 5;

/** 从采样瓦片中找出主导尺寸 */
async function detectTileSize(tiles: TileRef[]): Promise<{ width: number; height: number }> {
  const step = Math.max(1, Math.floor(tiles.length / SIZE_SAMPLE));
  const counter = new Map<string, { width: number; height: number; count: number }>();

  for (let i = 0; i < tiles.length && counter.size < SIZE_SAMPLE + 1; i += step) {
    const tile = tiles[i];
    try {
      const buffer = await tile.source.read(tile.relPath);
      const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
      if (!meta.width || !meta.height) continue;
      const key = `${meta.width}x${meta.height}`;
      const hit = counter.get(key);
      if (hit) hit.count += 1;
      else counter.set(key, { width: meta.width, height: meta.height, count: 1 });
    } catch {
      // 单张瓦片损坏不影响整体扫描
    }
  }

  let best: { width: number; height: number; count: number } | null = null;
  for (const item of counter.values()) {
    if (!best || item.count > best.count) best = item;
  }
  if (!best) throw new Error('无法读取任何瓦片尺寸，请确认图层目录内是有效的图片文件');
  return { width: best.width, height: best.height };
}

/** 扫描单个图层，解析出全部瓦片及其坐标 */
export async function scanLayer(
  source: TileSource,
  index: number,
  options: ScanOptions = {},
): Promise<LayerInfo> {
  const pattern = options.pattern ? compilePattern(options.pattern) : null;
  const files = await source.list();
  const images = files.filter(isImageFile);

  if (!images.length) {
    const sample = files.slice(0, 5).join('、') || '（空目录）';
    throw new Error(
      `图层「${source.label}」中未找到瓦片图片（支持 png/jpg/jpeg/webp/avif/bmp/tif/gif）。` +
        `目录内容示例：${sample}`,
    );
  }

  const tiles: TileRef[] = [];
  const skipped: string[] = [];
  const zoomLevels = new Set<number>();
  let hasNullZoom = false;

  for (const relPath of images) {
    const coord = parseTilePath(relPath, pattern);
    if (!coord) {
      if (skipped.length < SKIP_SAMPLE) skipped.push(relPath);
      continue;
    }
    if (coord.z === null) hasNullZoom = true;
    else zoomLevels.add(coord.z);
    tiles.push({ source, layerIndex: index, relPath, coord });
  }

  if (!tiles.length) {
    throw new Error(
      `图层「${source.label}」中的 ${images.length} 个图片文件都无法解析出坐标。` +
        `请确认目录结构形如 z/x/y.png 或 x/y.png，或使用 --pattern 指定模板。` +
        `示例：${images.slice(0, 3).join('、')}`,
    );
  }

  // TMS：Y 轴自下而上，转为自顶向下的 XYZ
  if (options.tms) {
    const zoom = zoomLevels.size === 1 && !hasNullZoom ? [...zoomLevels][0] : null;
    if (zoom !== null) {
      const span = 2 ** zoom - 1;
      for (const tile of tiles) tile.coord.y = span - tile.coord.y;
    } else {
      const ys = tiles.map((t) => t.coord.y);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      for (const tile of tiles) tile.coord.y = minY + maxY - tile.coord.y;
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    const { x, y }: TileCoord = tile.coord;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const { width: tileWidth, height: tileHeight } = await detectTileSize(tiles);
  const z = zoomLevels.size === 1 && !hasNullZoom ? [...zoomLevels][0] : null;

  return {
    index,
    label: source.label,
    path: source.path,
    kind: source.kind,
    source,
    tiles,
    minX,
    maxX,
    minY,
    maxY,
    z,
    tileWidth,
    tileHeight,
    skipped,
  };
}
