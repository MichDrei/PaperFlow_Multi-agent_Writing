/**
 * 多厂商网关的协议级测试。
 *
 * 为什么必须要有：`packages/llm` 里的三个适配器直接手写各家的 HTTP/SSE 协议，
 * 而本地没有（也不该有）真实 API Key。这里用本地 HTTP server 精确复刻三家厂商的
 * 流式响应格式，验证：请求 URL/头/body 是否正确、跨 chunk 的半行 JSON 能否正确拼接、
 * 用量统计是否解析、上游报错是否转成结构化 LlmError、以及未配置时的降级路由。
 *
 * 这套测试的价值：它是"接上真 Key 就能用"这句话唯一的证据来源。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { DEFAULT_MODEL_CATALOG } from '@paperflow/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../apps/server/src/app.js';
import { loadEnv } from '../apps/server/src/env.js';
import {
  AnthropicProvider,
  GoogleProvider,
  LlmError,
  OpenAiCompatibleProvider,
  createGateway,
  supportsVision,
} from '@paperflow/llm';

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

interface Harness {
  baseUrl: string;
  captured: Captured[];
  close: () => Promise<void>;
}

/** 起一个临时 HTTP server，按给定的分片顺序写响应（用于模拟跨 chunk 的半行）。 */
async function startHarness(
  handler: (req: Captured, res: ServerResponse) => void | Promise<void>,
): Promise<Harness> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const record: Captured = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      captured.push(record);
      void handler(record, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取测试服务器端口');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 按给定分片写出 SSE 响应（分片边界刻意切在 JSON 中间）。 */
function writeSse(res: ServerResponse, frames: string[], sliceSize = Number.MAX_SAFE_INTEGER): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const payload = frames.map((f) => `data: ${f}\n\n`).join('');
  for (let i = 0; i < payload.length; i += sliceSize) {
    res.write(payload.slice(i, i + sliceSize));
  }
  res.end();
}

async function collect(stream: AsyncGenerator<{ type: string; text?: string; usage?: unknown }>) {
  let text = '';
  let usage: unknown;
  for await (const chunk of stream) {
    if (chunk.type === 'text') text += chunk.text ?? '';
    if (chunk.type === 'usage') usage = chunk.usage;
  }
  return { text, usage };
}

// ---------------------------------------------------------------- OpenAI 兼容

test('OpenAI 兼容适配器：请求形状正确，且能拼接跨 chunk 的半行 JSON', async () => {
  const harness = await startHarness((_req, res) => {
    writeSse(
      res,
      [
        JSON.stringify({ choices: [{ delta: { content: '投机' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '解码' } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 128, completion_tokens: 7 } }),
        '[DONE]',
      ],
      // 每个分片 7 字节：必然把 JSON 从中间切开，考验解析器的缓冲逻辑
      7,
    );
  });

  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: harness.baseUrl,
      apiKey: 'sk-test-123',
      models: ['deepseek-chat'],
    });

    const { text, usage } = await collect(
      provider.stream({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是审稿人' },
          { role: 'user', content: '请审阅这段' },
        ],
        temperature: 0.2,
      }),
    );

    assert.equal(text, '投机解码', '跨 chunk 的增量应被正确还原');
    assert.deepEqual(usage, { promptTokens: 128, completionTokens: 7 }, '用量应从最后一个 chunk 解析');

    const request = harness.captured[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-test-123');
    assert.equal(request.body.model, 'deepseek-chat');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.temperature, 0.2);
    assert.deepEqual(request.body.messages, [
      { role: 'system', content: '你是审稿人' },
      { role: 'user', content: '请审阅这段' },
    ]);
  } finally {
    await harness.close();
  }
});

test('OpenAI 兼容适配器：上游非 200 时抛出带状态码的 LlmError', async () => {
  const harness = await startHarness((_req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }));
  });

  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'openai',
      label: 'OpenAI',
      baseUrl: harness.baseUrl,
      apiKey: 'sk-test',
      models: ['gpt-4o'],
    });

    await assert.rejects(
      () => collect(provider.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })),
      (err: unknown) => {
        assert.ok(err instanceof LlmError);
        assert.equal(err.code, 'upstream_error');
        assert.equal(err.status, 429);
        assert.match(err.message, /rate limited/);
        return true;
      },
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- Anthropic

test('Anthropic 适配器：system 提升为顶层字段，事件增量与用量正确', async () => {
  const harness = await startHarness((_req, res) => {
    writeSse(res, [
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2048 } } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '这段' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '需要补引用' } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 33 } }),
      JSON.stringify({ type: 'message_stop' }),
    ]);
  });

  try {
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test', baseUrl: harness.baseUrl, models: ['claude-sonnet-4'] });

    const { text, usage } = await collect(
      provider.stream({
        model: 'claude-sonnet-4',
        messages: [
          { role: 'system', content: '你是审稿人' },
          { role: 'user', content: '审阅' },
          { role: 'assistant', content: '上一轮意见' },
          { role: 'user', content: '继续' },
        ],
      }),
    );

    assert.equal(text, '这段需要补引用');
    assert.deepEqual(usage, { promptTokens: 2048, completionTokens: 33 });

    const request = harness.captured[0]!;
    assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], 'sk-ant-test');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.body.system, '你是审稿人', 'system 必须是顶层字段');
    assert.deepEqual(request.body.messages, [
      { role: 'user', content: '审阅' },
      { role: 'assistant', content: '上一轮意见' },
      { role: 'user', content: '继续' },
    ]);
    assert.equal(request.body.stream, true);
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- Google

test('Google 适配器：URL 带 key 与 alt=sse，contents/systemInstruction 映射正确', async () => {
  const harness = await startHarness((req, res) => {
    // 路径里带冒号与查询串，验证我们发出的 URL 形状
    assert.match(req.url, /^\/models\/gemini-2\.5-pro:streamGenerateContent\?alt=sse&key=/);
    writeSse(res, [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '跨章节' }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '不一致' }] } }] }),
      JSON.stringify({ usageMetadata: { promptTokenCount: 999, candidatesTokenCount: 12 } }),
    ]);
  });

  try {
    const provider = new GoogleProvider({ apiKey: 'AIza-test', baseUrl: harness.baseUrl, models: ['gemini-2.5-pro'] });

    const { text, usage } = await collect(
      provider.stream({
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'system', content: '你是方法学家' },
          { role: 'user', content: '检查符号' },
          { role: 'assistant', content: '上一轮' },
        ],
      }),
    );

    assert.equal(text, '跨章节不一致');
    assert.deepEqual(usage, { promptTokens: 999, completionTokens: 12 });

    const request = harness.captured[0]!;
    assert.deepEqual((request.body.systemInstruction as { parts: { text: string }[] }).parts, [
      { text: '你是方法学家' },
    ]);
    assert.deepEqual(request.body.contents, [
      { role: 'user', parts: [{ text: '检查符号' }] },
      { role: 'model', parts: [{ text: '上一轮' }] },
    ]);
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- 网关路由

test('网关路由：按模型 id 选厂商，未配置 Key 的厂商自动降级到本地回退', async () => {
  const gateway = createGateway({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' });

  assert.equal(gateway.providerFor('gpt-4o')?.id, 'openai', '已配置的厂商应被选中');
  assert.equal(gateway.providerFor('claude-sonnet-4'), undefined, '未配置 Anthropic 时不应误报可用');
  assert.equal(gateway.providerFor('ollama-llama'), undefined, '未显式声明 OLLAMA_BASE_URL 时 Ollama 视为未配置');
  assert.equal(gateway.hasRealProvider(), true);

  const annotated = gateway.annotate(DEFAULT_MODEL_CATALOG);
  assert.equal(annotated.find((m) => m.id === 'gpt-4o')?.available, true);
  assert.equal(annotated.find((m) => m.id === 'claude-sonnet-4')?.available, false);

  // 未配置的模型 → 降级到 Mock，但仍然走完整的事件流（不会抛异常）
  const { text } = await collect(gateway.stream('claude-sonnet-4', { messages: [{ role: 'user', content: '你好' }] }));
  assert.match(text, /本地回退回复/, '未配置厂商时应由 Mock 提供方可读地接管');

  const status = gateway.status();
  assert.equal(status.find((p) => p.id === 'mock')?.configured, true);
  assert.equal(status.find((p) => p.id === 'openai')?.configured, true);
  assert.equal(status.find((p) => p.id === 'google')?.configured, false);
});

test('网关路由：未配置的厂商直接调用时抛出 not_configured（而不是静默失败）', async () => {
  const provider = new OpenAiCompatibleProvider({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o'],
  });

  assert.equal(provider.isConfigured(), false);
  await assert.rejects(
    () => collect(provider.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })),
    (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.code, 'not_configured');
      return true;
    },
  );
});

test('网关：Ollama 显式声明地址后即可用（本地推理无需 Key）', () => {
  const gateway = createGateway({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1', OLLAMA_MODELS: 'qwen3:32b' });

  assert.equal(gateway.providerFor('qwen3:32b')?.id, 'ollama');
  assert.equal(gateway.providerFor('llama3.3:70b')?.id, 'ollama', '未知本地模型也应路由到 Ollama');
  assert.equal(gateway.hasRealProvider(), true);
});

// ------------------------------------------------- 配置鲁棒性（Qwen / DeepSeek 等）

test('模型名可用环境变量覆盖：QWEN_MODELS / DEEPSEEK_MODELS 生效并进入前端阵容', () => {
  const gateway = createGateway({
    QWEN_API_KEY: 'sk-qwen',
    QWEN_MODELS: 'qwen3.8-max, qwen-plus',
    DEEPSEEK_API_KEY: 'sk-ds',
    DEEPSEEK_MODELS: 'deepseek-chat',
  });

  const status = gateway.status();
  const qwen = status.find((p) => p.id === 'qwen');
  assert.deepEqual(qwen?.models, ['qwen3.8-max', 'qwen-plus'], '应使用环境变量里的模型名');
  assert.equal(qwen?.modelsOverridden, true);
  assert.equal(status.find((p) => p.id === 'deepseek')?.modelsOverridden, true);
  assert.equal(status.find((p) => p.id === 'openai')?.modelsOverridden, false, '未覆盖时应标记为默认值');

  // 自定义模型名必须能被路由到，否则就会出现"配了 Key 却静默降级到本地回退"
  assert.equal(gateway.providerFor('qwen3.8-max')?.id, 'qwen');
  assert.equal(gateway.providerFor('qwen-plus')?.id, 'qwen');
  assert.equal(gateway.providerFor('deepseek-chat')?.id, 'deepseek');

  // 前端阵容应包含这些自定义模型，且标为可用
  const catalog = gateway.catalog();
  const custom = catalog.find((m) => m.id === 'qwen3.8-max');
  assert.ok(custom, '环境变量声明的模型应出现在阵容里');
  assert.equal(custom!.available, true);
  assert.equal(custom!.provider, 'qwen');
  assert.equal(catalog.find((m) => m.id === 'qwen-plus')?.available, true);
  assert.equal(catalog.find((m) => m.id === 'gpt-4o')?.available, false, '未配置厂商的模型仍不可用');
});

test('DASHSCOPE_API_KEY 是 QWEN_API_KEY 的等价别名（对齐阿里云文档）', () => {
  const viaAlias = createGateway({ DASHSCOPE_API_KEY: 'sk-dashscope' });
  assert.equal(viaAlias.status().find((p) => p.id === 'qwen')?.configured, true);

  const viaQwen = createGateway({ QWEN_API_KEY: 'sk-qwen' });
  assert.equal(viaQwen.status().find((p) => p.id === 'qwen')?.configured, true);

  const qwenStatus = viaQwen.status().find((p) => p.id === 'qwen');
  assert.equal(qwenStatus?.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');

  // 新账号的工作空间域名可通过 QWEN_BASE_URL 覆盖
  const custom = createGateway({ QWEN_API_KEY: 'sk-qwen', QWEN_BASE_URL: 'https://ws-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' });
  assert.match(custom.status().find((p) => p.id === 'qwen')?.baseUrl ?? '', /cn-beijing\.maas\.aliyuncs\.com/);
});

test('DeepSeek 与 Qwen 的默认接入地址符合官方文档', () => {
  const status = createGateway({}).status();
  assert.equal(status.find((p) => p.id === 'deepseek')?.baseUrl, 'https://api.deepseek.com/v1');
  // 默认列表包含各自的视觉模型：deepseek-flash / qwen-vl-max 才能直接看 PDF 页面图
  assert.deepEqual(status.find((p) => p.id === 'deepseek')?.models, [
    'deepseek-chat',
    'deepseek-reasoner',
    'deepseek-flash',
  ]);
  assert.deepEqual(status.find((p) => p.id === 'qwen')?.models, ['qwen-plus', 'qwen-max', 'qwen-vl-max']);
});

test('后端 /api/models 会把厂商声明的自定义模型合并进阵容', async () => {
  const env = loadEnv({
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    CORS_ORIGINS: 'http://127.0.0.1:5273',
  } as NodeJS.ProcessEnv);
  const projectsRoot = mkdtempSync(join(process.cwd(), '.cache', 'provider-projects-'));
  const built = await buildServer({
    env,
    envSource: { DEEPSEEK_API_KEY: 'sk-ds', DEEPSEEK_MODELS: 'deepseek-chat,my-private-model' },
    persistPath: null,
    projectsRoot,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const address = built.app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取端口');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const body = (await (await fetch(`${baseUrl}/api/models`)).json()) as {
      models: { id: string; available: boolean }[];
      hasRealProvider: boolean;
    };
    assert.equal(body.hasRealProvider, true);
    assert.equal(body.models.find((m) => m.id === 'deepseek-chat')?.available, true);
    assert.equal(body.models.find((m) => m.id === 'my-private-model')?.available, true, '自定义模型也要出现在阵容里');
  } finally {
    await built.app.close();
    rmSync(projectsRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 视觉（图像输入）

test('OpenAI 兼容协议：图片以 image_url data URL 形式发送', async () => {
  const harness = await startHarness((_req, res) => {
    writeSse(res, [JSON.stringify({ choices: [{ delta: { content: '看到图了' } }] }), '[DONE]']);
  });
  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'qwen',
      label: 'Qwen',
      baseUrl: harness.baseUrl,
      apiKey: 'sk-test',
      models: ['qwen-vl-max'],
    });
    await collect(
      provider.stream({
        model: 'qwen-vl-max',
        messages: [
          { role: 'system', content: '你是助手' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '看看这份 PDF 的第一页' },
              { type: 'image', mimeType: 'image/jpeg', dataBase64: 'AAAA' },
            ],
          },
        ],
      }),
    );

    const body = harness.captured[0]!.body as { messages: { role: string; content: unknown }[] };
    const user = body.messages.find((m) => m.role === 'user')!;
    assert.ok(Array.isArray(user.content), '有图片时 content 必须是数组（OpenAI 多模态格式）');
    const parts = user.content as { type: string; text?: string; image_url?: { url: string } }[];
    assert.equal(parts[0]!.type, 'text');
    assert.equal(parts[1]!.type, 'image_url');
    assert.equal(parts[1]!.image_url!.url, 'data:image/jpeg;base64,AAAA');
    // system 消息必须仍是纯字符串（部分厂商不接受数组形式的 system）
    assert.equal(typeof body.messages.find((m) => m.role === 'system')!.content, 'string');
  } finally {
    await harness.close();
  }
});

test('Anthropic 协议：图片走 image/source.base64 块', async () => {
  const harness = await startHarness((_req, res) => {
    writeSse(res, [JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } })]);
  });
  try {
    const provider = new AnthropicProvider({ apiKey: 'sk-ant', baseUrl: harness.baseUrl, models: ['claude-sonnet-4'] });
    await collect(
      provider.stream({
        model: 'claude-sonnet-4',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', mimeType: 'image/png', dataBase64: 'BBBB' }] },
        ],
      }),
    );
    const body = harness.captured[0]!.body as { messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] };
    const image = body.messages[0]!.content.find((p) => p.type === 'image')!;
    assert.equal(image.source!.media_type, 'image/png');
    assert.equal(image.source!.data, 'BBBB');
  } finally {
    await harness.close();
  }
});

test('Gemini 协议：图片走 inlineData（REST camelCase）', async () => {
  const harness = await startHarness((_req, res) => {
    writeSse(res, [JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })]);
  });
  try {
    const provider = new GoogleProvider({ apiKey: 'AIza', baseUrl: harness.baseUrl, models: ['gemini-2.5-pro'] });
    await collect(
      provider.stream({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', mimeType: 'image/png', dataBase64: 'CCCC' }] }],
      }),
    );
    const body = harness.captured[0]!.body as { contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[] };
    const inline = body.contents[0]!.parts.find((p) => p.inlineData)!;
    assert.equal(inline.inlineData!.mimeType, 'image/png');
    assert.equal(inline.inlineData!.data, 'CCCC');
  } finally {
    await harness.close();
  }
});

test('视觉能力判定：只有声明 vision 的模型才会收到图片', () => {
  // 依据各家官方文档：DeepSeek 仅 flash 支持图片；Qwen 需要 vl 系列；Gemini/Claude 全线支持
  assert.equal(supportsVision('deepseek-flash'), true);
  assert.equal(supportsVision('deepseek-chat'), false, 'deepseek-chat 是纯文本，发图片会报错');
  assert.equal(supportsVision('deepseek-reasoner'), false);
  assert.equal(supportsVision('qwen-vl-max'), true);
  assert.equal(supportsVision('qwen-plus'), false);
  assert.equal(supportsVision('gemini-2.5-pro'), true);
  assert.equal(supportsVision('claude-sonnet-4'), true);
  assert.equal(supportsVision('gpt-4o'), true);
});

test('OpenAI 兼容网关不认识 stream_options 时，应自动去掉该参数重试一次', async () => {
  let attempts = 0;
  const harness = await startHarness((req, res) => {
    attempts += 1;
    const usesStreamOptions = 'stream_options' in (req.body as Record<string, unknown>);
    if (usesStreamOptions) {
      // 模拟不兼容的网关：直接 400 并点名这个参数
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "Unrecognized request argument: 'stream_options'" } }));
      return;
    }
    writeSse(res, [JSON.stringify({ choices: [{ delta: { content: '去掉参数后成功' } }] }), '[DONE]']);
  });

  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'moonshot',
      label: 'Kimi',
      baseUrl: harness.baseUrl,
      apiKey: 'sk-test',
      models: ['kimi-k3'],
    });
    const { text } = await collect(provider.stream({ model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(text, '去掉参数后成功');
    assert.equal(attempts, 2, '应先失败一次、去掉 stream_options 后重试成功');
    // 第二次请求确实没有带 stream_options
    assert.ok(!('stream_options' in (harness.captured[1]!.body as Record<string, unknown>)));
  } finally {
    await harness.close();
  }
});

test('Kimi 的默认模型名必须是现行可用的（旧名已下线）', () => {
  const status = createGateway({}).status();
  const moonshot = status.find((p) => p.id === 'moonshot');
  assert.deepEqual(moonshot?.models, ['kimi-k3', 'kimi-k2.6']);
  assert.equal(moonshot?.baseUrl, 'https://api.moonshot.cn/v1', 'base_url 应与官方文档一致');
  // 已下线的名字不能再出现在默认列表里，否则用户配好 Key 会直接报"模型不存在"
  assert.ok(!moonshot!.models.includes('kimi-k2'));
  assert.ok(!moonshot!.models.some((m) => m.startsWith('moonshot-v1')));

  // Kimi K3 / K2.6 原生支持视觉，能直接看 PDF 页面图
  assert.equal(supportsVision('kimi-k3'), true);
  assert.equal(supportsVision('kimi-k2.6'), true, 'K2.6 支持视觉输入，可看 PDF 页面图');
});
