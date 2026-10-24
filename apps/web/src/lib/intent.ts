/** 从自然语言指令推断编辑意图。UI 与 mock 引擎共用，后端也会用同一套规则兜底。 */

import type { EditIntent } from '@paperflow/core';

export function inferIntent(instruction: string): EditIntent {
  const s = instruction.toLowerCase();
  if (/压缩|精简|缩短|紧凑|tighten|concise|shorten|trim/.test(s)) return 'tighten';
  if (/润色|语气|通顺|polish|rephrase|fluency/.test(s)) return 'polish';
  if (/扩写|补充|展开|expand|elaborate/.test(s)) return 'expand';
  if (/翻译|translate/.test(s)) return 'translate';
  if (/审|挑错|批评|批判|review|critique|check/.test(s)) return 'review';
  return 'rewrite';
}

export const INTENT_LABEL: Record<EditIntent, string> = {
  rewrite: '改写',
  tighten: '压缩',
  polish: '润色',
  translate: '翻译',
  expand: '扩写',
  review: '评审',
  critique: '批判性评审',
};

export function intentLabel(intent: EditIntent): string {
  return INTENT_LABEL[intent];
}

export const INTENT_ACTIONS: { intent: EditIntent; label: string; hint: string }[] = [
  { intent: 'tighten', label: '压缩', hint: '删冗余、保留全部事实' },
  { intent: 'polish', label: '润色', hint: '学术语气与标点' },
  { intent: 'rewrite', label: '改写', hint: '重写以提升清晰度' },
  { intent: 'expand', label: '扩写', hint: '补充论证与交叉引用' },
  { intent: 'review', label: '评审', hint: '只挑问题，不改写' },
];
