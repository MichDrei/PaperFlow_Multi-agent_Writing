/**
 * 默认模型目录（静态数据，无 IO）。
 * 前后端共用：前端渲染阵容与 @提及菜单，后端据此校验与路由。
 */

import type { AgentProfile, AgentRole, ModelDescriptor } from './model.js';

export const DEFAULT_MODEL_CATALOG: ModelDescriptor[] = [
  {
    id: 'claude-sonnet-4',
    label: 'Claude Sonnet 4',
    provider: 'anthropic',
    family: 'claude',
    contextWindow: 200_000,
    capabilities: ['long-context', 'writing', 'review'],
    strengths: ['长文改写', '学术语气润色', '审稿意见'],
    accent: '#d97757',
    initials: 'CL',
    available: false,
    inRoom: true,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    family: 'gpt',
    contextWindow: 128_000,
    capabilities: ['reasoning', 'writing', 'vision'],
    strengths: ['结构化论证', '图表解读', '多模态'],
    accent: '#10a37f',
    initials: 'G4',
    available: false,
    inRoom: true,
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    provider: 'google',
    family: 'gemini',
    contextWindow: 1_000_000,
    capabilities: ['long-context', 'reasoning', 'vision'],
    strengths: ['超长上下文', '跨章节一致性', '文献综述'],
    accent: '#4285f4',
    initials: 'GE',
    available: false,
    inRoom: true,
  },
  {
    id: 'deepseek-chat',
    label: 'DeepSeek V3',
    provider: 'deepseek',
    family: 'deepseek',
    contextWindow: 64_000,
    capabilities: ['cheap', 'code', 'writing'],
    strengths: ['高性价比', '公式改写', '中文表达'],
    accent: '#4d6bfe',
    initials: 'DS',
    available: false,
    inRoom: true,
  },
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    provider: 'moonshot',
    family: 'kimi',
    contextWindow: 1_000_000,
    capabilities: ['long-context', 'writing', 'vision'],
    strengths: ['中文长文', '资料归纳', '原生视觉'],
    accent: '#8b5cf6',
    initials: 'KM',
    available: false,
    inRoom: false,
  },
  {
    id: 'qwen-plus',
    label: 'Qwen Plus',
    provider: 'qwen',
    family: 'qwen',
    contextWindow: 128_000,
    capabilities: ['reasoning', 'code', 'cheap'],
    strengths: ['数学推导', '中英双语', '代码/脚本'],
    accent: '#615ced',
    initials: 'QW',
    available: false,
    inRoom: false,
  },
];

/**
 * 支持图像输入的模型（与 packages/llm 的 supportsVision 保持一致的判定来源）。
 * 前端据此提示"哪些模型能直接看 PDF 页面图"。
 */
export const VISION_MODEL_IDS = [
  'kimi-k3',
  'kimi-k2.6',
  'deepseek-flash',
  'qwen-vl-max',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'claude-sonnet-4',
  'claude-opus-4-1',
] as const;

export function isVisionModel(modelId: string): boolean {
  return (VISION_MODEL_IDS as readonly string[]).includes(modelId);
}

export const AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  author: {
    role: 'author',
    label: '撰写者',
    accent: '#38bdf8',
    systemPrompt:
      '你是论文撰写者。目标是在保持学术严谨与事实准确的前提下，产出可直接替换原文的 LaTeX 片段。' +
      '只输出可编译的 LaTeX，不要 Markdown 代码围栏，不要额外解释。',
  },
  reviewer: {
    role: 'reviewer',
    label: '审稿人',
    accent: '#f97316',
    systemPrompt:
      '你是顶会审稿人。逐条指出论证漏洞、缺失的对照实验、过强的结论表述与引用不当之处。' +
      '批评必须具体到句子，并给出可执行的修改方向。',
  },
  methodologist: {
    role: 'methodologist',
    label: '方法学家',
    accent: '#a855f7',
    systemPrompt:
      '你是方法论专家。关注符号系统一致性、假设是否显式、公式推导是否可复现、实验协议是否公平。',
  },
  editor: {
    role: 'editor',
    label: '编辑',
    accent: '#22c55e',
    systemPrompt:
      '你是期刊编辑。负责汇总多方意见、消解冲突、维护术语表一致性，并给出最终采纳建议。',
  },
  assistant: {
    role: 'assistant',
    label: '助手',
    accent: '#64748b',
    systemPrompt: '你是通用科研助手，按用户指令回答问题、检索资料或解释概念。',
  },
};

export const DEFAULT_ROOM: string[] = DEFAULT_MODEL_CATALOG.filter((m) => m.inRoom).map((m) => m.id);

export function findModel(catalog: ModelDescriptor[], id: string): ModelDescriptor | undefined {
  return catalog.find((m) => m.id === id);
}
