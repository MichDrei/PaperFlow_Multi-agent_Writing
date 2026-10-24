/**
 * 模型与厂商的领域模型。
 * 这是全项目对"一个模型是什么"的唯一权威定义，前端展示、后端路由、网关调用共用。
 */

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'moonshot'
  | 'qwen'
  | 'openrouter'
  | 'ollama'
  | 'mock';

export type ModelId = string;

/** 模型能力标签，编排器据此决定谁能承担哪类任务。 */
export type ModelCapability =
  | 'long-context'
  | 'reasoning'
  | 'code'
  | 'writing'
  | 'review'
  | 'vision'
  | 'cheap';

export interface ModelDescriptor {
  /** 稳定标识，如 `claude-sonnet-4`；同时是 API 请求里的 model 名。 */
  id: ModelId;
  /** 界面展示名。 */
  label: string;
  provider: ProviderId;
  /** 厂商内的家族，用于归组显示（如 gpt / claude / gemini）。 */
  family: string;
  contextWindow: number;
  capabilities: ModelCapability[];
  /** 该模型擅长什么，展示在 @提及菜单中帮助用户选择。 */
  strengths: string[];
  /** UI 主色（hex），用于头像、消息边框、@标记。 */
  accent: string;
  /** 头像文字（1–2 字符）。 */
  initials: string;
  /** 当前是否已配置可用（无 API Key 时为 false）。 */
  available: boolean;
  /** 是否被用户选入当前群聊阵容。 */
  inRoom?: boolean;
}

/** 群聊中模型扮演的角色，决定系统提示词的写法。 */
export type AgentRole =
  | 'author'
  | 'reviewer'
  | 'methodologist'
  | 'editor'
  | 'assistant';

export interface AgentProfile {
  role: AgentRole;
  label: string;
  /** 注入到系统提示中的角色定义。 */
  systemPrompt: string;
  accent: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** 单位：美元。 */
  costUsd?: number;
  latencyMs?: number;
}
