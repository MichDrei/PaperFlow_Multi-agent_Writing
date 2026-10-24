/**
 * 编辑器悬浮预览的目标识别与 BibTeX 解析。
 *
 * 这两块是纯逻辑，最值得用测试钉住：识别错了会悬浮出不相干的内容，
 * 而 bib 解析错（大括号嵌套）会显示半个标题。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectBlockAt,
  detectHoverTarget,
  parseBibEntries,
  renderMath,
  renderTableLatex,
  resolveLabels,
  sanitizeForKatex,
} from '../apps/web/src/features/editor/latexHover.js';

test('目标识别：引用 / 图片 / 公式 / 符号，各按光标位置判定', () => {
  const cite = 'see \\cite{kang2026kinematic} for details';
  assert.equal(detectHoverTarget(cite, 10)?.kind, 'cite');
  assert.equal(detectHoverTarget(cite, 10)?.value, 'kang2026kinematic');

  const image = '\\includegraphics[width=\\linewidth]{figures/pipeline.png}';
  assert.equal(detectHoverTarget(image, 30)?.kind, 'image');
  assert.equal(detectHoverTarget(image, 30)?.value, 'figures/pipeline.png');

  // \(...\) 这种写法必须支持：模型生成的 LaTeX 里大量使用
  const inline = 'the score \\(S \\geq 0.07\\) holds';
  // 光标落在公式里的普通字符上（不是命令上）→ 预览整条公式
  assert.equal(detectHoverTarget(inline, 13)?.kind, 'math');
  assert.equal(detectHoverTarget(inline, 13)?.value, 'S \\geq 0.07');
  // 落在命令上 → 只预览那个符号（两者都要能用）
  assert.equal(detectHoverTarget(inline, 17)?.kind, 'symbol');
  assert.equal(detectHoverTarget(inline, 17)?.value, '\\geq');

  const display = '\\[ x = y + 1 \\]';
  assert.equal(detectHoverTarget(display, 8)?.kind, 'math');
  assert.equal(detectHoverTarget(display, 8)?.display, true, '展示公式应标记 display');

  // 含命令的公式里，光标落在命令上 → 符号；落在普通字符上 → 整条公式
  const withCmd = '\\[ \\mathbb{E}[A \\mid K] \\]';
  const cmdStart = withCmd.indexOf('\\mathbb');
  assert.equal(detectHoverTarget(withCmd, cmdStart + 3)?.kind, 'symbol', '落在 \\mathbb 上应预览该符号');
  assert.equal(detectHoverTarget(withCmd, cmdStart - 2)?.kind, 'math', '落在公式其它位置应预览整条公式');

  // 光标正落在符号命令上 → 只预览这个符号（含上下标）
  const symbol = 'a small thumb inclination (\\(\\alpha_T \\lesssim 10^{\\circ}\\))';
  const atSymbol = detectHoverTarget(symbol, symbol.indexOf('\\alpha_T') + 3);
  assert.equal(atSymbol?.kind, 'symbol');
  assert.equal(atSymbol?.value, '\\alpha_T');

  // 无关文字不应命中，避免"到处都弹悬浮"
  assert.equal(detectHoverTarget('just some plain text here', 8), undefined);
});

test('BibTeX 解析：标题里的嵌套大括号不能截断', () => {
  const bib = `@article{lin2025,
  title = {A review of {IEEE} dexterous hands with {\\emph{soft}} fingers},
  author = {Lin, Yu-Ying and Raj, Ritik},
  journal = {Biomimetics},
  year = {2025}
}
@inproceedings{barrau2021,
  title = "Invariant Extended Kalman Filtering",
  author = {Barrau, A.},
  booktitle = {CDC},
  year = {2021}
}`;
  const entries = parseBibEntries(bib);
  assert.equal(entries.length, 2);

  const first = entries[0]!;
  assert.equal(first.key, 'lin2025');
  // 嵌套大括号里的内容要完整保留（老实现会在第一个 } 处截断）
  assert.match(first.title!, /IEEE/);
  assert.match(first.title!, /soft/);
  assert.equal(first.year, '2025');
  assert.equal(first.venue, 'Biomimetics');

  const second = entries[1]!;
  assert.equal(second.title, 'Invariant Extended Kalman Filtering', '双引号写法也要支持');
  assert.equal(second.venue, 'CDC');
});

test('公式渲染：成功时同时给出 HTML 与纯文本，失败时返回 undefined 由调用方兜底', () => {
  const ok = renderMath('\\alpha_T', false);
  assert.ok(ok, '常见符号应能渲染');
  assert.match(ok!.html, /katex/, '应产出 KaTeX 结构');
  // 纯文本兜底是必须的：Monaco 的悬浮会过滤 HTML，没有它悬浮框就是空的
  assert.equal(ok!.text, 'αT');

  assert.equal(renderMath('\\notacommand{x}', false), undefined, '无法渲染时应返回 undefined');
});

test('跨行公式/表格识别：必须能找回外层环境（这里踩过正则过度转义的坑）', () => {
  const doc = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\begin{equation}',
    '  \\frac{1}{|\\mathcal{O}|} \\sum_{o \\in \\mathcal{O}} r_t(o)',
    '  \\label{eq:score}',
    '\\end{equation}',
    '\\begin{table}',
    '\\caption{Hyperparameters}',
    '\\begin{tabular}{lcc}',
    '\\toprule',
    'Name & A & B \\\\',
    '\\midrule',
    'lr & 1e-4 & 64 \\\\',
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
    '\\end{document}',
  ];
  const getLine = (n: number) => doc[n - 1] ?? '';

  // 光标在公式中间（第 4 行）
  const equation = detectBlockAt(getLine, doc.length, 4);
  assert.ok(equation, '应识别出外层 equation 环境');
  assert.equal(equation!.kind, 'math-block');
  assert.equal(equation!.environment, 'equation');
  assert.equal(equation!.startLine, 3);
  assert.equal(equation!.endLine, 6);
  assert.match(equation!.content, /\\frac/);

  // 光标在表格行（第 13 行）
  const table = detectBlockAt(getLine, doc.length, 13);
  assert.ok(table, '应识别出外层 tabular 环境');
  assert.equal(table!.kind, 'table');
  assert.equal(table!.environment, 'tabular');

  // 光标在环境之外：不应误报
  assert.equal(detectBlockAt(getLine, doc.length, 2), undefined, '正文里不该识别出块');

  // 已经闭合的环境不能被当成外层（早先的实现会返回上面那个 equation）
  const afterEquation = detectBlockAt(getLine, doc.length, 12);
  assert.equal(afterEquation?.environment, 'tabular', '第 12 行在 tabular 里，而不是已闭合的 equation');
});

test('表格渲染：三线表要变成真正的行列，而不是一堆源码', () => {
  const body = [
    '\\toprule',
    'Method & ROUGE-L & Speedup \\\\',
    '\\midrule',
    'Baseline & 41.2 & 1.0\\times \\\\',
    'ASD (ours) & 42.9 & 2.4\\times \\\\',
    '\\bottomrule',
  ].join('\n');
  const html = renderTableLatex(body);
  assert.ok(html, '应渲染出表格');
  assert.match(html!, /<table/);
  assert.equal((html!.match(/<tr/g) ?? []).length, 6, '3 行数据 + 3 条横线');
  assert.match(html!, /Baseline/);
  assert.match(html!, /42\.9/);
  assert.match(html!, /pf-tbl-mid/, '\\midrule 应变成中间横线');
});

test('渲染前的清理：\\label 这类 KaTeX 不认的命令必须去掉', () => {
  // equation 环境几乎总带 \label，留着会让 KaTeX 直接报错、整条公式渲染失败
  assert.equal(sanitizeForKatex('x = 1 \\label{eq:a}'), 'x = 1');
  assert.equal(sanitizeForKatex('y = 2 \\nonumber'), 'y = 2');
  const rendered = renderMath('\\frac{1}{2} \\label{eq:x}', true);
  assert.ok(rendered, '带 \\label 的公式清理后应能渲染');
  assert.match(rendered!.html, /mfrac/);
});

test('符号要带上参数与上下标，否则渲染出来是错的', () => {
  const line = 'where \\bar{a}_t^{\\,k} and \\mathbf{d} and \\alpha_T matter';

  // `\bar{a}_t^{\,k}`：参数与上下标都要带上
  const bar = detectHoverTarget(line, line.indexOf('\\bar') + 2);
  assert.equal(bar?.kind, 'symbol');
  assert.equal(bar?.value, '\\bar{a}_t^{\\,k}', '参数与上下标不能丢');
  assert.equal(bar?.hasArgument, true, '带参数时不该再补占位符（否则渲染成 F̄）');

  // `\mathbf{d}`：丢掉 {d} 会渲染成 "F"
  const bold = detectHoverTarget(line, line.indexOf('\\mathbf') + 3);
  assert.equal(bold?.value, '\\mathbf{d}');
  assert.equal(bold?.hasArgument, true);

  // `\alpha_T`：没有参数，只有下标
  const alpha = detectHoverTarget(line, line.indexOf('\\alpha') + 2);
  assert.equal(alpha?.value, '\\alpha_T');
  assert.equal(alpha?.hasArgument, false, '没参数时允许补占位符');
});

test('标签解析：\\ref 指向的小节/图/表要能认出来（而不是去 .bib 里找）', () => {
  const doc = [
    '\\section{INTRODUCTION}',
    '\\label{sec:intro}',
    'text \\ref{sec:intro} here',
    '\\section{EVALUATION}',
    '\\label{sec:eval}',
    '\\begin{figure}',
    '\\includegraphics{figures/a.png}',
    '\\caption{Object set used in this study}',
    '\\label{fig:objects}',
    '\\end{figure}',
    '\\begin{table}',
    '\\caption{Hyperparameters}',
    '\\begin{tabular}{lc}',
    'a & b \\\\',
    '\\end{tabular}',
    '\\label{tab:hp}',
    '\\end{table}',
  ];
  const getLine = (n: number) => doc[n - 1] ?? '';
  const labels = resolveLabels(getLine, doc.length);

  assert.equal(labels.get('sec:intro')?.kind, 'section');
  assert.equal(labels.get('sec:intro')?.title, 'INTRODUCTION');
  assert.equal(labels.get('sec:intro')?.line, 2);

  assert.equal(labels.get('sec:eval')?.kind, 'section');
  assert.equal(labels.get('fig:objects')?.kind, 'figure');
  assert.equal(labels.get('fig:objects')?.title, 'Object set used in this study', '图标签要带题注');

  assert.equal(labels.get('tab:hp')?.kind, 'table');
  assert.equal(labels.get('tab:hp')?.title, 'Hyperparameters');
});

test('表格单元格：公式要渲染成 KaTeX，符号命令要变成 Unicode', () => {
  const body = [
    '\\toprule',
    'Quantity & Value & Trend \\\\',
    '\\midrule',
    'Contact $\\rho_s$ (rad/s) & $0.88 \\pm 0.02$ & $\\uparrow$ \\\\',
    'R\\&D budget & 12\\% & $\\downarrow$ \\\\',
    '\\bottomrule',
  ].join('\n');
  const html = renderTableLatex(body)!;
  assert.ok(html, '应渲染出表格');
  // 单元格里的 $...$ 必须走 KaTeX，而不是被当普通文字剥掉
  assert.match(html, /class="katex"/, '单元格公式应渲染成 KaTeX');
  // 表格里的 & 必须转义，否则会破坏 HTML 结构
  assert.match(html, /&amp;/, '单元格里的 & 要转义');
  assert.ok(!/\\[a-zA-Z]+/.test(html.replace(/<[^>]*>/g, '')), '渲染后的文字里不该残留反斜杠命令');
});
