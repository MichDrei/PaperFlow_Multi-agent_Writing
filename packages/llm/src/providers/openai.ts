/**
 * OpenAI 兼容协议适配器。
 *
 * 一个适配器覆盖：OpenAI、DeepSeek、Moonshot(Kimi)、Qwen(DashScope 兼容模式)、
 * OpenRouter、Groq、以及本地 Ollama / vLLM / SGLang。它们共用
 * `POST {baseUrl}/chat/completions` 与相同的 SSE 增量格式。
 */

import type { ModelId, ProviderId } from '@paperflow/core';
import { LlmError, messageImages, messageText, type LlmChunk, type LlmProvider, type LlmRequest } from '../types.js';
import { safeJson, sseLines } from '../stream.js';

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey?: string;
  models: ModelId[];
  /** 部分服务（如 Ollama）不需要 Key。 */
  requiresApiKey?: boolean;
  /** 额外请求头，例如 OpenRouter 的 HTTP-Referer。 */
  extraHeaders?: Record<string, string>;
}

interface OpenAiDelta {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;

  readonly label: string;

  protected readonly baseUrl: string;

  protected readonly apiKey: string | undefined;

  protected readonly models_: ModelId[];

  private readonly requiresApiKey: boolean;

  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.models_ = options.models;
    this.requiresApiKey = options.requiresApiKey ?? true;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  isConfigured(): boolean {
    if (!this.requiresApiKey) return Boolean(this.baseUrl);
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  models(): ModelId[] {
    return this.models_;
  }

  /**
   * 参数兼容性降级。
   *
   * OpenAI 兼容只是"大致兼容"：不同厂商对可选参数各有脾气。实测过的例子：
   * - Kimi K3（思考模型）**只接受 temperature=1**，传 0.4 直接 400
   *   `invalid temperature: only 1 is allowed for this model`；
   * - 部分自建网关不认识 `stream_options`，收到就 400。
   *
   * 这两个参数都只是"锦上添花"（采样温度、token 用量统计），不值得让整条请求失败。
   * 因此按下面的顺序逐级降级，并且**把结论记在本实例上**——同一模型下一次不再重复踩，
   * 避免每次调用都白跑一个失败请求。
   */
  private readonly modelsRejectingTemperature = new Set<string>();

  private readonly modelsRejectingStreamOptions = new Set<string>();

  async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
    if (!this.isConfigured()) {
      throw new LlmError(`${this.label} 未配置 API Key`, 'not_configured');
    }

    // 自适应降级：从"两个参数都带"开始，**只关掉上游明确拒绝的那个**再重试。
    // 不写成固定阶梯，是为了避免"因为 A 参数失败却顺手也把 B 参数去掉"这种浪费一次往返的做法。
    let includeUsage = !this.modelsRejectingStreamOptions.has(req.model);
    let includeTemperature = !this.modelsRejectingTemperature.has(req.model);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        yield* this.streamOnce(req, { includeUsage, includeTemperature });
        return;
      } catch (err) {
        lastError = err;
        // 只有"参数不被接受"这一类 400 才值得降级重试，其它错误原样抛出
        if (!(err instanceof LlmError) || err.status !== 400) throw err;
        const message = err.message;
        if (includeTemperature && /temperature/i.test(message)) {
          includeTemperature = false;
          this.modelsRejectingTemperature.add(req.model);
          continue;
        }
        if (includeUsage && /stream_options/i.test(message)) {
          includeUsage = false;
          this.modelsRejectingStreamOptions.add(req.model);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async *streamOnce(
    req: LlmRequest,
    options: { includeUsage: boolean; includeTemperature: boolean },
  ): AsyncGenerator<LlmChunk> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: req.model,
        // 有图片时按 OpenAI 的多模态格式展开：content 变成 [{type:'text'},{type:'image_url'}]
        messages: req.messages.map((m) => {
          const images = messageImages(m);
          if (images.length === 0) return { role: m.role, content: messageText(m) };
          return {
            role: m.role,
            content: [
              { type: 'text', text: messageText(m) },
              ...images.map((img) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
              })),
            ],
          };
        }),
        // 某些模型（如 Kimi K3）只允许 temperature=1，此时干脆不带该参数
        ...(options.includeTemperature ? { temperature: req.temperature ?? 0.4 } : {}),
        max_tokens: req.maxTokens,
        stream: true,
        ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LlmError(
        `${this.label} 返回 ${res.status}：${detail.slice(0, 400)}`,
        'upstream_error',
        res.status,
      );
    }

    let usage: { promptTokens: number; completionTokens: number } | undefined;

    for await (const data of sseLines(res)) {
      if (data === '[DONE]') break;
      const parsed = safeJson<OpenAiDelta>(data);
      if (!parsed) continue;
      if (parsed.error) throw new LlmError(parsed.error.message ?? '上游错误', 'upstream_error');
      const text = parsed.choices?.[0]?.delta?.content;
      if (text) yield { type: 'text', text };
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
    }

    if (usage) yield { type: 'usage', usage };
  }
}
