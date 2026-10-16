/**
 * 端到端验证：node tests/run.mjs
 * 依赖 dist/index.js，请先执行 npm run build
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FIXTURES, GRID, MARK, TILE, baseColor, makeFixtures } from './make-fixtures.mjs';
import { mergeTiles, resolveFormat, layoutTemplate, resolveCompression, pngColorsForQuality } from '../dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'tmp', 'test-output');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

/** 读取图片某个像素 */
async function pixel(file, x, y) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return {
    r: data[offset],
    g: data[offset + 1],
    b: data[offset + 2],
    a: info.channels === 4 ? data[offset + 3] : 255,
  };
}

const near = (actual, expected, tolerance = 0) => Math.abs(actual - expected) <= tolerance;
const tileDir = (dir, z, x) => path.join(dir, String(z), String(x));
const tileFile = (dir, z, x, y, ext = '.png') => path.join(dir, String(z), String(x), `${y}${ext}`);

/** 递归列出目录下所有文件的相对路径 */
function listFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/** 校验一张合并后的瓦片：角点保留基本图层色，中心为标注红色 */
async function assertTile(file, x, y, { hasLabel = true, tolerance = 0 } = {}) {
  const expected = baseColor(x, y);
  const corner = await pixel(file, 8, 8);
  assert.ok(
    near(corner.r, expected.r, tolerance) &&
      near(corner.g, expected.g, tolerance) &&
      near(corner.b, expected.b, tolerance),
    `瓦片(${x},${y}) 角点应为 ${expected.r},${expected.g},${expected.b}，实际 ${corner.r},${corner.g},${corner.b}`,
  );
  if (hasLabel) {
    const center = await pixel(file, MARK.left + MARK.size / 2, MARK.top + MARK.size / 2);
    assert.ok(
      center.r > 240 && center.g < 15 && center.b < 15,
      `瓦片(${x},${y}) 中心应为标注红色，实际 ${center.r},${center.g},${center.b}`,
    );
  }
}

/** 从整图中裁出一块瓦片并返回原始像素 */
async function cropRaw(file, left, top, size = TILE) {
  return sharp(file)
    .extract({ left, top, width: size, height: size })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

async function run() {
  await makeFixtures();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const basic = path.join(FIXTURES, 'basic');
  const label = path.join(FIXTURES, 'label');
  const labelZip = path.join(FIXTURES, 'label.zip');
  const basic2d = path.join(FIXTURES, 'basic2d');
  const basicJpg = path.join(FIXTURES, 'basicjpg');
  const sparse = path.join(FIXTURES, 'sparse');
  const blank = path.join(FIXTURES, 'blank');

  const cols = GRID.maxX - GRID.minX + 1;
  const rows = GRID.maxY - GRID.minY + 1;
  const expectedWidth = cols * TILE;
  const expectedHeight = rows * TILE;

  console.log('\ntile-merger 端到端验证\n');
  console.log('  ── 默认模式：按坐标目录结构输出瓦片 ──');

  let tileResult;
  const tilesOut = path.join(outDir, 'tiles-zyx');
  await test('1) 文件夹 + 文件夹：输出 3/{x}/{y}.png 目录结构', async () => {
    tileResult = await mergeTiles({
      inputs: [basic, label],
      outputDir: tilesOut,
      overwrite: true,
    });

    assert.equal(tileResult.mode, 'tiles');
    assert.equal(tileResult.layout, '3/{x}/{y}.png');
    assert.equal(tileResult.z, GRID.z);
    assert.equal(tileResult.width, TILE);
    assert.equal(tileResult.height, TILE);
    assert.equal(tileResult.cols, cols);
    assert.equal(tileResult.rows, rows);
    assert.equal(tileResult.tileCount, cols * rows, '应输出 12 张合并瓦片');
    assert.equal(tileResult.emptySkipped, 0);
    assert.equal(tileResult.holes, 0);
    assert.ok(tileResult.bytes > 0);

    // 目录结构与文件数
    const files = listFiles(tilesOut);
    assert.equal(files.length, cols * rows, `输出目录应有 ${cols * rows} 个文件，实际 ${files.length}`);
    assert.ok(files.includes('3/0/0.png'), `缺少 3/0/0.png，实际：${files.join(', ')}`);
    assert.ok(files.includes('3/3/2.png'), `缺少 3/3/2.png，实际：${files.join(', ')}`);

    // 逐张校验内容
    for (let x = GRID.minX; x <= GRID.maxX; x++) {
      for (let y = GRID.minY; y <= GRID.maxY; y++) {
        const file = tileFile(tilesOut, GRID.z, x, y);
        assert.ok(fs.existsSync(file), `缺少瓦片 ${file}`);
        const meta = await sharp(file).metadata();
        assert.equal(meta.width, TILE);
        assert.equal(meta.height, TILE);
        await assertTile(file, x, y);
      }
    }
  });

  await test('2) 瓦片模式与单图模式结果完全一致（逐格比对）', async () => {
    const single = await mergeTiles({
      inputs: [basic, label],
      outputDir: outDir,
      mode: 'single',
      outputName: 'reference.png',
      overwrite: true,
    });

    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < rows; row++) {
        const x = GRID.minX + col;
        const y = GRID.minY + row;
        const expected = await cropRaw(single.outputPath, col * TILE, row * TILE);
        const actual = await sharp(tileFile(tilesOut, GRID.z, x, y)).ensureAlpha().raw().toBuffer();
        assert.ok(
          expected.equals(actual),
          `瓦片 (${x},${y}) 与单图裁剪结果不一致`,
        );
      }
    }
  });

  await test('3) zip 压缩包作为输入：输出与文件夹输入逐字节一致', async () => {
    const zipOut = path.join(outDir, 'tiles-zip');
    const result = await mergeTiles({
      inputs: [basic, labelZip],
      outputDir: zipOut,
      overwrite: true,
    });
    assert.equal(result.layers[1].kind, 'zip');
    assert.equal(result.tileCount, cols * rows);

    const a = fs.readdirSync(path.join(zipOut, '3', '0')).sort();
    const b = fs.readdirSync(tileDir(tilesOut, GRID.z, 0)).sort();
    assert.deepEqual(a, b);
    for (const name of a) {
      const left = fs.readFileSync(path.join(zipOut, '3', '0', name));
      const right = fs.readFileSync(path.join(tileDir(tilesOut, GRID.z, 0), name));
      assert.ok(left.equals(right), `${name} 与文件夹输入结果不一致`);
    }
  });

  await test('4) 二维输入（x_y 命名）输出 {x}/{y}.png，取消层级目录', async () => {
    const flatOut = path.join(outDir, 'tiles-xy');
    const result = await mergeTiles({
      inputs: [basic2d, path.join(FIXTURES, 'label2d')],
      outputDir: flatOut,
      overwrite: true,
    });
    assert.equal(result.layout, '{x}/{y}.png');
    assert.equal(result.z, null);
    assert.equal(result.tileCount, cols * rows);

    const files = listFiles(flatOut);
    assert.ok(files.includes('0/0.png'), `应为 x/y.png 结构，实际：${files.join(', ')}`);
    // 二维输入：路径深度固定为 2 段（x/y.png），不应出现层级目录
    assert.ok(
      files.every((f) => /^-?\d+\/-?\d+\.png$/.test(f)),
      `二维输入应为 x/y.png 结构，实际：${files.join(', ')}`,
    );
    await assertTile(path.join(flatOut, String(GRID.minX), `${GRID.minY}.png`), GRID.minX, GRID.minY);
  });

  await test('5) 图层顺序决定遮挡（基本层在上时盖住标注）', async () => {
    const swappedOut = path.join(outDir, 'tiles-swapped');
    await mergeTiles({
      inputs: [label, basic],
      outputDir: swappedOut,
      overwrite: true,
    });
    const expected = baseColor(GRID.minX, GRID.minY);
    const center = await pixel(tileFile(swappedOut, GRID.z, GRID.minX, GRID.minY), MARK.left + MARK.size / 2, MARK.top + MARK.size / 2);
    assert.ok(
      near(center.r, expected.r) && near(center.g, expected.g) && near(center.b, expected.b),
      `基本层在上时应盖住标注，实际 ${center.r},${center.g},${center.b}`,
    );
  });

  await test('6) TMS 坐标系输出与 XYZ 完全一致', async () => {
    const tmsOut = path.join(outDir, 'tiles-tms');
    const result = await mergeTiles({
      inputs: [path.join(FIXTURES, 'basic_tms'), path.join(FIXTURES, 'label_tms')],
      outputDir: tmsOut,
      tms: true,
      overwrite: true,
    });
    assert.equal(result.tileCount, cols * rows);
    const files = listFiles(tmsOut);
    assert.deepEqual(files, listFiles(tilesOut), 'TMS 输出的目录结构应与 XYZ 一致');
    for (const name of files) {
      assert.ok(
        fs.readFileSync(path.join(tmsOut, name)).equals(fs.readFileSync(path.join(tilesOut, name))),
        `${name} 与 XYZ 输出不一致`,
      );
    }
  });

  await test('7) 自定义 pattern（{x}_{y}）解析', async () => {
    const patternOut = path.join(outDir, 'tiles-pattern');
    const result = await mergeTiles({
      inputs: [basic2d, path.join(FIXTURES, 'label2d')],
      outputDir: patternOut,
      pattern: '{x}_{y}',
      overwrite: true,
    });
    assert.equal(result.tileCount, cols * rows);
    await assertTile(path.join(patternOut, '1', '1.png'), 1, 1);
  });

  await test('8) 混合输入（2D 底图 + 3D 标注）保留 z 层级', async () => {
    const jpgOut = path.join(outDir, 'tiles-jpg-base');
    const result = await mergeTiles({
      inputs: [basicJpg, label],
      outputDir: jpgOut,
      overwrite: true,
    });
    assert.equal(result.tileCount, cols * rows);
    // basicjpg 是 x/y 二维结构、label 带 z=3：z 必须保留，不能退化成 {x}/{y}.png
    assert.deepEqual(result.zooms, [GRID.z]);
    assert.equal(result.z, GRID.z);
    assert.equal(result.layout, '3/{x}/{y}.png');
    await assertTile(
      tileFile(jpgOut, GRID.z, GRID.minX, GRID.minY),
      GRID.minX,
      GRID.minY,
      { tolerance: 12 },
    );
  });

  await test('9) JPEG 输出（压平背景，无 alpha）', async () => {
    const jpegOut = path.join(outDir, 'tiles-jpeg-out');
    const result = await mergeTiles({
      inputs: [basic, label],
      outputDir: jpegOut,
      format: 'jpeg',
      overwrite: true,
    });
    assert.equal(result.format, 'jpeg');
    assert.equal(result.layout, '3/{x}/{y}.jpg');
    const file = tileFile(jpegOut, GRID.z, GRID.minX, GRID.minY, '.jpg');
    assert.ok(fs.existsSync(file), `应输出 .jpg 后缀，实际：${listFiles(jpegOut).join(', ')}`);
    const meta = await sharp(file).metadata();
    assert.ok(!meta.hasAlpha, 'JPEG 不应带 alpha 通道');
  });

  await test('10) 完全透明的瓦片被跳过，--keep-empty 可保留', async () => {
    const blankOut = path.join(outDir, 'tiles-blank');
    const result = await mergeTiles({
      inputs: [blank],
      outputDir: blankOut,
      overwrite: true,
    });
    assert.equal(result.tileCount, 1, '只有不透明的那张应被输出');
    assert.equal(result.emptySkipped, 1);
    assert.ok(listFiles(blankOut).includes('1/1.png'));
    assert.ok(!listFiles(blankOut).includes('0/0.png'));
    assert.ok(result.warnings.some((w) => w.includes('完全透明')));

    const keepOut = path.join(outDir, 'tiles-blank-keep');
    const kept = await mergeTiles({
      inputs: [blank],
      outputDir: keepOut,
      keepEmpty: true,
      overwrite: true,
    });
    assert.equal(kept.tileCount, 2);
    assert.equal(kept.emptySkipped, 0);
    assert.deepEqual(listFiles(keepOut), ['0/0.png', '1/1.png']);
  });

  await test('11) 空洞格不输出瓦片并计入提示', async () => {
    const sparseOut = path.join(outDir, 'tiles-sparse');
    const result = await mergeTiles({
      inputs: [sparse],
      outputDir: sparseOut,
      overwrite: true,
    });
    assert.equal(result.cols, 2);
    assert.equal(result.rows, 2);
    assert.equal(result.tileCount, 2);
    assert.equal(result.holes, 2);
    assert.deepEqual(listFiles(sparseOut), ['0/0.png', '1/1.png']);
    assert.ok(result.warnings.some((w) => w.includes('没有任何图层覆盖')));
  });

  await test('12) --no-overwrite 时已存在瓦片跳过不覆盖', async () => {
    const noOverwriteOut = path.join(outDir, 'tiles-no-overwrite');
    await mergeTiles({ inputs: [basic, label], outputDir: noOverwriteOut, overwrite: true });
    const before = fs.readFileSync(tileFile(noOverwriteOut, GRID.z, 0, 0));

    const second = await mergeTiles({
      inputs: [basic, label],
      outputDir: noOverwriteOut,
      overwrite: false,
    });
    assert.equal(second.tileCount, 0, '已存在的瓦片不应被覆盖');
    assert.ok(second.warnings.some((w) => w.includes('已存在')));
    assert.ok(fs.readFileSync(tileFile(noOverwriteOut, GRID.z, 0, 0)).equals(before));
  });

  console.log('\n  ── 单图模式（--single）──');

  let singleResult;
  await test('13) 单图模式输出 1024×768 完整图片', async () => {
    singleResult = await mergeTiles({
      inputs: [basic, label],
      outputDir: outDir,
      mode: 'single',
      outputName: 'merged-dir.png',
      overwrite: true,
    });
    assert.equal(singleResult.mode, 'single');
    assert.equal(singleResult.width, expectedWidth);
    assert.equal(singleResult.height, expectedHeight);
    assert.equal(singleResult.tileCount, 1);
    assert.ok(fs.existsSync(singleResult.outputPath));
  });

  await test('14) 单图模式：无后缀自动补 .png，format 覆盖后缀', async () => {
    const noExt = await mergeTiles({
      inputs: [basic, label],
      outputDir: outDir,
      mode: 'single',
      outputName: 'merged-noext',
      overwrite: true,
    });
    assert.ok(noExt.outputPath.endsWith('merged-noext.png'));

    const webp = await mergeTiles({
      inputs: [basic, label],
      outputDir: outDir,
      mode: 'single',
      outputName: 'merged-x.png',
      format: 'webp',
      overwrite: true,
    });
    assert.equal(webp.format, 'webp');
    assert.ok(webp.outputPath.endsWith('merged-x.webp'));
  });

  console.log('\n  ── 工具函数与错误处理 ──');

  await test('15) layoutTemplate 模板输出正确', async () => {
    assert.equal(layoutTemplate(3, 'png'), '3/{x}/{y}.png');
    assert.equal(layoutTemplate(null, 'png'), '{x}/{y}.png');
    assert.equal(layoutTemplate(5, 'jpeg'), '5/{x}/{y}.jpg');
    assert.equal(layoutTemplate('any', 'png'), '{z}/{x}/{y}.png');
    assert.equal(layoutTemplate(3, 'png', '{x}/{y}/{z}'), '{x}/{y}/3.png');
    assert.equal(layoutTemplate(3, 'png', '{z}/{x}_{y}'), '3/{x}_{y}.png');
    assert.equal(layoutTemplate(3, 'webp', '{z}/{x}/{y}.{ext}'), '3/{x}/{y}.webp');
  });

  await test('16) resolveFormat 后缀推断与纠正', async () => {
    assert.deepEqual(resolveFormat('a.png'), { name: 'a.png', format: 'png' });
    assert.deepEqual(resolveFormat('a.jpg'), { name: 'a.jpg', format: 'jpeg' });
    assert.deepEqual(resolveFormat('a'), { name: 'a.png', format: 'png' });
    assert.deepEqual(resolveFormat('a.png', 'webp'), { name: 'a.webp', format: 'webp' });
    assert.deepEqual(resolveFormat('a.jpg', 'png'), { name: 'a.png', format: 'png' });
  });

  await test('17) 缺少输入 / 输出参数时报错', async () => {
    await assert.rejects(() => mergeTiles({ inputs: [], outputDir: outDir }), /至少提供一个图层/);
    await assert.rejects(() => mergeTiles({ inputs: [basic], outputDir: '' }), /输出文件夹/);
    await assert.rejects(
      () => mergeTiles({ inputs: [path.join(FIXTURES, 'not-exist')], outputDir: outDir }),
      /不存在/,
    );
    await assert.rejects(
      () => mergeTiles({ inputs: [basic], outputDir: outDir, mode: 'xxx' }),
      /不支持/,
    );
  });

  await test('18) tiles 模式无需输出文件名（仅给输出文件夹即可）', async () => {
    const noNameOut = path.join(outDir, 'tiles-no-name');
    const result = await mergeTiles({
      inputs: [basic, label],
      outputDir: noNameOut,
      // 不传 outputName
      overwrite: true,
    });
    assert.equal(result.mode, 'tiles');
    assert.equal(result.tileCount, cols * rows);
    assert.equal(result.outputPath, undefined);
  });

  console.log('\n  ── 层级（z）保留与输出结构自定义 ──');

  await test('19) 同一坐标多层级：按层级分别输出', async () => {
    const multizOut = path.join(outDir, 'tiles-multiz');
    const result = await mergeTiles({
      inputs: [path.join(FIXTURES, 'multiz')],
      outputDir: multizOut,
      overwrite: true,
    });
    assert.deepEqual(result.zooms, [3, 4]);
    assert.equal(result.z, null);
    assert.equal(result.tileCount, 2);
    assert.deepEqual(listFiles(multizOut), ['3/0/0.png', '4/0/0.png']);
    assert.ok(result.layout.includes('混合'), `多层级应提示混合结构，实际 ${result.layout}`);
    const low = await pixel(path.join(multizOut, '3', '0', '0.png'), 10, 10);
    const high = await pixel(path.join(multizOut, '4', '0', '0.png'), 10, 10);
    assert.ok(near(low.r, 210) && near(low.b, 30), 'z=3 的瓦片应保留自己的颜色');
    assert.ok(near(high.b, 210) && near(high.r, 30), 'z=4 的瓦片应保留自己的颜色');
  });

  await test('20) outLayout 自定义为 {x}/{y}/{z}', async () => {
    const customOut = path.join(outDir, 'tiles-custom-layout');
    const result = await mergeTiles({
      inputs: [basic, label],
      outputDir: customOut,
      outLayout: '{x}/{y}/{z}',
      overwrite: true,
    });
    assert.equal(result.layout, '{x}/{y}/3.png');
    const files = listFiles(customOut);
    assert.equal(files.length, cols * rows);
    assert.ok(files.includes('3/2/3.png'), `实际：${files.join(', ')}`);
    assert.ok(files.every((f) => /^-?\d+\/-?\d+\/3\.png$/.test(f)), `实际：${files.join(', ')}`);
    await assertTile(path.join(customOut, '1', '2', '3.png'), 1, 2);
  });

  await test('21) outLayout 显式去掉层级 {x}/{y}', async () => {
    const flatLayoutOut = path.join(outDir, 'tiles-flat-layout');
    const result = await mergeTiles({
      inputs: [basic, label],
      outputDir: flatLayoutOut,
      outLayout: '{x}/{y}',
      overwrite: true,
    });
    assert.equal(result.layout, '{x}/{y}.png');
    const files = listFiles(flatLayoutOut);
    assert.equal(files.length, cols * rows);
    assert.ok(files.includes('3/2.png'), `实际：${files.join(', ')}`);
    await assertTile(path.join(flatLayoutOut, '1', '2.png'), 1, 2);
  });

  await test('22) outLayout 非法模板报错', async () => {
    await assert.rejects(
      () => mergeTiles({ inputs: [basic], outputDir: outDir, outLayout: '{a}/{b}' }),
      /必须包含/,
    );
    await assert.rejects(
      () => mergeTiles({ inputs: [basic], outputDir: outDir, outLayout: '../{x}/{y}' }),
      /不能包含/,
    );
    await assert.rejects(
      () => mergeTiles({ inputs: [basic2d], outputDir: outDir, outLayout: '{z}/{x}/{y}' }),
      /没有任何层级信息/,
    );
  });

  await test('23) outLayout 支持 {ext} 占位并切换输出格式', async () => {
    const extOut = path.join(outDir, 'tiles-ext-layout');
    const result = await mergeTiles({
      inputs: [basic, label],
      outputDir: extOut,
      outLayout: '{z}/{x}/{y}.{ext}',
      format: 'webp',
      overwrite: true,
    });
    assert.equal(result.layout, '3/{x}/{y}.webp');
    assert.ok(listFiles(extOut).includes('3/2/1.webp'), `实际：${listFiles(extOut).join(', ')}`);
  });

  console.log('\n  ── 图片压缩比例 ──');

  await test('24) 压缩档位解析：内置档位 / 百分比 / 默认值', async () => {
    // 默认档位必须与旧版本行为一致（质量 90，PNG 不量化）
    assert.equal(resolveCompression().id, 'high');
    assert.equal(resolveCompression().quality, 90);
    assert.equal(resolveCompression().pngColors, null);
    assert.equal(tileResult.compression.id, 'high');
    assert.equal(tileResult.compression.pngColors, null);

    assert.equal(resolveCompression({ compression: 'lossless' }).quality, 100);
    assert.equal(resolveCompression({ compression: 'tiny' }).quality, 30);
    assert.equal(resolveCompression({ compression: 55 }).quality, 55);
    assert.equal(resolveCompression({ compression: '45' }).quality, 45);
    assert.equal(resolveCompression({ compression: '60%' }).quality, 60);
    assert.equal(resolveCompression({ quality: 75 }).quality, 75);

    // PNG 调色板色数：接近无损不量化，比例越低色数越少
    assert.equal(pngColorsForQuality(100), null);
    assert.equal(pngColorsForQuality(96), null);
    assert.equal(resolveCompression({ compression: 'high' }).pngColors, null);
    const balanced = resolveCompression({ compression: 'balanced' }).pngColors;
    const tiny = resolveCompression({ compression: 'tiny' }).pngColors;
    assert.ok(balanced > 0 && balanced < 256, `均衡档应启用调色板，实际 ${balanced}`);
    assert.ok(tiny < balanced, `极小档色数(${tiny}) 应少于均衡档(${balanced})`);
    assert.throws(() => resolveCompression({ compression: 'ultra' }), /未知的压缩档位/);
  });

  await test('25) PNG 档位越小体积越小，尺寸与内容仍有效', async () => {
    const sizes = {};
    for (const level of ['lossless', 'balanced', 'tiny']) {
      const dir = path.join(outDir, `tiles-compress-${level}`);
      const result = await mergeTiles({
        inputs: [basic, label],
        outputDir: dir,
        compression: level,
        overwrite: true,
      });
      assert.equal(result.tileCount, cols * rows);
      assert.equal(result.compression.id, level);
      sizes[level] = result.bytes;
      const file = tileFile(dir, GRID.z, GRID.minX, GRID.minY);
      const meta = await sharp(file).metadata();
      assert.equal(meta.width, TILE);
      assert.equal(meta.height, TILE);
      await assertTile(file, GRID.minX, GRID.minY, { tolerance: level === 'tiny' ? 40 : 8 });
    }
    assert.ok(sizes.tiny < sizes.lossless, `极小档(${sizes.tiny}) 应小于无损档(${sizes.lossless})`);
    assert.ok(sizes.tiny <= sizes.balanced, `极小档(${sizes.tiny}) 不应大于均衡档(${sizes.balanced})`);
  });

  await test('26) JPEG 输出：低档位体积更小', async () => {
    const highOut = path.join(outDir, 'tiles-jpeg-lossless');
    const lowOut = path.join(outDir, 'tiles-jpeg-tiny');
    const high = await mergeTiles({
      inputs: [basic, label],
      outputDir: highOut,
      format: 'jpeg',
      compression: 'lossless',
      overwrite: true,
    });
    const low = await mergeTiles({
      inputs: [basic, label],
      outputDir: lowOut,
      format: 'jpeg',
      compression: 'tiny',
      overwrite: true,
    });
    assert.equal(high.compression.quality, 100);
    assert.equal(low.compression.quality, 30);
    assert.ok(low.bytes < high.bytes, `极小档(${low.bytes}) 应小于无损档(${high.bytes})`);
    assert.ok(listFiles(lowOut).includes('3/0/0.jpg'), `实际：${listFiles(lowOut).join(', ')}`);
  });

  await test('27) 单图模式同样按档位压缩（webp）', async () => {
    const single = await mergeTiles({
      inputs: [basic, label],
      outputDir: outDir,
      mode: 'single',
      outputName: 'compressed.webp',
      format: 'webp',
      compression: 'balanced',
      overwrite: true,
    });
    assert.equal(single.format, 'webp');
    assert.equal(single.compression.id, 'balanced');
    assert.equal(single.compression.quality, 70);
    // 非 PNG 格式不做调色板量化
    assert.equal(single.compression.pngColors, null);
    assert.ok(single.bytes > 0);
  });

  await test('28) 非法档位报错，越界比例被夹取到 1-100', async () => {
    await assert.rejects(
      () => mergeTiles({ inputs: [basic], outputDir: outDir, compression: 'ultra' }),
      /未知的压缩档位/,
    );
    assert.equal(resolveCompression({ compression: 0 }).quality, 1);
    assert.equal(resolveCompression({ compression: 200 }).quality, 100);
    assert.equal(resolveCompression({ compression: 200 }).pngColors, null);
  });

  console.log(`\n结果：${passed}/${passed + failures.length} 通过\n`);
  if (failures.length) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
