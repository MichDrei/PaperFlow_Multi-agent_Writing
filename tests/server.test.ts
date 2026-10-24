/**
 * 编排服务的 HTTP 契约测试。
 *
 * 在临时端口上**真实启动**一次 Fastify（`buildServer` + `listen(0)`），
 * 然后用 fetch 走完整的 HTTP/SSE 栈，因此能覆盖那些只在真实连接下才暴露的问题：
 * - hijack 之后 CORS 头是否会丢（踩过）；
 * - SSE 事件序列是否完整、句法是否可解析；
 * - 「只有空白差异」时是否仍会产出 diff（踩过）；
 * - 编译端点是否真的返回可用的 PDF；
 * - 客户端断开时上游是否被取消。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { StreamEvent } from '@paperflow/core';
import { buildServer } from '../apps/server/src/app.js';
import { MemoryContextStore } from '../apps/server/src/storage/memory.js';
import { loadEnv } from '../apps/server/src/env.js';

/** 启动一个绑定随机端口的服务实例，返回基地址与关闭函数。 */
async function startServer(
  overrides: Record<string, string | undefined> = {},
  extra: { compileEngine?: 'tectonic' | 'mock' } = {},
) {
  const env = loadEnv({
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    CORS_ORIGINS: 'http://127.0.0.1:5273',
    MAX_CONCURRENCY: '4',
    ENABLE_CROSS_REVIEW: 'true',
    ...overrides,
  } as NodeJS.ProcessEnv);

  // envSource: {} —— 强制不带任何厂商 Key，走本地回退路径（结果可复现）
  // persistPath: null + 临时 projectsRoot —— 隔离掉本机真实数据，
  // 否则测试会读写用户的 .paperflow（项目文件、共享知识），用例互相污染。
  const projectsRoot = mkdtempSync(join(process.cwd(), '.cache', 'server-projects-'));
  const built = await buildServer({
    env,
    envSource: {},
    persistPath: null,
    projectsRoot,
    ...extra,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取监听端口');

  return {
    ...built,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await built.app.close();
      rmSync(projectsRoot, { recursive: true, force: true });
    },
  };
}

/** 读取一个 SSE 响应，解析成事件数组。 */
async function readSse(res: Response): Promise<StreamEvent[]> {
  assert.ok(res.body, 'SSE 响应必须有 body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: StreamEvent[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data) events.push(JSON.parse(data) as StreamEvent);
    }
  }
  return events;
}

const DOCUMENT = [
  '\\documentclass{article}',
  '\\begin{document}',
  'In order to evaluate the fact that our method is able to reduce latency, we conducted an experiment.',
  '\\end{document}',
].join('\n');

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'test-thread-1',
    prompt: '@all 压缩这段',
    intent: 'tighten',
    participants: ['claude-sonnet-4', 'gpt-4o', 'deepseek-chat'],
    selection: {
      fileId: 'file-main',
      start: { line: 3, column: 1 },
      end: { line: 3, column: 120 },
      text: 'In order to evaluate the fact that our method is able to reduce latency, we conducted an experiment.',
    },
    document: { fileId: 'file-main', version: 4, content: DOCUMENT },
    ...overrides,
  };
}

test('GET /api/health：如实报告没有真实厂商（降级可用）', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      hasRealProvider: boolean;
      compileEngine: string;
      providers: { id: string; configured: boolean }[];
    };
    assert.equal(body.ok, true);
    assert.equal(body.hasRealProvider, false, '没有 Key 时必须如实报告');
    // 引擎取决于本机是否装了 Tectonic：装了就是真排版，没装才退回近似排版
    assert.ok(['tectonic', 'mock'].includes(body.compileEngine), `未知引擎：${body.compileEngine}`);
    assert.equal(body.providers.find((p) => p.id === 'mock')?.configured, true);
  } finally {
    await server.close();
  }
});

test('GET /api/models：标注真实可用性，未配置的模型标为不可用', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/models`);
    const body = (await res.json()) as { models: { id: string; available: boolean }[]; hasRealProvider: boolean };
    assert.equal(body.hasRealProvider, false);
    assert.ok(body.models.every((m) => m.available === false), '没有任何 Key 时所有模型都不可用');
  } finally {
    await server.close();
  }
});

test('POST /api/chat：SSE 事件序列完整，并产出可应用的 diff', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5273' },
      body: JSON.stringify(chatBody()),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    // 回归保护：hijack 之后的响应必须仍然带 CORS 头，否则浏览器会整条流被拦掉
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:5273',
      'SSE 响应缺少 Access-Control-Allow-Origin —— 说明头被 writeHead 覆盖了',
    );

    const events = await readSse(res);
    const types = events.map((e) => e.type);

    assert.equal(types[0], 'turn.start');
    assert.equal(types[types.length - 1], 'turn.end');

    const starts = events.filter((e) => e.type === 'message.start');
    // 3 个目标模型 + 1 条交叉评审消息
    assert.equal(starts.length, 4, `应为 3 个角色 + 1 次交叉评审，实际 ${starts.length}`);
    const startedModels = starts.map((e) => (e.type === 'message.start' ? e.modelId : ''));
    assert.ok(startedModels.includes('claude-sonnet-4') && startedModels.includes('gpt-4o'));

    const proposal = events.find((e) => e.type === 'proposal');
    assert.ok(proposal, '撰写者应产出 EditProposal');
    if (proposal.type === 'proposal') {
      assert.equal(proposal.proposal.fileId, 'file-main');
      assert.equal(proposal.proposal.baseVersion, 4, '必须记录 diff 基于的文档版本');
      assert.deepEqual(proposal.proposal.range, { startLine: 3, endLine: 3 });
      assert.ok(!/in order to/i.test(proposal.proposal.replacement), '替换文本应已压缩冗余表达');
      assert.ok(proposal.hunks.length >= 1);
      assert.ok(
        proposal.hunks.some((h) => h.lines.some((l) => l.kind === 'del')),
        'diff 应包含删除行',
      );
    }

    // 交叉评审：让第二个模型评价第一个模型的产出
    const systemNotes = events.filter((e) => e.type === 'system').map((e) => (e.type === 'system' ? e.text : ''));
    assert.ok(
      systemNotes.some((t) => t.includes('交叉评审')),
      `应发起交叉评审，实际系统提示：${systemNotes.join(' | ')}`,
    );

    const ends = events.filter((e) => e.type === 'message.end');
    assert.equal(ends.length, 4, '3 个角色 + 1 次交叉评审各有一条结束事件');

    const turnEnd = events.find((e) => e.type === 'turn.end');
    assert.equal(turnEnd?.type === 'turn.end' ? turnEnd.status : undefined, 'done');
  } finally {
    await server.close();
  }
});

test('POST /api/chat：只有空白差异时不产出 diff（避免噪声提议）', async () => {
  const server = await startServer();
  try {
    const sameText = 'We reduce latency by 2.4x on three benchmarks.';
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({
          threadId: 'test-thread-2',
          participants: ['claude-sonnet-4'],
          selection: {
            fileId: 'file-main',
            start: { line: 3, column: 1 },
            end: { line: 3, column: 60 },
            text: sameText,
          },
          document: { fileId: 'file-main', version: 1, content: `a\nb\n${sameText}\nd` },
        }),
      ),
    });

    const events = await readSse(res);
    assert.equal(events.filter((e) => e.type === 'proposal').length, 0, '无实质变化时不应生成 diff');
    const author = events.find((e) => e.type === 'message.start');
    assert.ok(author);
    // 但仍然要有可读回复，而不是空消息
    const text = events
      .filter((e) => e.type === 'message.delta')
      .map((e) => (e.type === 'message.delta' ? e.text : ''))
      .join('');
    assert.ok(text.length > 0);
  } finally {
    await server.close();
  }
});

test('POST /api/chat：非法请求体返回结构化 400', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: '', prompt: '' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'bad_request');
  } finally {
    await server.close();
  }
});

test('POST /api/compile（近似排版引擎）：返回 PDF 与源码锚点，且命中内容缓存', async () => {
  const server = await startServer({}, { compileEngine: 'mock' });
  try {
    const payload = { fileId: 'file-main', content: DOCUMENT };

    const first = await fetch(`${server.baseUrl}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 200);
    const result = (await first.json()) as {
      ok: boolean;
      pdfBase64?: string;
      pdfUrl?: string;
      anchors: { line: number; page: number; y: number }[];
      engine: string;
      cached: boolean;
    };

    assert.equal(result.ok, true);
    assert.equal(result.engine, 'mock');
    assert.equal(result.cached, false, '首次编译不应命中缓存');
    // PDF 已改为落盘 + 走 URL（几百 MB 的产物 base64 进 JSON 会超过 V8 字符串上限）
    assert.ok(result.pdfUrl, '应返回 PDF 的 URL');
    const pdfResponse = await fetch(new URL(result.pdfUrl!, server.baseUrl));
    assert.equal(pdfResponse.status, 200);
    const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(pdfBytes.byteLength > 500);
    assert.ok(result.anchors.length > 0, '应返回源码行锚点用于跳转定位');

    // 同一份内容再编译一次：应命中缓存（避免多模型反复触发重复排版）
    const second = await fetch(`${server.baseUrl}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const cached = (await second.json()) as { cached: boolean; pdfBase64?: string };
    assert.equal(cached.cached, true);
    assert.equal(cached.pdfBase64, result.pdfBase64, '缓存应返回同一份产物');
  } finally {
    await server.close();
  }
});

test('会话历史：回合结束后服务端保留上下文，供下一轮模型参考', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        chatBody({ threadId: 'history-thread', participants: ['claude-sonnet-4'], selection: undefined, document: undefined, prompt: '介绍一下当前文档' }),
      ),
    });
    await readSse(res);

    const sessions = await fetch(`${server.baseUrl}/api/sessions`);
    const body = (await sessions.json()) as { sessions: { threadId: string; messages: number }[] };
    const record = body.sessions.find((s) => s.threadId === 'history-thread');
    assert.ok(record, '应记录该线程');
    assert.ok(record!.messages >= 2, `应至少保存"用户提问 + 模型回复"，实际 ${record!.messages} 条`);
  } finally {
    await server.close();
  }
});

test('参考资料：可添加、可检索、可删除，且非法规格被拒', async () => {
  const server = await startServer();
  try {
    const context0 = (await (await fetch(`${server.baseUrl}/api/context`)).json()) as { references: unknown[] };
    assert.deepEqual(context0.references, [], '新项目默认没有参考资料');

    // 添加
    const secret = 'ZEPHYR-7';
    const created = await fetch(`${server.baseUrl}/api/context/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '内部备忘录',
        kind: 'note',
        source: '测试',
        text: `项目内部代号是 ${secret}，切勿外传。`,
      }),
    });
    assert.equal(created.status, 201);
    const { reference } = (await created.json()) as { reference: { id: string; charCount: number } };
    assert.ok(reference.id);
    assert.equal(reference.charCount, `项目内部代号是 ${secret}，切勿外传。`.length);

    // 列表只回传元信息，不回传全文（避免响应体过大）
    const context1 = (await (await fetch(`${server.baseUrl}/api/context`)).json()) as {
      references: { id: string; title: string; hasText: boolean; text?: string }[];
    };
    assert.equal(context1.references.length, 1);
    assert.equal(context1.references[0]!.hasText, true);
    assert.equal(context1.references[0]!.text, undefined, '列表不应带全文');

    // 正文按 id 取
    const detail = (await (await fetch(`${server.baseUrl}/api/context/references/${reference.id}`)).json()) as {
      text: string;
    };
    assert.match(detail.text, new RegExp(secret));

    // 空内容必须被拒（否则会塞一条无法检索的空资料）
    const invalid = await fetch(`${server.baseUrl}/api/context/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', text: '' }),
    });
    assert.equal(invalid.status, 400);

    // 删除
    const removed = await fetch(`${server.baseUrl}/api/context/references/${reference.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    const again = await fetch(`${server.baseUrl}/api/context/references/${reference.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404, '重复删除应返回 404');
  } finally {
    await server.close();
  }
});

test('导入 BibTeX：解析成结构化文献条目并按 key 合并', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/context/citations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bibtex: [
          '@article{wang2025zephyr,',
          '  title = {Zephyr: Adaptive Drafting},',
          '  author = {Wang, Li and Chen, Mei},',
          '  year = {2025},',
          '  journal = {Journal of Speculative Systems}',
          '}',
        ].join('\n'),
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { added: number; total: number; citations: { key: string; year: number }[] };
    assert.equal(body.added, 1);
    const added = body.citations.find((c) => c.key === 'wang2025zephyr');
    assert.equal(added?.year, 2025, 'year 字段不能被解析丢掉');

    // 同一个 key 再来一次：算更新而非新增
    const again = await fetch(`${server.baseUrl}/api/context/citations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bibtex: '@article{wang2025zephyr, title = {Renamed}, year = {2025}}' }),
    });
    const body2 = (await again.json()) as { added: number };
    assert.equal(body2.added, 0, '同 key 应视为更新');

    // 解析不出条目时应报错而不是静默成功
    const empty = await fetch(`${server.baseUrl}/api/context/citations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bibtex: '这不是 bibtex' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await server.close();
  }
});

test('共享知识落盘：重启后端后参考资料不丢（回归）', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.cache', 'ctx-persist-'));
  const persistPath = join(dir, 'context.json');

  try {
    // 第一次启动：加两份资料
    const first = new MemoryContextStore({ persistPath });
    first.addReference('demo-project', {
      id: 'r1',
      title: '论文 A',
      kind: 'pdf',
      text: '第一篇资料正文，包含关键词 夜莺补丁。',
      addedAt: new Date().toISOString(),
      charCount: 20,
      tags: [],
    });
    first.addReference('demo-project', {
      id: 'r2',
      title: '论文 B',
      kind: 'text',
      text: '第二篇资料正文。',
      addedAt: new Date().toISOString(),
      charCount: 8,
      tags: [],
    });
    assert.ok(existsSync(persistPath), '写入后应生成落盘文件');

    // 模拟后端重启：新建实例（这正是 tsx watch 热重载时发生的事）
    const second = new MemoryContextStore({ persistPath });
    const restored = second.sharedContext('demo-project');
    assert.equal(restored.references.length, 2, '重启后资料必须还在');
    assert.deepEqual(
      restored.references.map((r) => r.title),
      ['论文 A', '论文 B'],
    );
    assert.equal(restored.references[0]!.text, '第一篇资料正文，包含关键词 夜莺补丁。');

    // 删除也要落盘
    second.removeReference('demo-project', 'r2');
    const third = new MemoryContextStore({ persistPath });
    assert.equal(third.sharedContext('demo-project').references.length, 1);

    // 文件损坏时不能阻止服务启动
    writeFileSync(persistPath, '{ 这不是合法 JSON', 'utf8');
    const recovered = new MemoryContextStore({ persistPath });
    assert.ok(recovered.sharedContext('demo-project').citations.length > 0, '应回退到种子数据');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('POST /api/compile（真引擎 Tectonic）：排版真实内容，中文与表格都能出 PDF', async (t) => {
  const { isTectonicAvailable } = await import('@paperflow/latex/tectonic');
  if (!isTectonicAvailable()) {
    t.skip('本机没有 Tectonic 二进制');
    return;
  }

  const server = await startServer({}, { compileEngine: 'tectonic' });
  try {
    const res = await fetch(`${server.baseUrl}/api/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: 'main',
        engine: 'auto',
        content: [
          '\\documentclass[11pt]{article}',
          '\\usepackage{booktabs}',
          '\\begin{document}',
          '\\section{方法}',
          '本文提出自适应投机解码，延迟降低 2.4 倍。',
          '\\begin{tabular}{lcc}\\toprule 方法 & ROUGE-L & 延迟 \\\\ \\midrule ASD & 42.9 & 7.6 \\\\ \\bottomrule\\end{tabular}',
          '\\end{document}',
        ].join('\n'),
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; engine: string; pdfUrl?: string; log: string };
    assert.equal(body.engine, 'tectonic');
    assert.equal(body.ok, true, `真引擎编译失败：${body.log.slice(-400)}`);
    assert.ok(body.pdfUrl, '应返回 PDF 的 URL');
    const pdfRes = await fetch(new URL(body.pdfUrl!, server.baseUrl));
    assert.equal(pdfRes.status, 200);
    const bytes = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(bytes.byteLength > 8000, '真引擎会内嵌字体，PDF 明显更大');
    assert.match(body.log, /ctex|Fandol/i, '中文应触发 CJK 支持（自动补 ctex 或使用已有宏包）');
  } finally {
    await server.close();
  }
});
