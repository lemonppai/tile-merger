import { toPosix } from './source';
import type { TileCoord } from './types';

/** 支持的瓦片图片后缀 */
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?|gif)$/i;

/** 判定是否为瓦片图片文件 */
export const isImageFile = (p: string): boolean => IMAGE_EXT.test(p);

/**
 * 将用户模板编译为正则。
 * 支持 `{z}` / `{x}` / `{y}` 占位符，例如：
 *   `{z}/{x}/{y}`、`{x}_{y}`、`{z}-{x}-{y}`、`tile/{x}/{y}`
 */
export function compilePattern(pattern: string): RegExp {
  const parts = pattern.split(/(\{[zxy]\})/);
  const source = parts
    .map((part) => {
      const holder = /^\{([zxy])\}$/.exec(part);
      if (holder) return `(?<${holder[1]}>-?\\d+)`;
      // 分隔符原样保留，其余字符转义；`/` 与 `\` 互为等价
      const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return escaped.replace(/\//g, '[/\\\\]');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** 取数组中从末尾开始的连续数字项 */
function tailNumeric(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^-?\d+$/.test(tokens[i])) out.unshift(tokens[i]);
    else break;
  }
  return out;
}

/**
 * 从相对路径中提取尾部的连续数字段。
 * 例：
 *   `3/1/2.png`        -> [3, 1, 2]
 *   `base/3/1/2.png`   -> [3, 1, 2]
 *   `1/2.png`          -> [1, 2]
 *   `x1y2/1/2.png`     -> [1, 2]（遇到非纯数字目录即停止）
 *   `tile_1_2.png`     -> [1, 2]
 */
function trailingNumbers(relPath: string): number[] {
  const parts = toPosix(relPath).split('/');
  const file = parts.pop() ?? '';
  const base = file.replace(/\.[^.]+$/, '');

  let tail = tailNumeric(base.split(/[_.]/).filter(Boolean));
  if (tail.length < 2) {
    // 兼容 `3-1-2` 这类连字符命名
    const alt = tailNumeric(base.split(/[_.\-]/).filter(Boolean));
    if (alt.length > tail.length) tail = alt;
  }

  const seq = [...parts, ...tail];
  const numbers: number[] = [];
  for (let i = seq.length - 1; i >= 0; i--) {
    if (/^-?\d+$/.test(seq[i])) numbers.unshift(Number(seq[i]));
    else break;
  }
  return numbers;
}

/** 单层瓦片的最大合理层级（用于区分「层级」与「恰好是数字的目录名」） */
const MAX_ZOOM = 30;

/**
 * 解析瓦片相对路径为坐标。
 * 自动识别三种常见组织方式：
 *   z/x/y、x/y、x_y（以及 z_x_y 等扁平命名，含连字符变体）
 * 返回 null 表示无法解析。
 */
export function parseTilePath(relPath: string, pattern?: RegExp | null): TileCoord | null {
  const posix = toPosix(relPath);
  const noExt = posix.replace(/\.[^.\\/]+$/, '');

  if (pattern) {
    const matched = pattern.exec(noExt);
    if (!matched || !matched.groups) return null;
    const { z, x, y } = matched.groups as { z?: string; x?: string; y?: string };
    if (x === undefined || y === undefined) return null;
    return {
      z: z === undefined ? null : Number(z),
      x: Number(x),
      y: Number(y),
    };
  }

  const numbers = trailingNumbers(posix);
  if (numbers.length >= 3) {
    const [z, x, y] = numbers.slice(-3);
    // 只有取值范围合理时才认作层级，否则退化成二维坐标
    if (z >= 0 && z <= MAX_ZOOM) return { z, x, y };
    const [, x2, y2] = numbers.slice(-2);
    return { z: null, x: x2, y: y2 };
  }
  if (numbers.length === 2) {
    return { z: null, x: numbers[0], y: numbers[1] };
  }
  return null;
}
