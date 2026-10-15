# tile-merger

一款**瓦片图层合并工具**：把「基本图层」与「标注图层」按瓦片坐标对齐叠加，输出**合并后的瓦片目录**（也可以选择输出一整张合并图片）。

提供 **CLI 命令** 与 **Node.js API**，支持文件夹与 zip 压缩包两种图层来源，多层按选择顺序从下往上叠加。

---

## 特性

- 🗂️ 图层来源支持**文件夹**和 **.zip 压缩包**，可按顺序叠加任意多层
- 🖥️ Windows / macOS / Linux 弹出**原生系统选择对话框**选目录、选压缩包（zip 可多选）
- 🗺️ **默认输出瓦片目录**：按坐标逐格合并，输出如 `3/1/2.png`（`{z}/{x}/{y}.png`）的完整目录结构，无需输入文件名
- 🧱 **层级（z）不丢失**：只要有一个图层带层级信息就保留 z 目录；全部图层都没有层级信息时才退化为 `{x}/{y}.png`
- 🛠️ 输出结构可用 `--out-layout` 自定义，如 `{x}/{y}/{z}`、`{z}/{x}_{y}`、`{z}/{x}/{y}.{ext}`
- 🖼️ 也可用 `--single` 输出一整张合并后的完整图片
- 🧭 自动识别常见瓦片目录结构：`z/x/y`、`x/y`、`x_y`、`z_x_y` 等，也可用 `--pattern` 自定义模板
- 🎯 全局网格对齐：所有图层共用同一套坐标基准，无覆盖的位置不生成瓦片
- 🧹 完全透明的瓦片默认跳过（`--keep-empty` 可保留），`--no-overwrite` 保护已有瓦片
- ⚡ 逐格合成 + 并发写盘，内存占用恒定（单瓦片级别），不透明瓦片走快速通道
- 📊 合并前预览网格范围与输出结构，合并后报告瓦片数量、大小与耗时

---

## 安装

```bash
npm install -g tile-merger
# 或在项目内使用
npx tile-merger
```

> 需要 Node.js ≥ 18.17。`sharp` 会自动安装对应平台的预编译二进制。

---

## 使用

### 1️⃣ 交互式引导（推荐）

直接运行：

```bash
tile-merger
```

然后按提示操作：

```
① 选择图层来源    → 系统对话框选文件夹 / 选 zip，可多次添加、调整顺序、移除
② 选择输出文件夹  → 系统对话框选目录
③ 确认合并计划    → 网格范围、输出结构、瓦片数量
```

输出瓦片目录时**不需要输入文件名**，直接选好输出文件夹即可。

**图层顺序很重要**：先选择的是最底层（基本图层），后选择的依次覆盖在上面（标注图层）。
添加完成后可在菜单里「调整图层叠加顺序」或「移除图层」。

### 2️⃣ 命令行参数（适合脚本）

```bash
# 输出合并后的瓦片目录：out/3/1/2.png、out/3/1/3.png ...
tile-merger -i ./tiles/base -i ./tiles/label -o ./output --yes
```

```bash
# 多个输入用逗号分隔，顺序即叠加顺序
tile-merger -i ./base,./label.zip -o ./out --yes
```

```bash
# 需要一整张合并图片时加 --single
tile-merger -i ./base -i ./label -o ./out --single -n merged.png --yes
```

### 3️⃣ Node.js API

```js
import { mergeTiles } from 'tile-merger';

// 默认：输出合并后的瓦片目录
const result = await mergeTiles({
  inputs: ['./tiles/base', './tiles/label.zip'], // 第 1 项在最底层
  outputDir: './output',
});

console.log(result.outputDir, result.layout, result.tileCount);

// 可选：输出一整张合并图片
await mergeTiles({
  inputs: ['./tiles/base', './tiles/label.zip'],
  outputDir: './output',
  mode: 'single',
  outputName: 'merged.png',
});
```

---

## 输出目录结构

默认模式（`tiles`）按坐标逐格合并，**输出结构与输入保持一致**：

| 输入结构 | 输出结构 | 示例 |
| -------- | -------- | ---- |
| `z/x/y.png` | `{z}/{x}/{y}.png` | `3/1/2.png` |
| 部分图层无层级（如 2D 底图 + 3D 标注） | `{z}/{x}/{y}.png`（沿用有层级的那个 z） | `3/1/2.png` |
| 全部图层都无层级（`x/y.png` / `x_y.png`） | `{x}/{y}.png` | `1/2.png` |

层级不会因为个别图层缺失而整体丢掉：只要有一个图层带层级信息就会保留 z 目录。
如果同一坐标存在**多个层级**，各层级会分别输出到自己的 z 目录（如 `3/1/2.png` 与 `4/1/2.png`），不会叠加到一起。

需要别的结构时用 `--out-layout` 自定义（支持 `{z}` `{x}` `{y}` `{ext}` 占位符）：

```bash
tile-merger -i ./base -i ./label -o ./out --out-layout "{x}/{y}/{z}" --yes   # 1/2/3.png
tile-merger -i ./base -i ./label -o ./out --out-layout "{z}/{x}_{y}" --yes   # 3/1_2.png
tile-merger -i ./base -i ./label -o ./out --out-layout "{x}/{y}" --yes       # 去掉层级：1/2.png
```

```
output/
└── 3/
    ├── 0/
    │   ├── 0.png
    │   ├── 1.png
    │   └── 2.png
    ├── 1/
    │   ├── 0.png
    │   └── ...
    └── 3/
        └── ...
```

每一张输出瓦片，就是所有图层在该坐标位置的叠加结果。

- 没有任何图层覆盖的格子**不生成瓦片**（结果中会提示数量）
- 合并后完全透明的瓦片默认跳过，`--keep-empty` 可强制保留
- `--no-overwrite` 时不覆盖输出目录里已存在的同名瓦片，跳过并在结果中提示

---

## 参数说明

| 参数 | 说明 | 默认值 |
| ---- | ---- | ------ |
| `-i, --input <路径>` | 图层文件夹或 `.zip`，可重复出现；**顺序即叠加顺序，第 1 项在最底层** | — |
| `-o, --output <目录>` | 输出文件夹（不存在会自动创建） | — |
| `--single` | 改为输出一整张合并图片，而不是瓦片目录 | 关闭 |
| `-n, --name <文件名>` | 输出文件名，**仅 `--single` 模式需要** | `merged.png` |
| `-f, --format <格式>` | 输出格式 `png` / `jpg` / `webp` | `png`（single 模式按后缀推断） |
| `-b, --background <色值>` | 背景色，如 `#ffffff`、`#f00` | 透明（JPEG 为白色） |
| `--pattern <模板>` | 自定义坐标模板，支持 `{z}` `{x}` `{y}` 占位符 | 自动识别 |
| `--out-layout <模板>` | 自定义输出目录结构，支持 `{z}` `{x}` `{y}` `{ext}` 占位符 | `{z}/{x}/{y}`（无层级时 `{x}/{y}`） |
| `--tms` | 输入为 TMS 坐标系（Y 轴自下而上），对所有图层统一生效 | 关闭 |
| `--quality <1-100>` | jpg / webp 质量 | 90 |
| `-c, --concurrency <n>` | tiles 模式并发数 | `min(8, CPU 核数)` |
| `--keep-empty` | 完全透明的瓦片也写出 | 关闭 |
| `--no-overwrite` | 已存在的瓦片/文件不覆盖 | 关闭（默认覆盖） |
| `-y, --yes` | 跳过所有交互（需同时提供 `-i` `-o`） | — |
| `--no-dialog` | 不使用系统文件对话框，改用内置终端文件浏览器 | — |
| `-d, --debug` | 输出调试信息 | — |
| `-h, --help` | 查看帮助 | — |
| `-v, --version` | 查看版本 | — |

---

## 瓦片目录识别

自动识别以下常见组织方式（也支持 `_` 换成 `-`、`.png/.jpg/.webp` 等常见图片后缀）：

```
z/x/y.png            3/1/2.png
z_x_y.png            3_1_2.png
x/y.png              1/2.png
x_y.png              1_2.png
任意前缀/3/1/2.png    tiles/3/1/2.png
任意前缀_1_2.png      tile_1_2.png
```

无法识别时用 `--pattern` 指定模板（相对路径去掉后缀后匹配）：

```bash
tile-merger -i ./base --pattern "{z}/{x}/{y}" -o ./out --yes
tile-merger -i ./base --pattern "tile_{x}_{y}" -o ./out --yes
```

---

## 合并逻辑

1. 逐个扫描图层，解析每张瓦片的 `(x, y)` 坐标
2. 汇总所有图层求出**全局网格范围**（`minX,maxX × minY,maxY`）
3. 按坐标 `(x, y)` 把各图层瓦片分组（同一坐标上的不同层级会拆成多张输出），每格得到一个按图层顺序排列的列表（下层在前）
4. 逐格建一块 `瓦片宽 × 瓦片高` 的 RGBA 画布，把该格所有图层瓦片依次绘制上去：
   不透明瓦片直接覆盖；带透明的瓦片按 **source-over** 公式与下方像素混合
5. 编码为 `png` / `jpg` / `webp`，写入 `输出目录/{z}/{x}/{y}.png`（结构可用 `--out-layout` 调整，逐格并发处理）

```
坐标 (1, 2) 这一格：
┌─────────────────────────────┐
│  标注图层 3/1/2.png（带透明） │  ← 第 2 项及以后
├─────────────────────────────┤
│  基本图层 3/1/2.png          │  ← 第 1 项
└─────────────────────────────┘
        ↓ source-over 叠加
     输出 out/3/1/2.png
```

---

## 编译与测试

```bash
npm install          # 安装依赖
npm run build        # esbuild 打包到 dist/index.js
npm run typecheck    # TypeScript 类型检查
npm run fixtures     # 生成测试瓦片夹具
npm test             # 端到端验证（23 项断言）
npm start            # 直接运行 CLI
```

---

## 已知限制

- `--tms` 与 `--pattern` 对所有图层统一生效，不支持逐图层混合坐标系
- 同一坐标上存在多个层级（z）时，会分别输出到各自的 z 目录，不会叠加成一张
- 输出瓦片尺寸取自所有图层中出现最多的瓦片尺寸，尺寸不一致的瓦片会被拉伸对齐
- zip 读取基于 `adm-zip`，会把压缩包整体载入内存，超大压缩包（>1GB）不建议直接使用

---

功能持续完善中，欢迎提交 Issue 或 PR 来改进这个工具！
