/**
 * 构建脚本：node scripts/build.mjs
 *
 * 单入口 bundle，把 src 下所有模块内联进 dist/index.js，
 * 产物零跨文件相对引用，从根本上避免 ESM 扩展名解析问题。
 * sharp 是含原生二进制的依赖，必须保持 external。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 被内联的 CJS 依赖内部会调用 require() 加载 Node 内置模块，
 * ESM 下没有 require，需要注入 createRequire shim。
 */
const esmRequireBanner = {
  js: `import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);`,
};

const outfile = path.join(root, 'dist', 'index.js');

const run = async () => {
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

  await build({
    entryPoints: [path.join(root, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    banner: esmRequireBanner,
    external: ['sharp'],
    logLevel: 'warning',
  });

  // 校验：产物内不允许出现相对导入（ESM 下会因缺少扩展名而解析失败）
  const content = fs.readFileSync(outfile, 'utf8');
  if (/(?:from\s*|require\()\s*["']\.\//.test(content)) {
    console.error('FAIL: 产物中仍存在相对导入');
    process.exit(1);
  }

  const size = fs.statSync(outfile).size;
  console.log(`build done → dist/index.js (${(size / 1024).toFixed(1)} KB)`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
