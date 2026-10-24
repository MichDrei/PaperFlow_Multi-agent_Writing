/**
 * Google Gemini 适配器（Generative Language API）。
 * 差异点：system 走 systemInstruction、消息叫 contents/parts、流式用 alt=sse。
 */

import type { ModelId, ProviderId } from '@paperflow/core';
import { LlmError, messageImages, messageText, type LlmChunk, type LlmProvider, type LlmRequest } from '../types.js';
import { safeJson, sseLines } from '../stream.js';

interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

export interface GoogleOptions {
  apiKey?: string;
  baseUrl?: string;
  models: ModelId[];
}

export class GoogleProvider implements LlmProvider {
  readonly id: ProviderId = 'google';

  readonly label = 'Google';

  private readonly apiKey: string | undefined;

  private readonly baseUrl: string;

  private readonly models_: ModelId[];

  constructor(options: GoogleOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.models_ = options.models;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  models(): ModelId[] {
    return this.models_;
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
    if (!this.isConfigured()) throw new LlmError('Google 未配置 API Key', 'not_configured');

    const systemText = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => messageText(m))
      .join('\n\n');
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        // Gemini：图片走 inlineData（REST 用 camelCase）
        parts: [
          { text: messageText(m) },
          ...messageImages(m).map((img) => ({
            inlineData: { mimeType: img.mimeType, data: img.dataBase64 },
          })),
        ],
      }));

    const url = `${this.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey!)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
        generationConfig: {
          temperature: req.temperature ?? 0.4,
          maxOutputTokens: req.maxTokens,
        },
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(`Google 返回 ${res.status}：${detail.slice(0, 400)}`, 'upstream_error', res.status);
    }

    let usage: { promptTokens: number; completionTokens: number } | undefined;

    for await (const data of sseLines(res)) {
      const parsed = safeJson<GeminiChunk>(data);
      if (!parsed) continue;
      if (parsed.error) throw new LlmError(parsed.error.message ?? 'Gemini 错误', 'upstream_error');
      for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) yield { type: 'text', text: part.text };
      }
      if (parsed.usageMetadata) {
        usage = {
          promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
          completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
        };
      }
    }

    if (usage) yield { type: 'usage', usage };
  }
}
