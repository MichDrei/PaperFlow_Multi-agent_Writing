/**
 * 流式响应解析工具：把 fetch 的 ReadableStream 切成 SSE 帧或 JSON 行。
 * 所有厂商适配器共用这一份，避免每家写一遍边角处理（跨 chunk 的半行、CRLF、注释行）。
 */

import { LlmError } from './types.js';

/** 逐帧产出 `data:` 负载（OpenAI / Anthropic / Gemini 的 SSE 都用这个）。 */
export async function* sseLines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new LlmError('响应没有 body', 'empty_body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
    if (buffer.trim().length > 0) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
    // 上游如果还没读完就取消，主动断开以释放连接。
    if (res.body.locked) await res.body.cancel().catch(() => undefined);
  }
}

/** 逐行产出 NDJSON（部分自建推理服务使用）。 */
export async function* jsonLines(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new LlmError('响应没有 body', 'empty_body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

export function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
