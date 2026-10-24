/**
 * 网关：把"模型 id"解析到具体厂商适配器，并在厂商未配置时降级到 Mock。
 *
 * 设计要点：
 * 1. 新增一个厂商 = 在这里加一行；调用方（编排器）完全不需要改动。
 * 2. **模型名一律可用环境变量覆盖**（如 `QWEN_MODELS=qwen3.8-max,qwen-plus`）。
 *    厂商改模型名、或账号只开通了部分模型时，不需要改代码——这一点很重要：
 *    "配置了 Key 却因为模型名写错而静默降级到本地回退"是最难排查的坑。
 * 3. `catalog()` 会把厂商声明的模型合并进前端阵容，因此自定义模型名也会出现在 UI 里。
 */

import { DEFAULT_MODEL_CATALOG, type ModelDescriptor, type ModelId, type ProviderId } from '@paperflow/core';
import type { LlmChunk, LlmProvider, LlmRequest } from './types.js';
import { LlmError } from './types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { OpenAiCompatibleProvider } from './providers/openai.js';
import { MockProvider } from './providers/mock.js';

export type GatewayEnv = Record<string, string | undefined>;

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  models: ModelId[];
  /** 模型名来自环境变量覆盖（而非代码默认值）。 */
  modelsOverridden?: boolean;
  /** 实际生效的接入地址（不含密钥），便于排查 region / 代理问题。 */
  baseUrl?: string;
}

/** 各厂商的默认模型列表（可被 `<PROVIDER>_MODELS` 覆盖）。 */
const DEFAULT_MODELS: Record<string, ModelId[]> = {
  anthropic: ['claude-sonnet-4', 'claude-opus-4-1', 'claude-3-7-sonnet', 'claude-3-5-haiku'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  // deepseek-flash 是 DeepSeek 目前唯一支持图像输入的模型（官方文档 2026-09）
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'],
  // 2026-09 核对：kimi-k2 / moonshot-v1 系列均已下线，现行可用的是 k3 与 k2.6/k2.7
  // kimi-k3 是旗舰（100 万上下文 + 原生视觉）且实测可用，放前面（自检默认测第一个模型）。
  // 若某账号返回 "Not found the model kimi-k3 or Permission denied"，
  // 用 `npm run check:models -- --discover` 看该账号真实可用的名字再覆盖。
  moonshot: ['kimi-k3', 'kimi-k2.6'],
  // qwen-vl-* 支持图像输入；qwen-plus/max 是纯文本
  qwen: ['qwen-plus', 'qwen-max', 'qwen-vl-max'],
  openrouter: [],
  ollama: [],
};

/** 为"目录里没登记、但厂商声明了"的模型合成一份展示信息。 */
const PROVIDER_PRESENTATION: Record<
  ProviderId,
  { family: string; accent: string; contextWindow: number; strengths: string[] }
> = {
  anthropic: { family: 'claude', accent: '#d97757', contextWindow: 200_000, strengths: ['长文改写', '学术语气润色', '审稿意见'] },
  openai: { family: 'gpt', accent: '#10a37f', contextWindow: 128_000, strengths: ['结构化论证', '图表解读', '多模态'] },
  google: { family: 'gemini', accent: '#4285f4', contextWindow: 1_000_000, strengths: ['超长上下文', '跨章节一致性'] },
  deepseek: { family: 'deepseek', accent: '#4d6bfe', contextWindow: 64_000, strengths: ['高性价比', '公式改写', '中文表达'] },
  moonshot: { family: 'kimi', accent: '#8b5cf6', contextWindow: 1_000_000, strengths: ['中文长文', '资料归纳', '原生视觉'] },
  qwen: { family: 'qwen', accent: '#615ced', contextWindow: 128_000, strengths: ['数学推导', '中英双语', '代码脚本'] },
  openrouter: { family: 'openrouter', accent: '#94a3b8', contextWindow: 128_000, strengths: ['多厂商聚合路由'] },
  ollama: { family: 'ollama', accent: '#eab308', contextWindow: 32_000, strengths: ['本地推理', '数据不出机器'] },
  mock: { family: 'mock', accent: '#64748b', contextWindow: 8_000, strengths: ['离线回退', '链路自检'] },
};

/**
 * 判断某个模型是否支持图像输入。
 *
 * 依据各家官方文档（2026-09 核对）：
 * - DeepSeek：仅 `deepseek-flash` 支持图片，且图片只能放在 user 消息里；
 * - Qwen：`qwen-vl-*` / `qwen3-vl-*` 支持图片（兼容模式走 image_url）；
 * - OpenAI：gpt-4o / gpt-4.1 / o 系列支持图片；
 * - Gemini / Claude：全线支持图片，且原生支持 PDF。
 * 纯文本模型收到图片会被忽略或直接报 400，所以必须在发送前判断。
 */
export function supportsVision(modelId: ModelId): boolean {
  const id = modelId.toLowerCase();
  return (
    // Kimi K3 原生支持视觉、K2.6 支持视觉输入；k2.7-code 是编程模型（按纯文本处理更安全）
    /^kimi-(k3|k2\.6)/.test(id) ||
    /^deepseek-(flash|v\d.*flash|vl)/.test(id) ||
    /vl|omni/.test(id) ||
    /^(gpt-4o|gpt-4\.1|gpt-5|o[134])/.test(id) ||
    /^gemini/.test(id) ||
    /^claude/.test(id)
  );
}

function modelsFromEnv(env: GatewayEnv, key: string, provider: string): { models: ModelId[]; overridden: boolean } {
  const parsed = (env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parsed.length > 0) return { models: parsed, overridden: true };
  return { models: DEFAULT_MODELS[provider] ?? [], overridden: false };
}

function synthesizeDescriptor(id: ModelId, provider: ProviderId): ModelDescriptor {
  const presentation = PROVIDER_PRESENTATION[provider];
  const initials = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'AI';
  return {
    id,
    label: id,
    provider,
    family: presentation.family,
    contextWindow: presentation.contextWindow,
    capabilities: supportsVision(id) ? ['writing', 'vision'] : ['writing'],
    strengths: presentation.strengths,
    accent: presentation.accent,
    initials,
    available: false,
    inRoom: false,
  };
}

/** 依据环境变量装配全部提供方。 */
export function buildProviders(env: GatewayEnv): LlmProvider[] {
  const catalogIds = DEFAULT_MODEL_CATALOG.map((m) => m.id);

  const anthropic = modelsFromEnv(env, 'ANTHROPIC_MODELS', 'anthropic');
  const openai = modelsFromEnv(env, 'OPENAI_MODELS', 'openai');
  const google = modelsFromEnv(env, 'GOOGLE_MODELS', 'google');
  const deepseek = modelsFromEnv(env, 'DEEPSEEK_MODELS', 'deepseek');
  const moonshot = modelsFromEnv(env, 'MOONSHOT_MODELS', 'moonshot');
  const qwen = modelsFromEnv(env, 'QWEN_MODELS', 'qwen');
  const openrouter = modelsFromEnv(env, 'OPENROUTER_MODELS', 'openrouter');
  const ollama = modelsFromEnv(env, 'OLLAMA_MODELS', 'ollama');

  return [
    new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL,
      models: anthropic.models,
    }),
    new OpenAiCompatibleProvider({
      id: 'openai',
      label: 'OpenAI',
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
      models: openai.models,
    }),
    new GoogleProvider({
      apiKey: env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY,
      baseUrl: env.GOOGLE_BASE_URL,
      models: google.models,
    }),
    new OpenAiCompatibleProvider({
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
      apiKey: env.DEEPSEEK_API_KEY,
      models: deepseek.models,
    }),
    new OpenAiCompatibleProvider({
      id: 'moonshot',
      label: 'Moonshot (Kimi)',
      baseUrl: env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.cn/v1',
      apiKey: env.MOONSHOT_API_KEY,
      models: moonshot.models,
    }),
    new OpenAiCompatibleProvider({
      id: 'qwen',
      label: 'Qwen (DashScope)',
      // 默认走阿里云百炼的兼容模式（旧域名，仍可用）。
      // 新账号建议改用工作空间域名：
      //   北京   https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
      //   新加坡 https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
      // 注意：API Key 与地域绑定，跨地域调用会返回 401 invalid_api_key。
      baseUrl: env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: env.QWEN_API_KEY ?? env.DASHSCOPE_API_KEY,
      models: qwen.models,
    }),
    new OpenAiCompatibleProvider({
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      apiKey: env.OPENROUTER_API_KEY,
      models: openrouter.models,
      extraHeaders: { 'HTTP-Referer': env.APP_URL ?? 'http://localhost:5273', 'X-Title': 'PaperFlow' },
    }),
    new OpenAiCompatibleProvider({
      id: 'ollama',
      label: 'Ollama (local)',
      // 刻意不设默认地址：否则任何机器上都会被判定为"已配置"，
      // 进而把真实请求打到不存在的本地端口。必须显式声明才算启用。
      baseUrl: env.OLLAMA_BASE_URL ?? '',
      models: ollama.models,
      requiresApiKey: false,
    }),
    // 永远可用的兜底：保证无 Key 环境下 SSE 链路仍可端到端验证。
    new MockProvider(catalogIds),
  ].map((provider) => {
    // 把"哪些模型来自环境变量覆盖"记在 provider 上，供 /api/models 展示。
    const table: Record<string, boolean> = {
      anthropic: anthropic.overridden,
      openai: openai.overridden,
      google: google.overridden,
      deepseek: deepseek.overridden,
      moonshot: moonshot.overridden,
      qwen: qwen.overridden,
      openrouter: openrouter.overridden,
      ollama: ollama.overridden,
    };
    return Object.assign(provider, { modelsOverridden: table[provider.id] ?? false });
  });
}

const PREFIX_MAP: [RegExp, ProviderId][] = [
  [/^claude/i, 'anthropic'],
  [/^(gpt|o1|o3|o4|chatgpt)/i, 'openai'],
  [/^gemini/i, 'google'],
  [/^deepseek/i, 'deepseek'],
  [/^(kimi|moonshot)/i, 'moonshot'],
  [/^(qwen|qwq|qvq)/i, 'qwen'],
  [/^(llama|mistral|phi|gemma)/i, 'ollama'],
];

export class LlmGateway {
  private readonly providers: LlmProvider[];

  private readonly fallback: LlmProvider;

  constructor(providers: LlmProvider[]) {
    this.providers = providers;
    this.fallback = providers.find((p) => p.id === 'mock') ?? new MockProvider([]);
  }

  /** 找出负责该模型的提供方；未知模型按前缀猜测。 */
  providerFor(modelId: ModelId): LlmProvider | undefined {
    const declared = this.providers.find(
      (p) => p.id !== 'mock' && p.models().includes(modelId) && p.isConfigured(),
    );
    if (declared) return declared;
    const byPrefix = PREFIX_MAP.find(([re]) => re.test(modelId));
    if (!byPrefix) return undefined;
    return this.providers.find((p) => p.id === byPrefix[1] && p.isConfigured());
  }

  status(): ProviderStatus[] {
    return this.providers.map((p) => ({
      id: p.id,
      label: p.label,
      configured: p.isConfigured(),
      models: p.models(),
      modelsOverridden: Boolean((p as { modelsOverridden?: boolean }).modelsOverridden),
      baseUrl: (p as { baseUrl?: string }).baseUrl,
    }));
  }

  /** 只做可用性标注，不合并模型。 */
  annotate(catalog: ModelDescriptor[] = DEFAULT_MODEL_CATALOG): ModelDescriptor[] {
    return catalog.map((model) => ({
      ...model,
      available: Boolean(this.providerFor(model.id)),
      // 视觉能力按模型名判定，并写进 capabilities，供前端提示"哪些模型能看 PDF 图像"
      capabilities: supportsVision(model.id)
        ? [...new Set([...model.capabilities, 'vision' as const])]
        : model.capabilities.filter((c) => c !== 'vision'),
    }));
  }

  /**
   * 给前端的完整阵容：静态目录 + 厂商声明的模型（含环境变量自定义的），并标注可用性。
   * 这样 `QWEN_MODELS=qwen3.8-max` 会直接出现在 UI 的模型列表里，而不是"配了 Key 却看不见"。
   */
  catalog(base: ModelDescriptor[] = DEFAULT_MODEL_CATALOG): ModelDescriptor[] {
    const merged = new Map<ModelId, ModelDescriptor>();
    for (const model of base) merged.set(model.id, model);
    for (const provider of this.providers) {
      if (provider.id === 'mock') continue;
      for (const id of provider.models()) {
        if (!merged.has(id)) merged.set(id, synthesizeDescriptor(id, provider.id));
      }
    }
    return this.annotate([...merged.values()]);
  }

  /** 至少有一个真实厂商可用（Mock 不算）。 */
  hasRealProvider(): boolean {
    return this.providers.some((p) => p.id !== 'mock' && p.isConfigured());
  }

  /**
   * 流式调用。未配置的模型自动降级到 Mock 提供方，并保留原始 model id，
   * 这样前端仍能正确显示是哪个模型"应该"回答。
   */
  async *stream(modelId: ModelId, req: Omit<LlmRequest, 'model'>): AsyncGenerator<LlmChunk> {
    const provider = this.providerFor(modelId) ?? this.fallback;
    try {
      yield* provider.stream({ ...req, model: modelId });
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError(err instanceof Error ? err.message : '未知调用错误', 'internal');
    }
  }
}

export function createGateway(env: GatewayEnv = process.env): LlmGateway {
  return new LlmGateway(buildProviders(env));
}
