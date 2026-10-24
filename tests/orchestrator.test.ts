/**
 * 编排器"发出去的 prompt 长什么样"的测试。
 *
 * 这里钉住的是一个真实事故：用户发 `@deepseek-reasoner SAY HELLO TO QWEN and @qwen-plus reply him`，
 * 结果 **Qwen 的回复里自称 "I'm DeepSeek-Reasoner"**。原因是编排器把**带 @提及的原始 prompt**
 * 原样发给了每个模型，模型把 "@某某" 理解成"请扮演某某"，于是开始替别的模型说话。
 *
 * 这类 bug 不报错、不崩溃，只是让输出变得似是而非——所以必须用"检查实际请求内容"的测试挡住。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_MODEL_CATALOG, type LlmChunk, type SharedContext } from '@paperflow/core';
import { LlmGateway, type LlmProvider, type LlmRequest } from '@paperflow/llm';
import { Orchestrator, parseProposal, planTurn, serializeMessages } from '@paperflow/agents';

/** 什么都不做、只把收到的请求记下来的假提供方。 */
class CapturingProvider implements LlmProvider {
  readonly id = 'deepseek' as const;

  readonly label = 'Capture';

  readonly requests: LlmRequest[] = [];

  isConfigured(): boolean {
    return true;
  }

  models(): string[] {
    // 必须声明所有测试里用到的模型 id，否则网关会按前缀找不到 qwen-vl-max 而回退到 Mock
    return ['qwen-plus', 'deepseek-reasoner', 'qwen-vl-max'];
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
    this.requests.push(req);
    yield { type: 'text', text: '收到。' };
    yield { type: 'usage', usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

const emptyContext: SharedContext = { citations: [], terminology: [], figures: [] };

/**
 * 测试用目录：静态目录 + `deepseek-reasoner`。
 * 真实服务端传给编排器的是 gateway.catalog()（合并了厂商声明的模型），
 * 这里手工模拟那个形状——静态目录里只有 deepseek-chat，没有 reasoner。
 */
const qwenPlus = DEFAULT_MODEL_CATALOG.find((m) => m.id === 'qwen-plus')!;
const REASONER = { ...qwenPlus, id: 'deepseek-reasoner', label: 'deepseek-reasoner', provider: 'deepseek' as const, family: 'deepseek' };
const TEST_CATALOG = [...DEFAULT_MODEL_CATALOG, REASONER];

async function runTurn(prompt: string) {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({
    gateway,
    catalog: TEST_CATALOG,
    crossReview: false,
  });

  const events = [];
  for await (const event of orchestrator.streamTurn({
    threadId: 't',
    prompt,
    participants: ['claude-sonnet-4', 'gpt-4o'],
    sharedContext: emptyContext,
  })) {
    events.push(event);
  }
  return { provider, events };
}

test('发给模型的指令里不能残留 @提及（否则模型会去扮演被点名者）', async () => {
  const { provider } = await runTurn('@deepseek-reasoner SAY HELLO TO QWEN and @qwen-plus reply him');

  assert.equal(provider.requests.length, 2, '两个被点名的模型各调用一次');

  for (const request of provider.requests) {
    const userMessages = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    assert.ok(
      !/@(deepseek-reasoner|qwen-plus)/.test(userMessages),
      `指令里不应残留 @提及，实际收到：${userMessages.slice(0, 160)}`,
    );
  }

  // 混合指令会被拆给各自的模型：deepseek 收到前半句，qwen 收到后半句
  const instructions = provider.requests.map((r) =>
    r.messages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n'),
  );
  assert.match(instructions[0]!, /SAY HELLO TO QWEN/, '第一个模型应收到属于自己的那段');
  assert.match(instructions[1]!, /reply him/, '第二个模型应收到属于自己的那段');
  assert.ok(
    !/SAY HELLO TO QWEN/.test(instructions[1]!),
    '第二个模型不该收到写给第一个模型的指令（这正是"ds 困惑地说我就是 ds"的成因）',
  );
});

test('每个模型都被明确告知自己的身份，并被禁止扮演其他模型', async () => {
  const { provider } = await runTurn('@deepseek-reasoner @qwen-plus 互相打个招呼');

  for (const request of provider.requests) {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    assert.match(system, /【群聊规则（必须遵守）】/);
    assert.match(system, /你的身份是/, '必须声明身份');
    assert.match(system, /不要扮演、模仿或代替其他模型发言/, '必须禁止角色扮演');
    assert.match(system, /\[模型id\]/, '必须解释历史消息里的发言人标签格式');
  }

  // 身份必须是各自不同的：第一次调用认领 deepseek-reasoner，第二次认领 qwen-plus
  const claimed = provider.requests.map((r) => {
    const system = r.messages.find((m) => m.role === 'system')?.content ?? '';
    return /你的身份是「([^」]+)」/.exec(system)?.[1];
  });
  assert.equal(new Set(claimed).size, 2, `两次调用应声明不同身份，实际：${claimed.join(' / ')}`);
  assert.deepEqual(claimed, ['deepseek-reasoner', 'Qwen Plus'], '每个模型认领自己的展示名');
});

test('历史消息带发言人标签，且 system 里解释了该格式', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: false });

  for await (const _event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '继续',
    participants: ['qwen-plus'],
    sharedContext: emptyContext,
    history: [
      {
        id: 'm1',
        threadId: 't',
        author: { kind: 'model', modelId: 'deepseek-reasoner', role: 'assistant' },
        text: '我是 DeepSeek 的推理模型。',
        createdAt: new Date().toISOString(),
        status: 'done',
      },
    ],
  })) {
    /* 只需要副作用 */
  }

  const request = provider.requests[0]!;
  const assistantTurn = request.messages.find((m) => m.role === 'assistant');
  assert.ok(assistantTurn, '历史里的模型发言应作为 assistant 轮次回放');
  assert.match(assistantTurn!.content, /^\[deepseek-reasoner\]/, '应带发言人标签');
});

test('参考资料正文必须进入提示词（不能只给标题，否则模型只会反问"哪一篇"）', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: false });

  // 中文提问 + 英文资料，且是"这篇论文"这种模糊指代：BM25 词面匹配必然落空
  const referenceText =
    'Handcrafted Architectural Design of Large Language Models. We propose grouped attention and adaptive draft lengths, reducing latency by 2.4x on three benchmarks.';

  for await (const _event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '@qwen-plus 帮我介绍一下这篇论文',
    participants: ['qwen-plus'],
    sharedContext: {
      ...emptyContext,
      references: [
        {
          id: 'ref-1',
          title: 'Handcrafted Architectural Design of LLMs',
          kind: 'text',
          text: referenceText,
          addedAt: new Date().toISOString(),
          charCount: referenceText.length,
          tags: [],
        },
      ],
    },
  })) {
    /* 只需要副作用 */
  }

  const system = provider.requests[0]!.messages.find((m) => m.role === 'system')?.content ?? '';
  assert.match(system, /【参考资料】/, '应有参考资料块');
  assert.ok(
    system.includes('reducing latency by 2.4x'),
    '必须包含资料正文节选，否则模型无从介绍',
  );
  assert.match(system, /不要声称"内容不全"/, '应告诉模型资料已给全，别推说内容不全');
});

test('真实模型不写 ```latex 围栏时，也能从散文里认出替换文本', () => {
  // 真实的第 15–16 行（换行位置与 demo 论文一致）
  const line15 = 'Long-context scientific summarization is bottlenecked by the autoregressive decoding cost of large';
  const line16 = 'language models. We introduce Adaptive Speculative Decoding (ASD), which predicts a per-step draft';
  const documentContent = [
    ...Array.from({ length: 14 }, (_, i) => `% 填充第 ${i + 1} 行`),
    line15,
    line16,
    'length from the entropy of the draft distribution and the recent acceptance rate.',
  ].join('\n');

  // 实测 deepseek-reasoner 的真实回复形状：先说明，再直接给出替换文本（没有围栏）
  const raw = [
    '我压缩了这两行，删去冗余修饰，保留核心信息与跨行衔接。',
    '',
    'Autoregressive decoding in large language models bottlenecks long-context scientific summarization. We introduce Adaptive Speculative Decoding (ASD), predicting a per-step draft',
    '',
    '字数：25 → 20 词（约 −20%），行数不变。',
  ].join('\n');

  const parsed = parseProposal({
    raw,
    modelId: 'deepseek-reasoner',
    fileId: 'file-main',
    baseVersion: 3,
    range: { startLine: 15, endLine: 16 },
    intent: 'tighten',
    documentContent,
  });

  assert.ok(parsed, '应能从散文里提取出替换文本');
  assert.match(parsed!.proposal.replacement, /^Autoregressive decoding/);
  assert.ok(parsed!.hunks.length > 0, '应生成可裁决的 diff');
  assert.equal(parsed!.proposal.range.startLine, 15);
});

test('散文提取不能误伤：纯评论（不与原文重合）不应产生 diff', () => {
  const parsed = parseProposal({
    raw: '这段写得很好，我认为不需要改动。建议把精力放在补充实验上。',
    modelId: 'm',
    fileId: 'f',
    baseVersion: 1,
    range: { startLine: 1, endLine: 1 },
    intent: 'rewrite',
    documentContent: 'Long-context summarization is bottlenecked by decoding cost.',
  });
  assert.equal(parsed, undefined);
});

test('序列化的块必须齐全：选区、群聊规则、参考资料、作者合约一个都不能少', () => {
  // 回归：一次大块替换曾把"编辑上下文（待处理文本）"整段删掉，
  // 结果 MockProvider 找不到选区、真模型也不知道要改哪一段 —— 而且不报错。
  const messages = serializeMessages({
    role: 'author',
    instruction: '压缩这段',
    selection: { text: 'ORIGINAL SELECTION TEXT', fileId: 'file-main', startLine: 3, endLine: 3 },
    sharedContext: {
      citations: [],
      terminology: [],
      figures: [],
      references: [
        { id: 'r1', title: '某资料', kind: 'note', text: 'DATUM', addedAt: '', charCount: 5, tags: [] },
      ],
    },
    retrieved: [],
    history: [],
    selfModel: { id: 'claude-sonnet-4', label: 'Claude' },
  });

  const systemMessage = messages.find((m) => m.role === 'system')!;
  const system = typeof systemMessage.content === 'string' ? systemMessage.content : '';
  assert.match(system, /【待处理文本】\nORIGINAL SELECTION TEXT/, '必须有待处理文本（否则模型不知道改哪段）');
  assert.match(system, /【群聊规则（必须遵守）】/, '必须有群聊规则');
  assert.match(system, /【参考资料】/, '必须有参考资料');
  assert.match(system, /【输出格式（必须严格遵守）】/, '撰写者必须有输出格式合约');
});

test('只有视觉模型会收到 PDF 页面图像；纯文本模型只拿到文本', async () => {
  const pageImage = 'data:image/jpeg;base64,AAAA';

  async function run(modelId: string, capabilities: ('vision' | 'writing')[]) {
    const provider = new CapturingProvider();
    const gateway = new LlmGateway([provider]);
    const model = { ...qwenPlus, id: modelId, label: modelId, provider: 'qwen' as const, capabilities };
    const orchestrator = new Orchestrator({ gateway, catalog: [...TEST_CATALOG, model], crossReview: false });

    for await (const _event of orchestrator.streamTurn({
      threadId: 't',
      prompt: `@${modelId} 介绍一下这份 PDF`,
      participants: [modelId],
      sharedContext: {
        ...emptyContext,
        references: [
          {
            id: 'ref-pdf',
            title: '一份 PDF',
            kind: 'pdf',
            text: '（文本层）',
            addedAt: new Date().toISOString(),
            charCount: 6,
            tags: [],
            pageImages: [pageImage],
            pageCount: 3,
          },
        ],
      },
    })) {
      /* 只需要副作用 */
    }
    const lastUser = [...provider.requests[0]!.messages].reverse().find((m) => m.role === 'user')!;
    return lastUser.content;
  }

  const visionContent = await run('qwen-vl-max', ['vision', 'writing']);
  assert.ok(Array.isArray(visionContent), '视觉模型的 user 消息应包含图像块');
  const images = (visionContent as { type: string }[]).filter((p) => p.type === 'image');
  assert.equal(images.length, 1, '应附带 1 张页面图像');
  // 图片必须在 user 消息里（DeepSeek 对 system/assistant 中的图片返回 400）
  assert.ok(
    (visionContent as { type: string }[]).some((p) => p.type === 'text'),
    '文本指令不能丢',
  );

  const textContent = await run('qwen-plus', ['writing']);
  assert.equal(typeof textContent, 'string', '纯文本模型不应收到图像块（否则上游会 400）');
});

test('同一条消息里要求"评价另一个模型"时，必须串行执行且后者能看到前者', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: true });

  const events = [];
  for await (const event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '@deepseek-reasoner @qwen-plus 请 qwen-plus 评价一下 deepseek-reasoner 的方案',
    participants: ['deepseek-reasoner', 'qwen-plus'],
    sharedContext: emptyContext,
  })) {
    events.push(event);
  }

  // 串行：第一次调用的请求里不应出现第二个模型的回答；第二次调用必须包含第一个的回答
  assert.equal(provider.requests.length, 2, '两个模型各调用一次');

  const firstSystem = provider.requests[0]!.messages.find((m) => m.role === 'system')!.content as string;
  const secondSystem = provider.requests[1]!.messages.find((m) => m.role === 'system')!.content as string;

  assert.ok(!/【另一位模型/.test(firstSystem), '第一位发言时不该看到别人的回答');
  assert.match(secondSystem, /【另一位模型（deepseek-reasoner）刚刚给出的方案】/, '第二位必须拿到前一位的回答');
  assert.match(secondSystem, /收到。/, '并且是回答的正文内容');

  // 事件里也应有两种角色的消息
  const started = events.filter((e) => e.type === 'message.start').map((e) => (e.type === 'message.start' ? e.modelId : ''));
  assert.deepEqual(started, ['deepseek-reasoner', 'qwen-plus'], '按顺序依次发言');
});

test('没有评审意图时仍并发执行（不牺牲速度）', async () => {
  const plan = planTurn('@deepseek-reasoner @qwen-plus 各自写一句开场白', {
    catalog: TEST_CATALOG,
    participants: [],
  });
  assert.equal(plan.mode, 'parallel');

  const plan2 = planTurn('@deepseek-reasoner @qwen-plus 请互相评价对方的方案', {
    catalog: TEST_CATALOG,
    participants: [],
  });
  assert.equal(plan2.mode, 'sequential', '有"评价"意图时应串行');
  assert.ok(plan2.warnings.some((w) => w.includes('依次发言')), '应告知用户改为串行');
});

test('用户引用某条回答时，它会被完整注入并要求点名回应', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: false });

  for await (const _event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '@qwen-plus 请验证这条回答',
    participants: ['qwen-plus'],
    sharedContext: emptyContext,
    quoted: [{ modelId: 'deepseek-chat', text: '实验编号是 PLUM-77。' }],
  })) {
    /* 只需要副作用 */
  }

  const system = provider.requests[0]!.messages.find((m) => m.role === 'system')!.content as string;
  assert.match(system, /【用户要求你针对以下回答发言】/);
  assert.match(system, /PLUM-77/, '被引用的回答正文必须在提示词里');
  assert.match(system, /来自 deepseek-chat 的回答/);
});

test('论文 .tex 正文必须进入提示词（之前只给了章节标题，模型回答"读不到文件"）', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: false });

  const paper = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Introduction}',
    'UNIQUE_PAPER_SENTENCE 投机解码通过草稿模型加速推理。',
    '\\section{Method}',
    '\\subsection{Adaptive draft length}',
    'UNIQUE_METHOD_SENTENCE 我们按熵动态选择草稿长度。',
    '\\end{document}',
  ].join('\n');

  for await (const _event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '@qwen-plus 你能读到我的 .tex 文件吗？',
    participants: ['qwen-plus'],
    sharedContext: emptyContext,
    files: [
      { id: 'file-main', path: 'main.tex', kind: 'tex', content: paper, version: 1 },
    ],
    document: { fileId: 'file-main', content: paper, version: 1 },
  })) {
    /* 只需要副作用 */
  }

  const system = provider.requests[0]!.messages.find((m) => m.role === 'system')!.content as string;
  assert.match(system, /【论文源码】/, '必须有论文源码块');
  assert.match(system, /main.tex/, '应标明文件路径');
  assert.match(system, /UNIQUE_PAPER_SENTENCE/, '正文内容必须真的在提示词里（而不只是章节标题）');
  assert.match(system, /UNIQUE_METHOD_SENTENCE/);
  assert.match(system, /章节结构/, '保留结构导航便于模型定位');
  assert.match(system, /不要说"我看不到 \.tex 文件"/, '应明确告知模型它已经拿到了源码');
});

test('论文正文取主文档，而不是"恰好开着的标签页"', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: false });

  const mainDoc = '\\documentclass{article}\\begin{document}\\section{MAIN}\\label{sec:main} 主文档的独特内容 MAIN_ONLY_SENTENCE \\end{document}';
  const otherFile = '\\section{OTHER} 另一个文件的独特内容 OTHER_ONLY_SENTENCE';

  for await (const _event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '@qwen-plus 解析一下项目里的文章',
    participants: ['qwen-plus'],
    sharedContext: emptyContext,
    files: [
      { id: 'other.tex', path: 'other.tex', kind: 'tex', content: otherFile, version: 1 },
      { id: 'main.tex', path: 'main.tex', kind: 'tex', content: mainDoc, version: 1 },
    ],
    // 当前打开的是另一个文件
    document: { fileId: 'other.tex', content: otherFile, version: 1 },
    // 主文档显式给出
    mainFile: { id: 'main.tex', path: 'main.tex', kind: 'tex', content: mainDoc, version: 1 },
  })) {
    /* 只看提示词 */
  }

  const system = provider.requests[0]!.messages.find((m) => m.role === 'system')!.content as string;
  assert.match(system, /MAIN_ONLY_SENTENCE/, '论文正文必须是主文档');
  assert.match(system, /main\.tex/, '论文源码块应标明主文档路径');
  assert.ok(
    !system.includes('OTHER_ONLY_SENTENCE'),
    '不能把"恰好开着的文件"当成整篇论文（实测就因此读到了残留的 main.tex）',
  );
});

test('编译产物的 PDF 全文要一并注入，让 agent 知道"读者看到的正文"', async () => {
  const provider = new CapturingProvider();
  const gateway = new LlmGateway([provider]);
  const orchestrator = new Orchestrator({ gateway, catalog: TEST_CATALOG, crossReview: false });

  const compiled = 'HandAdapt: Evolutionary Co-Design of Link Proportions and Control Policy for Direct-Drive Dexterous Hands '.repeat(6);

  for await (const _event of orchestrator.streamTurn({
    threadId: 't',
    prompt: '@qwen-plus 这篇文章讲了什么？',
    participants: ['qwen-plus'],
    sharedContext: emptyContext,
    files: [{ id: 'main.tex', path: 'main.tex', kind: 'tex', content: '\\section{X} 源码内容', version: 1 }],
    document: { fileId: 'main.tex', content: '\\section{X} 源码内容', version: 1 },
    compiledText: compiled,
  })) {
    /* 只看提示词 */
  }

  const system = provider.requests[0]!.messages.find((m) => m.role === 'system')!.content as string;
  assert.match(system, /【论文正文（编译产物提取）】/, '应有编译产物正文块');
  assert.match(system, /HandAdapt/, '编译产物的正文应在提示词里');
});
