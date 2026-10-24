/**
 * 多厂商 LLM 网关的统一抽象。
 *
 * 设计原则：**只依赖各家的 HTTP 接口**，不引入任何官方 SDK。
 * 好处是没有版本锁定、没有隐式重试语义、可以在 Node / Edge / 浏览器里跑同一份代码。
 */

import type { ModelId, ProviderId, Usage } from '@paperflow/core';

/**
 * 消息内容块：文本或图片。
 *
 * 图片用 base64 内联（data URL 形式），因为：
 * - 各家协议都支持内联，不需要先上传再引用；
 * - 服务端不必持有文件存储，与"无状态 BFF"的设计一致。
 * 注意：**图片只能放在 user 消息里**（DeepSeek 明确对 system/assistant 里的图片返回 400）。
 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmContentPart[];
}

/** 取出消息里的纯文本（忽略图片）。 */
export function messageText(message: LlmMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** 取出消息里的图片。 */
export function messageImages(message: LlmMessage): { mimeType: string; dataBase64: string }[] {
  if (typeof message.content === 'string') return [];
  return message.content
    .filter((p): p is { type: 'image'; mimeType: string; dataBase64: string } => p.type === 'image')
    .map((p) => ({ mimeType: p.mimeType, dataBase64: p.dataBase64 }));
}

export interface LlmRequest {
  model: ModelId;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 用于取消：用户点"停止"或连接断开时触发。 */
  signal?: AbortSignal;
}

export type LlmChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Usage }
  /** 厂商特有的原始事件，便于调试与审计。 */
  | { type: 'raw'; payload: unknown };

export interface LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** 该厂商是否已完成配置（有 Key / 有 BaseURL）。 */
  isConfigured(): boolean;
  /** 该厂商负责的模型 id 列表。 */
  models(): ModelId[];
  stream(req: LlmRequest): AsyncGenerator<LlmChunk>;
}

export class LlmError extends Error {
  readonly code: string;

  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}
