/**
 * 公共类型定义
 */

/** 输入源类型：文件夹 / zip 压缩包 */
export type SourceKind = 'dir' | 'zip';

/** 输出图片格式 */
export type OutputFormat = 'png' | 'jpeg' | 'webp';

/**
 * 输出模式：
 * - `tiles`  按坐标目录结构输出合并后的瓦片（默认），如 `3/1/2.png`
 * - `single` 输出一整张合并后的完整图片
 */
export type OutputMode = 'tiles' | 'single';

/** 输出图片的压缩档位信息 */
export interface CompressionInfo {
  /** 档位 id（lossless / high / balanced / small / tiny / custom） */
  id: string;
  /** 档位名称 */
  label: string;
  /** 质量百分比 1-100，100 为无损 */
  quality: number;
  /** PNG 调色板量化色数；null 表示未启用调色板（无损） */
  pngColors: number | null;
}

/** 一个图层输入源（文件夹或 zip 的统一抽象） */
export interface TileSource {
  kind: SourceKind;
  /** 绝对路径 */
  path: string;
  /** 展示名 */
  label: string;
  /** 列出容器内所有文件的相对路径（统一 POSIX 分隔符） */
  list(): Promise<string[]>;
  /** 读取指定相对路径的文件内容 */
  read(relPath: string): Promise<Buffer>;
}

/** 瓦片坐标 */
export interface TileCoord {
  /** 层级，二维瓦片目录中为 null */
  z: number | null;
  x: number;
  y: number;
}

/** 一个待合并的瓦片引用 */
export interface TileRef {
  source: TileSource;
  /** 所属图层序号（从 0 开始，0 在最底层） */
  layerIndex: number;
  /** 在输入源内的相对路径 */
  relPath: string;
  coord: TileCoord;
}

/** 单个图层的扫描结果 */
export interface LayerInfo {
  index: number;
  label: string;
  path: string;
  kind: SourceKind;
  source: TileSource;
  tiles: TileRef[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 该图层统一的层级；混合层级时为 null */
  z: number | null;
  /** 该图层的主导瓦片尺寸 */
  tileWidth: number;
  tileHeight: number;
  /** 无法解析坐标的路径样本 */
  skipped: string[];
}

/** 合并计划 */
export interface MergePlan {
  layers: LayerInfo[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  tileWidth: number;
  tileHeight: number;
  /** 网格列数 */
  cols: number;
  /** 网格行数 */
  rows: number;
  /** 全部格铺满时的完整画布宽（像素） */
  width: number;
  /** 全部格铺满时的完整画布高（像素） */
  height: number;
  /** 各图层瓦片总数 */
  totalTiles: number;
  /** 网格总格数 */
  gridCells: number;
  /** 无任何图层覆盖的格数（空洞） */
  holes: number;
  /** 至少有一张瓦片的格数（即需要合并输出的瓦片数） */
  cells: number;
  /** 计划中出现过的层级集合（升序去重）；全部没有层级信息时为空数组 */
  zooms?: number[];
  /** 唯一层级；无层级信息或存在多个层级时为 null */
  z: number | null;
  warnings: string[];
}

/** 进度事件 */
export interface ProgressEvent {
  phase: 'scan' | 'merge' | 'encode';
  layerIndex: number;
  layerCount: number;
  layerLabel: string;
  current: number;
  total: number;
  message: string;
}

/** 合并结果 */
export interface MergeTilesResult {
  mode: OutputMode;
  /** single 模式：输出图片路径 */
  outputPath?: string;
  /** 输出目录（两种模式都有） */
  outputDir: string;
  format: OutputFormat;
  /** tiles 模式为单个瓦片宽；single 模式为整张图片宽 */
  width: number;
  /** tiles 模式为单个瓦片高；single 模式为整张图片高 */
  height: number;
  /** 网格列数 */
  cols: number;
  /** 网格行数 */
  rows: number;
  /** tiles 模式：输出目录结构模板，如 `3/{x}/{y}.png` */
  layout: string;
  /** 实际写出的瓦片数（single 模式为 1） */
  tileCount: number;
  /** 因完全透明而跳过的瓦片数（tiles 模式） */
  emptySkipped: number;
  /** 写出文件总字节数 */
  bytes: number;
  /** 实际使用的压缩档位 */
  compression: CompressionInfo;
  layerCount: number;
  holes: number;
  /** 结果涉及的层级集合（升序去重）；无层级信息时为空数组 */
  zooms: number[];
  z: number | null;
  durationMs: number;
  layers: Array<{ label: string; path: string; kind: SourceKind; tiles: number; z: number | null }>;
  warnings: string[];
}

/** 合并入参 */
export interface MergeTilesOptions {
  /** 按顺序排列的图层输入路径（第 1 项在最底层） */
  inputs: string[];
  /** 输出文件夹 */
  outputDir: string;
  /** 输出模式，缺省 `tiles` */
  mode?: OutputMode;
  /** 输出文件名（仅 single 模式需要，tiles 模式忽略） */
  outputName?: string;
  /** 输出格式，缺省 png */
  format?: OutputFormat;
  /** 背景色（#RGB / #RRGGBB），缺省透明 */
  background?: string | null;
  /** 自定义路径模板，如 `{z}/{x}/{y}` */
  pattern?: string | null;
  /** 输入为 TMS（Y 轴自下而上），对所有图层统一生效 */
  tms?: boolean;
  /**
   * 压缩档位：内置档位名（lossless / high / balanced / small / tiny）
   * 或 1-100 的百分比。缺省为 high（质量 90）。
   */
  compression?: string | number | null;
  /** jpeg/webp 质量，1-100（等价于 compression 传百分比） */
  quality?: number;
  /** png 压缩等级 0-9（已被压缩档位接管，保留以兼容旧调用） */
  compressionLevel?: number;
  /**
   * 自定义输出目录结构模板（tiles 模式），支持 `{z}` `{x}` `{y}` `{ext}` 占位符。
   * 缺省为 `{z}/{x}/{y}`；输入没有任何层级信息时退化为 `{x}/{y}`。
   */
  outLayout?: string | null;
  /** 是否覆盖已存在的输出文件 */
  overwrite?: boolean;
  /** tiles 模式：结果完全透明时也写出瓦片 */
  keepEmpty?: boolean;
  /** tiles 模式：并发处理瓦片数 */
  concurrency?: number;
  /** 已计算好的合并计划（用于避免重复扫描） */
  plan?: MergePlan;
  onProgress?: (event: ProgressEvent) => void;
}
