/**
 * 角色策略：谁在什么情况下扮演什么角色。
 *
 * 多模型协作最容易退化成"几个模型说同样的话"。解决方式不是换模型，
 * 而是给出**互不重叠的系统提示**：撰写者只产出可替换的 LaTeX，
 * 审稿人只挑问题不写代码，方法学家只看符号与假设，编辑只做收敛。
 */

import { AGENT_PROFILES, type AgentRole, type ModelDescriptor } from '@paperflow/core';

/** 编辑类意图需要有人真写文本，其余角色负责审视。 */
export function assignRole(index: number, total: number, hasSelection: boolean, intent: string): AgentRole {
  if (!hasSelection) return 'assistant';
  if (total === 1) return 'author';
  if (intent === 'review' || intent === 'critique') {
    return index === total - 1 ? 'editor' : 'reviewer';
  }
  if (index === 0) return 'author';
  if (index === 1) return 'reviewer';
  if (index === 2) return 'methodologist';
  return 'editor';
}

export function systemPromptFor(role: AgentRole, extraBlocks: string[]): string {
  const profile = AGENT_PROFILES[role];
  return [profile.systemPrompt, ...extraBlocks.filter(Boolean)].join('\n\n');
}

/**
 * 输出合约：要求撰写者把改写结果放进 ```latex 围栏，便于服务端稳定解析成 EditProposal。
 * 这是"模型输出 → 可裁决的结构化提议"之间的桥。
 */
export const AUTHOR_OUTPUT_CONTRACT = [
  '【输出格式（必须严格遵守）】',
  '1. 先用不超过 3 行中文说明你做了什么改动（不要复述原文）。',
  '2. 然后输出一个 ```latex 围栏代码块，内容**只能**是替换后的完整 LaTeX 文本，不要包含任何解释、不要包含原文。',
  '3. 若你认为不应该改动，则不输出代码块，改为说明原因。',
].join('\n');

export function describeModel(model: ModelDescriptor | undefined, fallbackId: string): string {
  if (!model) return fallbackId;
  return `${model.label}（${model.provider}，擅长：${model.strengths.join('、')}）`;
}
