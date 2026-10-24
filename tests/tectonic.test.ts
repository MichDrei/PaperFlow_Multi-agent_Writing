/**
 * Tectonic 编译器测试（本地真引擎）。
 *
 * 这一层专门覆盖"渲染是否正确"——也就是 `MockCompiler` 天生做不到的部分：
 * 作者块、`\thanks` 脚注、三线表、公式环境、中日韩文字。
 * 找不到二进制时整组跳过，保证在没有 TeX 的机器上 `npm test` 仍然全绿。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TectonicCompiler,
  buildCjkPreamble,
  buildFontShim,
  detectMissingFontFamilies,
  injectFontShim,
  isTectonicAvailable,
  parseDiagnostics,
} from '@paperflow/latex/tectonic';

const available = isTectonicAvailable();
const skip = available ? false : '本地没有 Tectonic 二进制（.tectonic/bin/tectonic），跳过真引擎测试';

test('诊断解析：带行号的 error/warning 要能被结构化提取', () => {
  const output = [
    'note: downloading foo.tfm',
    'error: main.tex:11: Undefined control sequence',
    'warning: main.tex:27: Overfull \\hbox (5.9pt too wide) in paragraph at lines 14--27',
    'error: halted on potentially-recoverable error as specified',
  ].join('\n');

  const diagnostics = parseDiagnostics(output);
  assert.equal(diagnostics.length, 2, '应提取 2 条（halted 那行不算独立错误）');
  assert.deepEqual(diagnostics[0], {
    level: 'error',
    file: 'main.tex',
    line: 11,
    message: 'Undefined control sequence',
  });
  assert.equal(diagnostics[1]!.level, 'warning');
  assert.equal(diagnostics[1]!.line, 27);
});

test('英文论文：作者块 / thanks 脚注 / 三线表 / 公式都要真的排进 PDF', { skip }, async () => {
  const compiler = new TectonicCompiler();
  const output = await compiler.compile({
    fileId: 'main',
    engine: 'xelatex',
    content: [
      '\\documentclass[11pt]{article}',
      '\\usepackage{booktabs}',
      '\\usepackage{amsmath,amssymb}',
      '\\title{Speculative Decoding with Adaptive Draft Lengths}',
      '\\author{Wei Zhang\\thanks{Corresponding author.} \\and Priya Raman}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{Experiments}',
      '\\begin{table}[h]\\centering',
      '\\begin{tabular}{lcc}\\toprule',
      'Method & ROUGE-L & Speedup \\\\',
      '\\midrule',
      'ASD (ours) & 42.9 & 2.4x \\\\',
      '\\bottomrule\\end{tabular}',
      '\\caption{Main results.}',
      '\\end{table}',
      '\\section*{Acknowledgements}',
      'Supported by grant No.~2024-1234.',
      '\\end{document}',
    ].join('\n'),
  });

  assert.equal(output.ok, true, `编译失败：${output.log.slice(-500)}`);
  assert.ok(output.pdfBytes && output.pdfBytes.byteLength > 5000, '应产出真实 PDF');
  assert.equal(Buffer.from(output.pdfBytes!.subarray(0, 5)).toString('latin1'), '%PDF-');
  // 关键：真实 TeX 会给出 Overfull 之类的排版警告，说明它真的在排版而不是剥文本
  assert.ok(
    output.pdfBytes!.byteLength > 8000,
    '真引擎的 PDF 应包含内嵌字体，明显大于 MockCompiler 的精简输出',
  );
});

test('中文论文：自动补最小中文支持后中文必须能排版（XeTeX 一个引擎搞定中英）', { skip }, async () => {
  const compiler = new TectonicCompiler();
  const output = await compiler.compile({
    fileId: 'main',
    engine: 'auto',
    content: [
      '\\documentclass[11pt]{article}',
      '\\title{投机解码的自适应草稿长度研究}',
      '\\author{张伟\\thanks{通讯作者。} \\and 李娜}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{方法}',
      '本文提出自适应投机解码。',
      '\\section*{致谢}',
      '本工作受国家自然科学基金 No.~2024-1234 资助。',
      '\\end{document}',
    ].join('\n'),
  });

  assert.equal(output.ok, true, `中文编译失败：${output.log.slice(-500)}`);
  assert.ok(output.pdfBytes && output.pdfBytes.byteLength > 5000);
  // 自动补的 ctex 必须写在日志里，不能偷偷改用户的文档
  assert.match(output.log, /xeCJK|CJK/, '应说明自动加入了 CJK 支持');
});

test('显式选择 pdfLaTeX 时：明确拒绝并给出替代方案（而不是静默用错引擎）', { skip }, async () => {
  const compiler = new TectonicCompiler();
  const output = await compiler.compile({
    fileId: 'main',
    engine: 'pdflatex',
    content: '\\documentclass{article}\\begin{document}hi\\end{document}',
  });

  assert.equal(output.ok, false);
  const message = output.diagnostics.map((d) => d.message).join(' ');
  assert.match(message, /XeLaTeX/);
  assert.match(message, /LATEX_COMPILER_URL/, '要告诉用户怎么才能用上 pdfLaTeX');
});

test('字体回退检测：从编译日志里找出"在 XeTeX 下不存在而静默回退"的字体族', () => {
  const log = [
    'LaTeX Font Info:    Trying to load font information for TU+ptm on input line 79',
    'LaTeX Font Info:    No file TUptm.fd. on input line 794.',
    "LaTeX Font Warning: Font shape `TU/ptm/m/n' undefined",
    "LaTeX Font Warning: Font shape `TU/ptm/bx/n' undefined",
    "LaTeX Font Warning: Font shape `TU/phv/m/n' undefined",
    "LaTeX Font Warning: Font shape `TU/unknownfamily/m/n' undefined",
  ].join('\n');

  const families = detectMissingFontFamilies(log);
  assert.deepEqual(families.sort(), ['phv', 'ptm'], '应识别出 ptm/phv，忽略没有对应替代的字体族');
  assert.deepEqual(detectMissingFontFamilies('nothing wrong here'), []);
});

test('字体兼容层：把 Times(ptm) 映射到度量兼容的 TeX Gyre Termes', () => {
  const shim = buildFontShim(['ptm']);
  assert.match(shim, /\\usepackage\{fontspec\}/);
  assert.match(shim, /\\setmainfont\{texgyretermes-regular\.otf\}/);
  assert.match(shim, /BoldFont=texgyretermes-bold\.otf/);
  // 度量兼容是关键：TeX Gyre Termes 与 Times 的行宽一致，页数才不会变
  assert.match(shim, /度量兼容/);

  // 必须插在 \begin{document} 之前，否则 fontspec 的设置在文档开始后才生效
  const injected = injectFontShim('\\documentclass{article}\n\\begin{document}\nhi\n\\end{document}', shim);
  assert.ok(injected.indexOf('fontspec') < injected.indexOf('\\begin{document}'));
});

test('中文支持必须用 xeCJK 而不是 ctex（ctex 会让英文论文多 3 页）', () => {
  const preamble = buildCjkPreamble();
  assert.match(preamble, /\\usepackage\{xeCJK\}/);
  assert.ok(
    !/\\usepackage(\[[^\]]*\])?\{ctex\}/.test(preamble),
    'ctex 会全局改变行距与缩进：受控实测 8 页 → 11 页。只有 xeCJK 才是布局中性的',
  );
  assert.match(preamble, /FandolSong-Regular\.otf/, '中文字体要用 Tectonic 自带的 Fandol');
});

test('端到端：请求 Times 的老式类文件应被自动修复（否则页数会变）', { skip }, async () => {
  const compiler = new TectonicCompiler();
  const output = await compiler.compile({
    fileId: 'main',
    engine: 'auto',
    content: [
      '\\documentclass[10pt]{article}',
      // 模拟 ieeeconf/IEEEtran 的写法：直接改 \rmdefault 指定 Times
      '\\renewcommand{\\rmdefault}{ptm}',
      '\\begin{document}',
      '\\normalfont Times-metric text. The quick brown fox jumps over the lazy dog.',
      '\\end{document}',
    ].join('\n'),
  });

  assert.equal(output.ok, true, `编译失败：${output.log.slice(-400)}`);
  assert.match(output.log, /TeX Gyre/, '应报告已换用度量兼容字体');
  assert.match(output.log, /ptm/, '应指出是哪个字体族出了问题');
});
