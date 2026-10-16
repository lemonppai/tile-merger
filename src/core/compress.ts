/**
 * 输出图片的压缩档位
 *
 * 语义：
 * - jpg / webp 为有损格式，`quality` 直接决定画质与体积；
 * - png 为无损格式，默认只调整压缩等级（不影响画质）；仅当档位显式启用
 *   调色板量化（pngColors）时，才会以「限制色数」的方式换取更小体积。
 */
import type { CompressionInfo } from './types';

export type CompressionId = 'lossless' | 'high' | 'balanced' | 'small' | 'tiny';

export interface CompressionPreset {
  id: CompressionId;
  label: string;
  /** 选项说明（展示在交互菜单里） */
  hint: string;
  /** 质量百分比 1-100，100 为无损 */
  quality: number;
  /** png 压缩等级 0-9（无损，仅影响体积与耗时） */
  pngCompressionLevel: number;
  /** png 调色板量化色数；null 表示不做量化 */
  pngColors: number | null;
}

/** 内置压缩档位（从高画质到小体积） */
export const COMPRESSION_PRESETS: CompressionPreset[] = [
  {
    id: 'lossless',
    label: '无损原图',
    hint: '画质与原图一致，体积最大',
    quality: 100,
    pngCompressionLevel: 9,
    pngColors: null,
  },
  {
    id: 'high',
    label: '高质量',
    hint: '肉眼几乎无差异，推荐',
    quality: 90,
    pngCompressionLevel: 6,
    pngColors: null,
  },
  {
    id: 'balanced',
    label: '均衡压缩',
    hint: '体积明显变小，细节略有损失',
    quality: 70,
    pngCompressionLevel: 9,
    pngColors: 128,
  },
  {
    id: 'small',
    label: '小体积',
    hint: '体积更小，渐变处可能出现色带',
    quality: 50,
    pngCompressionLevel: 9,
    pngColors: 64,
  },
  {
    id: 'tiny',
    label: '极小体积',
    hint: '体积最小，画质损失明显',
    quality: 30,
    pngCompressionLevel: 9,
    pngColors: 32,
  },
];

export const DEFAULT_COMPRESSION_ID: CompressionId = 'high';

export interface ResolvedCompression extends CompressionInfo {
  /** png 压缩等级 0-9 */
  pngCompressionLevel: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * 由质量百分比换算 PNG 调色板色数。
 * 比例越低调色板越小；接近无损（≥95%）时不量化，返回 null。
 */
export function pngColorsForQuality(quality: number): number | null {
  const q = clamp(Math.round(quality), 1, 100);
  if (q >= 95) return null;
  const raw = 256 * (q / 100) ** 2;
  const stepped = 2 ** Math.round(Math.log2(Math.max(8, raw)));
  return clamp(stepped, 8, 256);
}

/** 按内置档位 id 查找 */
export function findPreset(id: string): CompressionPreset | undefined {
  const key = id.trim().toLowerCase();
  return COMPRESSION_PRESETS.find((preset) => preset.id === key);
}

/** 由自定义质量百分比构造档位 */
export function compressionFromQuality(quality: number): ResolvedCompression {
  if (!Number.isFinite(quality)) {
    throw new Error(`压缩比例必须是 1-100 的数字，收到：${quality}`);
  }
  const q = clamp(Math.round(quality), 1, 100);
  return {
    id: 'custom',
    label: q >= 100 ? '无损原图' : `自定义 ${q}%`,
    quality: q,
    pngCompressionLevel: 9,
    pngColors: pngColorsForQuality(q),
  };
}

/** 把内置档位展开为可用的压缩参数 */
function fromPreset(preset: CompressionPreset): ResolvedCompression {
  return {
    id: preset.id,
    label: preset.label,
    quality: preset.quality,
    pngCompressionLevel: preset.pngCompressionLevel,
    pngColors: preset.pngColors,
  };
}

/**
 * 解析压缩参数：支持内置档位名（lossless/high/balanced/small/tiny）、
 * 1-100 的百分比（字符串或数字），以及历史参数 quality。
 * 全部缺省时为「高质量」（与旧版本默认行为一致）。
 */
export function resolveCompression(input?: {
  compression?: string | number | null;
  quality?: number | null;
}): ResolvedCompression {
  const raw = input?.compression;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw === 'number') return compressionFromQuality(raw);
    const preset = findPreset(raw);
    if (preset) return fromPreset(preset);
    const numeric = Number(String(raw).replace(/%$/, '').trim());
    if (Number.isFinite(numeric)) return compressionFromQuality(numeric);
    const ids = COMPRESSION_PRESETS.map((preset) => preset.id).join(' / ');
    throw new Error(`未知的压缩档位：${raw}（可选 ${ids}，或 1-100 的百分比）`);
  }
  if (input?.quality !== undefined && input.quality !== null) {
    return compressionFromQuality(input.quality);
  }
  return fromPreset(COMPRESSION_PRESETS.find((p) => p.id === DEFAULT_COMPRESSION_ID)!);
}

/** 一行话描述某档位在指定格式下的实际效果 */
export function describeCompression(
  compression: { id: string; label: string; quality: number; pngColors: number | null },
  format: string,
): string {
  const base =
    compression.id === 'custom'
      ? compression.label
      : `${compression.label}（质量 ${compression.quality}%）`;
  if (format !== 'png') return base;
  return compression.pngColors
    ? `${base} · 调色板量化 ${compression.pngColors} 色`
    : `${base} · 不做色数压缩`;
}

/** 传给 mergeTiles 的压缩参数（自定义档位传百分比字符串） */
export function compressionArg(compression: ResolvedCompression): string {
  return compression.id === 'custom' ? String(compression.quality) : compression.id;
}
