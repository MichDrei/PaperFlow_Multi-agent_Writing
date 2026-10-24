#!/usr/bin/env node
/**
 * 本地假厂商（OpenAI 兼容协议），用于**零成本**验证真实接入路径。
 *
 * 它实现 `POST /v1/chat/completions`（含 SSE 流式），因此可以当作 OpenAI / DeepSeek /
 * Qwen / Moonshot 的替身：
 *
 *   # 终端 1
 *   node scripts/fake-provider.mjs            # 监听 127.0.0.1:8899
 *
 *   # 终端 2：把 DeepSeek 和 Qwen 都指过来，跑一次自检
 *   DEEPSEEK_API_KEY=fake DEEPSEEK_BASE_URL=http://127.0.0.1:8899/v1 \
 *   QWEN_API_KEY=fake     QWEN_BASE_URL=http://127.0.0.1:8899/v1 \
 *   npm run check:models
 *
 *   # 或者端到端跑一遍 UI（顶栏会显示「真实模型 · deepseek/qwen」）
 *   DEEPSEEK_API_KEY=fake DEEPSEEK_BASE_URL=http://127.0.0.1:8899/v1 \
 *   QWEN_API_KEY=fake     QWEN_BASE_URL=http://127.0.0.1:8899/v1 \
 *   npm run dev:server
 *
 * 可选参数：
 *   --port 8899          监听端口
 *   --reject-model <名>  对该模型返回 400 model_not_found（用于验证自检脚本的报错提示）
 *   --quiet              不打印每次请求
 *
 * 它是"接上真 Key 就能用"这句话的活证据：如果 UI 能从这里拿到流式回复并生成 diff，
 * 那么换成真厂商只是换 base URL 和 Key 的事。
 */

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8899;
const rejectIdx = args.indexOf('--reject-model');
const rejectModel = rejectIdx >= 0 ? args[rejectIdx + 1] : undefined;
const quiet = args.includes('--quiet');

const SELECTION_RE = /【待处理文本】\n([\s\S]*?)(?=\n\n【|$)/;
const AUTHOR_MARK = '【输出格式（必须严格遵守）】';

/** 生成回复正文：撰写者角色要给 ```latex 围栏，才能被解析成可应用的 diff。 */
function buildReply(messages, model) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const selection = SELECTION_RE.exec(system)?.[1]?.trim();

  if (system.includes(AUTHOR_MARK) && selection) {
    // 加一行注释作为确定性改动，保证能算出 1 个 hunk 的 diff
    const replacement = `% rewritten by ${model} via fake-provider\n${selection}`;
    return [
      `我在这段前面加了一行来源注释，方便你在 diff 里确认提议来自 ${model}。`,
      '',
      '```latex',
      replacement,
      '```',
    ].join('\n');
  }

  return [
    `**${model}** 已收到请求（fake-provider 应答）。`,
    '',
    `- 消息数：${messages.length}`,
    `- 系统提示长度：${system.length} 字符`,
    `- 用户指令：${user.slice(0, 80)}`,
    '',
    '> 这是本地假厂商，用于验证接入链路；换成真实 base URL 与 Key 即可获得真实回复。',
  ].join('\n');
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json', type: 'invalid_request_error' } }));
      return;
    }

    const model = body.model ?? 'unknown';
    const auth = req.headers.authorization ? 'with-key' : 'no-key';
    if (!quiet) {
      console.log(`[fake-provider] model=${model} stream=${Boolean(body.stream)} ${auth} messages=${body.messages?.length ?? 0}`);
    }

    // 模拟"模型名不存在"，用于验证自检脚本能否把这类错误说清楚
    if (rejectModel && model === rejectModel) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Model not exist: ${model}`, type: 'invalid_request_error', code: 'model_not_found' },
        }),
      );
      return;
    }

    const reply = buildReply(body.messages ?? [], model);

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 42, completion_tokens: reply.length },
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const frame = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', model };

    // 按 8 字符切片推送，与真实厂商的增量粒度接近
    const step = 8;
    let i = 0;
    const pump = () => {
      if (i >= reply.length) {
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        frame({ ...base, choices: [], usage: { prompt_tokens: 42, completion_tokens: reply.length } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      frame({ ...base, choices: [{ index: 0, delta: { content: reply.slice(i, i + step) }, finish_reason: null }] });
      i += step;
      setTimeout(pump, 6);
    };
    pump();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-provider 已启动：http://127.0.0.1:${port}/v1`);
  console.log('把它当作任意 OpenAI 兼容厂商使用，例如：');
  console.log(`  DEEPSEEK_API_KEY=fake DEEPSEEK_BASE_URL=http://127.0.0.1:${port}/v1 npm run check:models`);
  if (rejectModel) console.log(`（会对模型 ${rejectModel} 返回 model_not_found）`);
});
