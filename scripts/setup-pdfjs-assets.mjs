#!/usr/bin/env node
/**
 * 把 pdf.js 的 CMap 与标准字体复制到 web 的静态目录。
 *
 * 为什么必需：中日韩文字在 PDF 里用**预定义 CMap**（如 Adobe-GB1）编码。
 * pdf.js 不内置这些表，必须通过 `cMapUrl` 指过去；缺了它，中文 PDF 会**整片空白**
 * （字形画不出来，复制也拿不到文字）——这个坑很隐蔽，因为英文 PDF 完全正常。
 * 标准字体同理（`standardFontDataUrl`），影响未内嵌字体的 PDF。
 *
 * 由 package.json 的 postinstall / predev / prebuild 自动调用，产物目录已 gitignore。
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'node_modules/pdfjs-dist');
const target = join(repoRoot, 'apps/web/public/pdfjs');

if (!existsSync(source)) {
  console.log('[setup-pdfjs-assets] 未找到 pdfjs-dist，跳过（先 npm install）');
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const [from, to] of [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
]) {
  const src = join(source, from);
  const dst = join(target, to);
  if (!existsSync(src)) continue;
  cpSync(src, dst, { recursive: true });
}
console.log(`[setup-pdfjs-assets] 已同步 CMap 与标准字体到 ${target}`);
