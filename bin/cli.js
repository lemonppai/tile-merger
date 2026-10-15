#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cfonts from 'cfonts';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error('未找到构建产物 dist/index.js，请先在包目录执行 `npm run build`。');
  process.exit(1);
}

cfonts.say('Tile Merger', {
  font: 'simple',
  colors: ['#00C2A8'],
  space: false,
});

// Windows 下动态 import 必须使用 file:// URL
const { generate } = await import(pathToFileURL(entry).href);

try {
  await generate(process.argv.slice(2));
} catch (error) {
  const name = error?.name;
  if (name === 'ExitPromptError' || name === 'AbortPromptError') {
    console.log('\n已取消操作');
    process.exit(0);
  }
  console.error(`发生错误：${error?.message ?? error}`);
  process.exit(1);
}
