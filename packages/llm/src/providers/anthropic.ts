/**
 * Anthropic Messages API 适配器。
 * 与 OpenAI 的差异：system 是顶层字段、增量事件在 `content_block_delta`、用量在 `message_delta`。
 */

import type { ModelId, ProviderId } from '@paperflow/core';
import { LlmError, messageImages, messageText, type LlmChunk, type LlmProvider, type LlmRequest } from '../types.js';
import { safeJson, sseLines } from '../stream.js';

interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string; type?: string };
}

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  models: ModelId[];
  /** 覆盖默认的最大输出 token 数。 */
  maxTokens?: number;
}

export class AnthropicProvider implements LlmProvider {
  readonly id: ProviderId = 'anthropic';

  readonly label = 'Anthropic';

  private readonly apiKey: string | undefined;

  private readonly baseUrl: string;

  private readonly models_: ModelId[];

  private readonly maxTokens: number;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.models_ = options.models;
    this.maxTokens = options.maxTokens ?? 8192;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  models(): ModelId[] {
    return this.models_;
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
    if (!this.isConfigured()) throw new LlmError('Anthropic 未配置 API Key', 'not_configured');

    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => messageText(m))
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const images = messageImages(m);
        if (images.length === 0) return { role: m.role, content: messageText(m) };
        // Anthropic：图片走 image block，注意 media_type 必填
        return {
          role: m.role,
          content: [
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 },
            })),
            { type: 'text', text: messageText(m) },
          ],
        };
      });

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? this.maxTokens,
        temperature: req.temperature ?? 0.4,
        system: system || undefined,
        messages,
        stream: true,
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(`Anthropic 返回 ${res.status}：${detail.slice(0, 400)}`, 'upstream_error', res.status);
    }

    let promptTokens = 0;
    let completionTokens = 0;

    for await (const data of sseLines(res)) {
      const event = safeJson<AnthropicEvent>(data);
      if (!event) continue;
      switch (event.type) {
        case 'content_block_delta':
          if (event.delta?.text) yield { type: 'text', text: event.delta.text };
          break;
        case 'message_start':
          promptTokens = event.message?.usage?.input_tokens ?? 0;
          break;
        case 'message_delta':
          completionTokens = event.usage?.output_tokens ?? completionTokens;
          break;
        case 'error':
          throw new LlmError(event.error?.message ?? 'Anthropic 流错误', 'upstream_error');
        default:
          break;
      }
    }

    yield { type: 'usage', usage: { promptTokens, completionTokens } };
  }
}
