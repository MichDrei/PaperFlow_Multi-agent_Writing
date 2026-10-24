/**
 * 行尾（CRLF / LF）鲁棒性测试。
 *
 * 背景：这个项目主要在 WSL2 里跑，但源码可能被 Windows 侧的编辑器或 git 的
 * autocrlf 变成 CRLF。JS 正则里**不带 m 标志的 `$` 只匹配输入末尾**，而且 `.`
 * 不匹配 `\r`——所以 `/% .*$/` 这类"剥离 LaTeX 注释"的写法遇到 CRLF 会静默失效。
 *
 * 这个文件把该场景钉死：任何人再写出依赖 `$` 锚定行尾的正则，都会在这里被拦住。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeEol } from '@paperflow/core';
import { MockCompiler, lintLatex } from '@paperflow/latex';
import { parseBibtex } from '@paperflow/context';
import { DEMO_DOCUMENT } from '@paperflow/context';

const toCrlf = (text: string) => text.replace(/\n/g, '\r\n');

test('normalizeEol：CRLF 与孤立 CR 都归一为 LF', () => {
  assert.equal(normalizeEol('a\r\nb'), 'a\nb');
  assert.equal(normalizeEol('a\rb'), 'a\nb');
  assert.equal(normalizeEol('a\nb'), 'a\nb');
  assert.equal(normalizeEol('a\r\nb\r\nc'), 'a\nb\nc');
});

test('注释里的花括号在 CRLF 源码下不应被误判为未闭合（回归）', () => {
  const source = [
    '\\documentclass{article}',
    '\\begin{document}',
    '% 下面这个 { 在注释里，不该被计入括号配对',
    'ok',
    '\\end{document}',
  ];

  // 先确认 LF 版本是干净的（说明测试本身没问题）
  const lfDiags = lintLatex(source.join('\n'));
  assert.equal(lfDiags.filter((d) => d.level === 'error').length, 0, 'LF 版本不应报错');

  // CRLF 版本必须得到同样的结论——这里曾经报出假的 "Unbalanced braces"
  const crlfDiags = lintLatex(toCrlf(source.join('\n')));
  assert.equal(
    crlfDiags.filter((d) => d.level === 'error').length,
    0,
    `CRLF 版本误报：${crlfDiags.map((d) => d.message).join('; ')}`,
  );
});

test('MockCompiler：CRLF 与 LF 源码产出等价的编译结果', async () => {
  const compiler = new MockCompiler({ fileName: 'main.tex' });
  const lf = DEMO_DOCUMENT.files['file-main']!.content;

  const [lfOut, crlfOut] = await Promise.all([
    compiler.compile({ fileId: 'file-main', content: lf }),
    compiler.compile({ fileId: 'file-main', content: toCrlf(lf) }),
  ]);

  assert.equal(crlfOut.ok, lfOut.ok);
  assert.deepEqual(
    crlfOut.anchors.map((a) => a.line),
    lfOut.anchors.map((a) => a.line),
    '源码行锚点必须一致，否则"改动后跳到 PDF 对应页"会错位',
  );
  assert.equal(crlfOut.diagnostics.length, lfOut.diagnostics.length);
  assert.equal(crlfOut.pdfBytes?.byteLength, lfOut.pdfBytes?.byteLength);
});

test('BibTeX 解析：CRLF 的 .bib 不应丢字段', () => {
  const lf = DEMO_DOCUMENT.files['file-bib']!.content;
  const lfEntries = parseBibtex(lf);
  const crlfEntries = parseBibtex(toCrlf(lf));

  assert.equal(crlfEntries.length, lfEntries.length);
  // 逐字段比对：CRLF 曾导致 title/author 被截断
  for (const [i, entry] of lfEntries.entries()) {
    const crlfEntry = crlfEntries[i]!;
    assert.equal(crlfEntry.key, entry.key);
    assert.equal(crlfEntry.year, entry.year);
    assert.equal(crlfEntry.title, entry.title, `${entry.key} 的 title 被破坏`);
    assert.deepEqual(crlfEntry.authors, entry.authors, `${entry.key} 的 author 被破坏`);
  }
});
