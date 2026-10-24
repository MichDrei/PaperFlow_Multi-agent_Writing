/**
 * 核心算法单测。
 *
 * 覆盖"如果错了会静默毁掉用户论文"的那部分逻辑：diff 构建与应用、@提及路由、
 * 模型输出解析、术语一致性、以及编译器是否真的产出了 PDF。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  positionAtOffset,
  findTextInSource,
  lineAtOffset,
  applyHunks,
  buildHunks,
  summarizeHunks,
  resolveMentions,
  segmentInstruction,
  activeMentionQuery,
  stripMentions,
  DEFAULT_MODEL_CATALOG,
  tighten,
  rewrapParagraphs,
} from '@paperflow/core';
import { auditCitations, checkTerminology, parseBibtex, retrieve } from '@paperflow/context';
import { MockCompiler } from '@paperflow/latex';
import { parseProposal, planTurn, trimHistory } from '@paperflow/agents';
import { DEMO_CONTEXT, DEMO_DOCUMENT } from '@paperflow/context';

test('buildHunks：内容相同 → 不产生任何 hunk', () => {
  assert.equal(buildHunks('a\nb\nc', 'a\nb\nc').length, 0);
});

test('buildHunks + applyHunks：接受全部 hunk 得到新内容', () => {
  const before = 'one\ntwo\nthree\nfour';
  const after = 'one\nTWO\nthree\nfour';
  const hunks = buildHunks(before, after);
  assert.equal(hunks.length, 1);
  const applied = applyHunks(before, hunks, hunks.map((h) => h.id));
  assert.equal(applied, after);
});

test('applyHunks：拒绝全部 hunk 时保持原文不变', () => {
  const before = 'alpha\nbeta\ngamma';
  const after = 'alpha\nBETA\ngamma';
  const hunks = buildHunks(before, after);
  assert.equal(applyHunks(before, hunks, []), before);
});

test('applyHunks：多个 hunk 可部分接受（互不干扰）', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
  const lines = before.split('\n');
  lines[2] = 'CHANGED-3';
  lines[30] = 'CHANGED-31';
  const after = lines.join('\n');

  const hunks = buildHunks(before, after);
  assert.equal(hunks.length, 2);

  const partial = applyHunks(before, hunks, [hunks[0]!.id]);
  const result = partial.split('\n');
  assert.equal(result[2], 'CHANGED-3');
  assert.equal(result[30], 'line-31');
  assert.equal(partial.split('\n').length, before.split('\n').length);
});

test('applyHunks：替换行数变化时行数正确（增行/删行）', () => {
  const before = 'a\nb\nc\nd';
  const after = 'a\nb1\nb2\nb3\nc\nd';
  const hunks = buildHunks(before, after);
  const applied = applyHunks(before, hunks, hunks.map((h) => h.id));
  assert.equal(applied, after);
  assert.deepEqual(summarizeHunks(hunks), { added: 3, removed: 1 });
});

test('resolveMentions：识别具体模型、@all 广播与未知提及', () => {
  const room = ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro'];

  const one = resolveMentions('@claude 帮我压缩这段', DEFAULT_MODEL_CATALOG, room);
  assert.deepEqual(one.targets, ['claude-sonnet-4']);
  assert.equal(one.instruction, '帮我压缩这段');

  const two = resolveMentions('@gpt @gemini 看看', DEFAULT_MODEL_CATALOG, room);
  assert.deepEqual(two.targets, ['gpt-4o', 'gemini-2.5-pro']);

  const all = resolveMentions('@all 全体评审', DEFAULT_MODEL_CATALOG, room);
  assert.equal(all.broadcast, true);
  assert.deepEqual(all.targets, room);

  const none = resolveMentions('没有提及任何人', DEFAULT_MODEL_CATALOG, room);
  assert.deepEqual(none.targets, room, '未点名时扇出到房间阵容');

  const unknown = resolveMentions('@nobody 在吗 @claude 你来', DEFAULT_MODEL_CATALOG, room);
  assert.deepEqual(unknown.unknown, ['nobody']);
  assert.deepEqual(unknown.targets, ['claude-sonnet-4']);
});

test('stripMentions / activeMentionQuery：输入框交互的边界', () => {
  assert.equal(stripMentions('@claude @gpt-4o 帮我改'), '帮我改');
  assert.deepEqual(activeMentionQuery('hello @cl', 9), { query: 'cl', start: 6 });
  assert.equal(activeMentionQuery('hello @cl ', 10), null, '空格后不再视为提及');
  assert.equal(activeMentionQuery('mail@example.com', 16), null, '邮箱不应触发提及菜单');
});

test('tighten：删除填充词但保留事实，并修复句首大小写', () => {
  const before =
    'In order to evaluate the fact that our method is able to reduce latency, we conducted an experiment and it is worth noting that the results are very good.';
  const after = tighten(before);
  assert.ok(!/in order to/i.test(after), '应删除 "in order to"');
  assert.ok(!/\bvery\b/.test(after), '应删除 "very"');
  assert.ok(/^[A-Z]/.test(after), `句首应大写，实际：${after}`);
  assert.ok(/reduce latency/.test(after), '事实性内容必须保留');
});

test('rewrapParagraphs：合并段内硬换行，但绝不动命令块与 \\ 换行', () => {
  const source = [
    '\\begin{document}',
    '\\maketitle',
    '\\begin{abstract}',
    'Long-context summarization is bottlenecked',
    'by the decoding cost of large models.',
    '',
    '\\section{Method}',
    'First line ends here,\\\\',
    'second line must stay.',
  ].join('\n');

  const out = rewrapParagraphs(source).split('\n');
  assert.ok(out.includes('\\begin{document}'), '命令行必须独占一行');
  assert.ok(out.includes('\\maketitle'));
  assert.ok(
    out.includes('Long-context summarization is bottlenecked by the decoding cost of large models.'),
    '正文段落应被合并成一行',
  );
  assert.ok(out.includes('First line ends here,\\\\'), '以 \\\\ 结尾的行不应被合并');
  assert.ok(out.includes('second line must stay.'));
});

test('parseBibtex + auditCitations：解析条目并找出未定义/未使用引用', () => {
  const bib = DEMO_DOCUMENT.files['file-bib']!.content;
  const citations = parseBibtex(bib);
  assert.ok(citations.length >= 5);
  const lewis = citations.find((c) => c.key === 'lewis2020rag');
  assert.ok(lewis);
  assert.equal(lewis!.year, 2020);
  assert.ok(lewis!.authors.length >= 2);

  const audit = auditCitations('We follow \\citep{lewis2020rag} and \\citep{ghost2024}.', citations);
  assert.deepEqual(audit.missing, ['ghost2024']);
  assert.ok(audit.unused.includes('vaswani2017attention'));
});

test('checkTerminology：命中禁用写法并给出建议译法', () => {
  const violations = checkTerminology('We use LLM model for this task.', DEMO_CONTEXT.terminology);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.found, 'LLM model');
  assert.equal(violations[0]!.suggestion, '大语言模型');

  assert.equal(checkTerminology('We use large language models.', DEMO_CONTEXT.terminology).length, 0);
});

test('retrieve：BM25 能按关键词召回正确片段', () => {
  const files = Object.values(DEMO_DOCUMENT.files);
  const chunks = retrieve('speculative decoding draft length acceptance rate', files, DEMO_CONTEXT, { topK: 5 });
  assert.ok(chunks.length > 0);
  const joined = chunks.map((c) => c.text).join('\n');
  assert.match(joined, /draft/i);
  assert.ok(chunks.every((c, i) => i === 0 || chunks[i - 1]!.score >= c.score), '结果按分数降序');
});

test('parseProposal：从 ```latex 围栏中抽出可应用的提议', () => {
  const raw = '我删除了填充词。\n\n```latex\nWe show that ASD reduces latency by 2.4x.\n```\n';
  const parsed = parseProposal({
    raw,
    modelId: 'claude-sonnet-4',
    fileId: 'file-main',
    baseVersion: 1,
    range: { startLine: 2, endLine: 3 },
    intent: 'tighten',
    documentContent: 'line1\nold line a\nold line b\nline4',
  });
  assert.ok(parsed);
  assert.equal(parsed!.proposal.replacement, 'We show that ASD reduces latency by 2.4x.');
  assert.equal(parsed!.proposal.baseVersion, 1);
  assert.ok(parsed!.hunks.length >= 1);
  assert.match(parsed!.proposal.rationale, /填充词/);
});

test('parseProposal：仅重新折行（行数变化）应保留提议，纯空白差异应丢弃', () => {
  const rewrap = parseProposal({
    raw: '```latex\nalpha beta gamma\n```',
    modelId: 'm',
    fileId: 'f',
    baseVersion: 1,
    range: { startLine: 1, endLine: 2 },
    intent: 'tighten',
    documentContent: 'alpha beta\ngamma',
  });
  assert.ok(rewrap, '重新折行是真实的源码改动，应生成 diff');

  const whitespaceOnly = parseProposal({
    raw: '```latex\nalpha  beta\n```',
    modelId: 'm',
    fileId: 'f',
    baseVersion: 1,
    range: { startLine: 1, endLine: 1 },
    intent: 'polish',
    documentContent: 'alpha beta',
  });
  assert.equal(whitespaceOnly, undefined, '同一行内的空白差异视为回声');
});

test('parseProposal：模型原样返回 / 没有代码块时不应生成 diff', () => {
  const same = parseProposal({
    raw: '```latex\nsame text\n```',
    modelId: 'm',
    fileId: 'f',
    baseVersion: 1,
    range: { startLine: 1, endLine: 1 },
    intent: 'rewrite',
    documentContent: 'same text',
  });
  assert.equal(same, undefined, '无变化不应产生提议');

  const prose = parseProposal({
    raw: '我认为这段可以保留，不需要修改。',
    modelId: 'm',
    fileId: 'f',
    baseVersion: 1,
    range: { startLine: 1, endLine: 1 },
    intent: 'review',
    documentContent: 'some text',
  });
  assert.equal(prose, undefined, '纯自然语言不应被当成 LaTeX');
});

test('planTurn：并发上限、角色分配与交叉评审', () => {
  const plan1 = planTurn('@all 改写', {
    participants: ['claude-sonnet-4', 'gpt-4o', 'gemini-2.5-pro', 'deepseek-chat', 'kimi-k2'],
    maxConcurrency: 3,
    hasSelection: true,
    intent: 'rewrite',
  });
  assert.equal(plan1.targets.length, 3);
  assert.ok(plan1.warnings.some((w) => w.includes('并发上限')));
  assert.equal(plan1.roles.get('claude-sonnet-4'), 'author');
  assert.equal(plan1.roles.get('gpt-4o'), 'reviewer');
  assert.ok(plan1.crossReview, '有选区且多目标时应启用交叉评审');
  assert.equal(plan1.crossReview!.subject, 'claude-sonnet-4');
  assert.equal(plan1.crossReview!.reviewer, 'gpt-4o');

  const plan2 = planTurn('@claude 看看', { participants: ['claude-sonnet-4'], hasSelection: false });
  assert.equal(plan2.crossReview, undefined, '无选区不应交叉评审');
  assert.equal(plan2.roles.get('claude-sonnet-4'), 'assistant');
});

test('trimHistory：按字符预算保留最近的对话', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    threadId: 't',
    author: { kind: 'user' as const },
    text: 'x'.repeat(100),
    createdAt: new Date().toISOString(),
    status: 'done' as const,
  }));
  const trimmed = trimHistory(history, 350);
  assert.ok(trimmed.length >= 3 && trimmed.length <= 4, `实际保留 ${trimmed.length} 条`);
  assert.equal(trimmed[trimmed.length - 1]!.id, 'm9', '保留的是最近的消息');
});

test('MockCompiler：真的产出可解析的 PDF 与源码锚点', async () => {
  const compiler = new MockCompiler({ fileName: 'main.tex' });
  const content = DEMO_DOCUMENT.files['file-main']!.content;
  const out = await compiler.compile({ fileId: 'file-main', content });

  assert.equal(out.ok, true, `MockCompiler 报错：${out.log}`);
  assert.ok(out.pdfBytes && out.pdfBytes.byteLength > 1000);
  const header = Buffer.from(out.pdfBytes!.slice(0, 5)).toString('latin1');
  assert.equal(header, '%PDF-', 'PDF 魔数校验');
  assert.ok(out.anchors.length > 0, '应产生源码行 → PDF 位置锚点');
  assert.ok(out.anchors.every((a) => a.page >= 0 && Number.isFinite(a.y)));
  assert.equal(out.diagnostics.filter((d) => d.level === 'error').length, 0);
});

test('MockCompiler：括号不配对时给出可定位的错误', async () => {
  const compiler = new MockCompiler();
  const out = await compiler.compile({
    fileId: 'f',
    content: '\\documentclass{article}\n\\begin{document}\n\\section{Broken\n\\end{document}',
  });
  assert.equal(out.ok, false);
  const error = out.diagnostics.find((d) => d.level === 'error');
  assert.ok(error);
  assert.equal(error!.line, 4, '错误应定位到最后一行');
});

test('planTurn：@ 了不存在的模型时不应回退成"全员应答"，而要给出候选', () => {
  // 静态目录：有 qwen-plus，但没有 qwen-max（这正是真实场景里的错位来源）
  const catalog = DEFAULT_MODEL_CATALOG;
  const qwenPlus = catalog.find((m) => m.id === 'qwen-plus')!;
  const catalogWithQwenMax = [...catalog, { ...qwenPlus, id: 'qwen-max', label: 'Qwen Max' }];

  // 回归：曾经这里会静默回退到房间阵容，导致"@ 了 qwen-max 却由另外 4 个模型回答"
  const plan1 = planTurn('@qwen-max who are you?', {
    catalog,
    participants: ['claude-sonnet-4', 'gpt-4o'],
  });
  assert.deepEqual(plan1.targets, [], '认不出 @ 名时不应调用任何模型');
  const warning = plan1.warnings.join('\n');
  assert.match(warning, /无法识别的提及：@qwen-max/);
  assert.match(warning, /qwen-plus|qwen-max/, '应给出同家族的候选模型');
  assert.match(warning, /可用模型：/, '应列出可用模型清单');

  // 目录里存在该模型时必须能正常路由（前端 @ 菜单就是按这个目录提示的）
  const plan2 = planTurn('@qwen-max 你好', {
    catalog: catalogWithQwenMax,
    participants: ['claude-sonnet-4', 'gpt-4o'],
  });
  assert.deepEqual(plan2.targets, ['qwen-max']);

  // 部分写错：能认出的照常执行，同时提示写错的
  const plan3 = planTurn('@gpt-4o @nobody 一起看下', {
    catalog,
    participants: ['claude-sonnet-4'],
  });
  assert.deepEqual(plan3.targets, ['gpt-4o']);
  assert.match(plan3.warnings.join('\n'), /@nobody/);
});

test('检索器：用户添加的参考资料会被检索到，且长文按块切分', () => {
  const long = 'A'.repeat(1500) + ' 关键结论是 ZEPHYR-7 方案优于基线。';
  const context = {
    ...DEMO_CONTEXT,
    references: [
      {
        id: 'ref-1',
        title: '内部备忘录',
        kind: 'note' as const,
        text: long,
        addedAt: new Date().toISOString(),
        charCount: long.length,
        tags: [],
      },
    ],
  };
  const files = Object.values(DEMO_DOCUMENT.files);

  const chunks = retrieve('ZEPHYR-7 方案', files, context, { topK: 5 });
  assert.ok(chunks.length > 0, '参考资料必须进入检索索引');
  const hit = chunks.find((c) => c.kind === 'reference');
  assert.ok(hit, `应命中 reference 片段，实际：${chunks.map((c) => c.kind).join(',')}`);
  assert.match(hit!.text, /ZEPHYR-7/);
  assert.match(hit!.ref, /^ref:ref-1/, '来源标识应指向该资料');

  // 1500+ 字的资料会被切成多块，能定位到含关键词的那一块
  const allRefChunks = retrieve('关键结论', files, context, { topK: 10, kinds: ['reference'] });
  assert.ok(allRefChunks.length > 0);
});

test('检索器：中文查询必须能命中中文资料（bigram 分词的回归测试）', () => {
  const context = {
    ...DEMO_CONTEXT,
    references: [
      {
        id: 'ref-cn',
        title: '中文备忘录',
        kind: 'note' as const,
        text: '关键结论是：在小批量场景下，投机解码的接受率会明显下降，此时应当缩短草稿长度。',
        addedAt: new Date().toISOString(),
        charCount: 45,
        tags: [],
      },
    ],
  };
  const files = Object.values(DEMO_DOCUMENT.files);

  // 曾经这里会返回空：整段中文被当成一个 token，任何子串查询都匹配不上
  const hits = retrieve('关键结论 接受率 草稿长度', files, context, { topK: 5, kinds: ['reference'] });
  assert.ok(hits.length > 0, '中文查询应命中中文资料');
  assert.match(hits[0]!.text, /关键结论/);

  const miss = retrieve('完全不相关的火星殖民计划', files, context, { topK: 5, kinds: ['reference'] });
  assert.equal(miss.length, 0, '不相关的查询不应误召回');
});

test('segmentInstruction：混合指令要按 @提及拆给各自的模型', () => {
  const prompt = '@deepseek-chat 请先说明投机解码的加速上限，@qwen-plus 请评价 deepseek-chat 的这个说法';
  const { common, byModel } = segmentInstruction(prompt, DEFAULT_MODEL_CATALOG);

  assert.equal(common, '', '开头就是 @提及，没有公共前缀');
  assert.equal(
    byModel.get('deepseek-chat'),
    '请先说明投机解码的加速上限',
    'deepseek-chat 只应收到属于它的那半句（否则它会读到"请评价 deepseek-chat"而困惑）',
  );
  assert.equal(byModel.get('qwen-plus'), '请评价 deepseek-chat 的这个说法');

  // 带公共前缀的情况
  const withPrefix = segmentInstruction('大家好，@qwen-plus 你来回答', DEFAULT_MODEL_CATALOG);
  assert.equal(withPrefix.common, '大家好，');
  assert.equal(withPrefix.byModel.get('qwen-plus'), '你来回答');

  // 没有 @ 时全部作为公共指令
  const none = segmentInstruction('请总结一下', DEFAULT_MODEL_CATALOG);
  assert.equal(none.common, '请总结一下');
  assert.equal(none.byModel.size, 0);
});

test('PDF 文本 → 源码定位：跳过排版差异、跨行、以及中间夹公式的情况', () => {
  const source = [
    '\\section{Introduction}',
    'Morphological link proportions shape the fundamental mechanics',
    'of dexterous manipulation. Across primate evolution, and',
    'particularly in hominids, systematic shifts in skeletal geometry',
    '--- most notably relative thumb elongation --- served as',
    'anatomical prerequisites for precision grasping \\cite{lin2025}.',
  ].join('\n');

  // ① 普通整句（PDF 里是一整行，源码里跨了两行）
  const hit = findTextInSource(source, 'Morphological link proportions shape the fundamental mechanics of dexterous manipulation.');
  assert.ok(hit, '跨行的整句应能匹配');
  assert.equal(lineAtOffset(source, hit!.index), 2, '应落在第 2 行');

  // ② PDF 提取出的换行/多余空白不影响匹配
  assert.ok(findTextInSource(source, 'systematic   shifts\nin skeletal   geometry'), '空白差异应被忽略');

  // ③ TeX 把 --- 排成 em dash，PDF 里选出来的是 —，要能映射回去
  assert.ok(findTextInSource(source, 'skeletal geometry — most notably relative thumb elongation'), '弯引号/dash 应能还原');

  // ④ 句子中间夹了 \\cite{}，整句匹配不上时退化为前缀匹配（至少跳到句首）
  const partial = findTextInSource(source, 'anatomical prerequisites for precision grasping [12]');
  assert.ok(partial, '应能退化为前缀匹配，而不是直接失败');

  // ⑤ 真的不存在时要如实返回 null（不能随便跳到某一行）
  assert.equal(findTextInSource(source, 'this sentence is not in the document at all'), null);
  assert.equal(findTextInSource(source, ' '), null, '过短的输入不应匹配');
});

test('单词级定位：位置换算到列，而不是只给行', () => {
  const source = '\\begin{abstract}\nCo-designing robotic hand morphology and control\n\\end{abstract}';

  // ① positionAtOffset 给出 1 起的行与列（列与 Monaco 一致，按 UTF-16 码元）
  assert.deepEqual(positionAtOffset(source, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAtOffset(source, 7), { line: 1, column: 8 }, '"abstract" 的 a 在第 8 列');
  assert.deepEqual(positionAtOffset(source, 17), { line: 2, column: 1 }, '换行后是新行第 1 列');

  // ② 匹配到具体单词后，起始/结束都要能换算成精确区间
  const hit = findTextInSource(source, 'abstract');
  assert.ok(hit);
  const start = positionAtOffset(source, hit!.index);
  const end = positionAtOffset(source, hit!.index + hit!.length);
  assert.deepEqual(start, { line: 1, column: 8 });
  assert.deepEqual(end, { line: 1, column: 16 });
});

test('同一个词出现多次时：按"点击处占全文的比例"挑最接近的一处', () => {
  const source = [
    '% 开头',
    'the word normalized appears here',
    'padding padding padding padding padding padding',
    'padding padding padding padding padding padding',
    'padding padding padding padding padding padding',
    'padding padding padding padding padding padding',
    'padding padding padding padding padding padding',
    'padding padding padding padding padding padding',
    'and again the word normalized near the end',
  ].join('\n');

  // 不给比例 → 退回"第一次出现"（保持向后兼容）
  const first = findTextInSource(source, 'normalized');
  assert.equal(lineAtOffset(source, first!.index), 2);

  // 点击位置靠后 → 应命中末尾那一处，而不是永远跳第一次出现的位置
  const late = findTextInSource(source, 'normalized', { ratio: 0.95 });
  assert.equal(lineAtOffset(source, late!.index), 9, '应选中接近末尾的那一处');

  // 点击位置靠前 → 命中开头那一处
  const early = findTextInSource(source, 'normalized', { ratio: 0.05 });
  assert.equal(lineAtOffset(source, early!.index), 2);
});

test('用上下文挑正确的出现位置：同一个词出现多次也能选对', () => {
  const source = [
    '\\section{Method}',
    'the wrench space is bounded by the friction cone, and this wrench is applied',
    'padding line to separate the two occurrences ---------------------------------',
    'During manipulation, the contact wrench space grows with multi-digit overlap, and the wrench',
  ].join('\n');

  // 只给比例：只能粗略判断（这里靠后的一段更接近末尾）
  const byRatio = findTextInSource(source, 'wrench', { ratio: 0.95 });
  assert.equal(lineAtOffset(source, byRatio!.index), 4);

  // 给上下文："the contact ___ space" 只出现在最后一行
  const byContext = findTextInSource(source, 'wrench', {
    ratio: 0.1, // 故意给一个误导性的比例，检验上下文是否压过它
    before: 'During manipulation, the contact',
    after: 'space grows with multi-digit overlap',
  });
  assert.equal(lineAtOffset(source, byContext!.index), 4, '上下文应压过比例信号');

  // 反过来：上下文指向第一行时应命中第一行
  const firstOne = findTextInSource(source, 'wrench', {
    ratio: 0.95,
    before: 'the',
    after: 'space is bounded by the friction cone',
  });
  assert.equal(lineAtOffset(source, firstOne!.index), 2);
});
