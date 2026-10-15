import type { LayerInfo, MergePlan } from './types';

/** 从多个图层中挑出出现次数最多的瓦片尺寸 */
function dominantSize(layers: LayerInfo[]): { width: number; height: number } {
  const counter = new Map<string, { width: number; height: number; count: number }>();
  for (const layer of layers) {
    const key = `${layer.tileWidth}x${layer.tileHeight}`;
    const hit = counter.get(key);
    if (hit) hit.count += layer.tiles.length;
    else counter.set(key, { width: layer.tileWidth, height: layer.tileHeight, count: layer.tiles.length });
  }
  let best = { width: 0, height: 0, count: -1 };
  for (const item of counter.values()) {
    if (item.count > best.count) best = item;
  }
  return { width: best.width, height: best.height };
}

/**
 * 依据各图层瓦片的坐标范围，计算全局网格与输出画布尺寸。
 * 所有图层共用同一套坐标基准，按坐标对齐叠加。
 */
export function buildPlan(layers: LayerInfo[]): MergePlan {
  if (!layers.length) throw new Error('至少需要一个图层才能合并');

  const warnings: string[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let totalTiles = 0;

  for (const layer of layers) {
    minX = Math.min(minX, layer.minX);
    maxX = Math.max(maxX, layer.maxX);
    minY = Math.min(minY, layer.minY);
    maxY = Math.max(maxY, layer.maxY);
    totalTiles += layer.tiles.length;
  }

  const { width: tileWidth, height: tileHeight } = dominantSize(layers);

  for (const layer of layers) {
    if (layer.tileWidth !== tileWidth || layer.tileHeight !== tileHeight) {
      warnings.push(
        `图层「${layer.label}」瓦片尺寸 ${layer.tileWidth}×${layer.tileHeight} ` +
          `与主导尺寸 ${tileWidth}×${tileHeight} 不一致，合并时会拉伸对齐`,
      );
    }
  }

  // 层级（z）：只要瓦片里有层级信息就保留，避免因为个别图层没有层级而整体丢掉 z
  const zoomSet = new Set<number>();
  let hasFlatTiles = false;
  for (const layer of layers) {
    for (const tile of layer.tiles) {
      if (tile.coord.z === null) hasFlatTiles = true;
      else zoomSet.add(tile.coord.z);
    }
  }
  const zooms = [...zoomSet].sort((a, b) => a - b);
  const z = zooms.length === 1 ? zooms[0] : null;

  if (zooms.length > 1) {
    warnings.push(
      `瓦片层级（z = ${zooms.join('、')}）不一致，同一坐标的不同层级会分别输出到各自的 z 目录`,
    );
  }
  if (hasFlatTiles && zooms.length) {
    warnings.push('部分图层没有层级信息（z），已并入同坐标的层级目录一起输出');
  }

  const cols = maxX - minX + 1;
  const rows = maxY - minY + 1;
  const gridCells = cols * rows;

  // 统计有瓦片的格数与空洞
  const covered = new Set<string>();
  for (const layer of layers) {
    for (const tile of layer.tiles) {
      covered.add(`${tile.coord.x},${tile.coord.y}`);
    }
  }
  const cells = covered.size;
  const holes = gridCells - cells;

  const width = cols * tileWidth;
  const height = rows * tileHeight;

  if (minX < 0 || minY < 0) {
    warnings.push('坐标范围内存在负值（如 TMS 或自定义原点），已按最小值归一化处理');
  }

  return {
    layers,
    minX,
    maxX,
    minY,
    maxY,
    tileWidth,
    tileHeight,
    cols,
    rows,
    width,
    height,
    totalTiles,
    gridCells,
    holes,
    cells,
    zooms,
    z,
    warnings,
  };
}

/** 估算合并所需的内存（字节），用于提前给出风险提示 */
export const estimateMemory = (plan: MergePlan): number => plan.width * plan.height * 4;
