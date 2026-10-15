/**
 * 生成测试用瓦片夹具：node tests/make-fixtures.mjs
 *
 * fixtures/
 *   basic/3/{x}/{y}.png      基本图层（不透明纯色，z/x/y 结构）
 *   label/3/{x}/{y}.png      标注图层（透明底 + 中心红色方块）
 *   basic2d/{x}_{y}.png      基本图层（扁平 x_y 命名）
 *   label2d/{x}_{y}.png      标注图层（扁平 x_y 命名）
 *   basic_tms/3/{x}/{y}.png  基本图层（TMS 坐标系，Y 轴自下而上）
 *   label_tms/3/{x}/{y}.png  标注图层（TMS 坐标系）
 *   sparse/                  稀疏图层（存在空洞）
 *   blank/                   含全透明瓦片（验证透明跳过）
 *   multiz/3、4/0/0.png      多层级（同一坐标两个 z，验证分别输出）
 *   label.zip                标注图层的压缩包
 *   basicjpg/{x}/{y}.jpg     基本图层（JPEG，验证三通道与有损容差）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'fixtures');

export const TILE = 256;
export const GRID = { minX: 0, maxX: 3, minY: 0, maxY: 2, z: 3 };
/** 标注方块位置与尺寸 */
export const MARK = { size: 64, left: 96, top: 96 };

/** 基本图层每个瓦片的纯色（与坐标强相关，便于校验对齐） */
export const baseColor = (x, y) => ({ r: (x + 1) * 40, g: (y + 1) * 50, b: 90, alpha: 255 });

const solidPng = (color) =>
  sharp({ create: { width: TILE, height: TILE, channels: 4, background: color } })
    .png()
    .toBuffer();

const solidJpg = (color) =>
  sharp({ create: { width: TILE, height: TILE, channels: 3, background: color } })
    .jpeg({ quality: 100 })
    .toBuffer();

const labelPng = async () => {
  const square = await sharp({
    create: { width: MARK.size, height: MARK.size, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 255 } },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: TILE, height: TILE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: square, left: MARK.left, top: MARK.top }])
    .png()
    .toBuffer();
};

const write = (relative, buffer) => {
  const target = path.join(fixtures, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
};

/** 已知的夹具子目录，用于无法整体清理时逐个兜底删除 */
const KNOWN_DIRS = [
  'basic',
  'basic2d',
  'basicjpg',
  'basic_tms',
  'label',
  'label2d',
  'label_tms',
  'sparse',
  'blank',
  'multiz',
];

/**
 * 清理上一轮夹具。
 * 某些环境（如带回收站垫片的沙箱）整体递归删除可能失败，
 * 这里降级为逐个删除已知子目录，全部失败也不阻塞后续覆盖写入。
 */
const cleanFixtures = () => {
  try {
    fs.rmSync(fixtures, { recursive: true, force: true });
    return;
  } catch {
    // 降级处理
  }
  for (const name of KNOWN_DIRS) {
    try {
      fs.rmSync(path.join(fixtures, name), { recursive: true, force: true });
    } catch {
      // 覆盖写入即可，忽略
    }
  }
  try {
    fs.rmSync(path.join(fixtures, 'label.zip'), { force: true });
  } catch {
    // 忽略
  }
};

export async function makeFixtures() {
  cleanFixtures();

  for (let x = GRID.minX; x <= GRID.maxX; x++) {
    for (let y = GRID.minY; y <= GRID.maxY; y++) {
      const color = baseColor(x, y);
      const label = await labelPng();
      write(`basic/${GRID.z}/${x}/${y}.png`, await solidPng(color));
      write(`basic2d/${x}_${y}.png`, await solidPng(color));
      write(`basicjpg/${x}/${y}.jpg`, await solidJpg(color));
      write(`label/${GRID.z}/${x}/${y}.png`, label);
      write(`label2d/${x}_${y}.png`, label);
      // TMS：y 轴自下而上，第 y 行对应 TMS 的 (2^z - 1 - y)
      write(`basic_tms/${GRID.z}/${x}/${2 ** GRID.z - 1 - y}.png`, await solidPng(color));
      write(`label_tms/${GRID.z}/${x}/${2 ** GRID.z - 1 - y}.png`, label);
    }
  }

  // 稀疏图层：与 basic 同网格但只放 2 张，用于验证空洞统计
  write('sparse/0/0.png', await solidPng(baseColor(0, 0)));
  write('sparse/1/1.png', await solidPng(baseColor(1, 1)));

  // 含全透明瓦片的图层：0/0 全透明、1/1 不透明，用于验证透明跳过
  write(
    'blank/0/0.png',
    await sharp({ create: { width: TILE, height: TILE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer(),
  );
  write('blank/1/1.png', await solidPng({ r: 10, g: 20, b: 30, alpha: 255 }));

  // 多层级图层：同一坐标 (0,0) 同时存在 z=3 与 z=4，验证按层级分别输出
  write('multiz/3/0/0.png', await solidPng({ r: 210, g: 30, b: 30, alpha: 255 }));
  write('multiz/4/0/0.png', await solidPng({ r: 30, g: 30, b: 210, alpha: 255 }));

  // 标注图层压缩包
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(fixtures, 'label'));
  zip.writeZip(path.join(fixtures, 'label.zip'));

  return fixtures;
}

export const FIXTURES = fixtures;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeFixtures().then((dir) => {
    console.log(`fixtures ready: ${dir}`);
  });
}
