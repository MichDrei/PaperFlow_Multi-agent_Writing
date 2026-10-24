/**
 * 术语一致性检查：科研写作里最容易被多模型协作破坏的东西——同一个概念被不同模型
 * 译成不同说法。所有模型的输出都要过这一关。
 */

import type { TerminologyEntry } from '@paperflow/core';

export interface TerminologyViolation {
  entryId: string;
  /** 正文中出现的违规写法。 */
  found: string;
  suggestion: string;
  line: number;
  column: number;
}

export function checkTerminology(
  text: string,
  entries: TerminologyEntry[],
): TerminologyViolation[] {
  const violations: TerminologyViolation[] = [];
  const lines = text.split('\n');
  for (const entry of entries) {
    if (entry.locked === false) continue;
    for (const banned of entry.forbidden) {
      if (!banned) continue;
      lines.forEach((lineText, idx) => {
        const col = lineText.indexOf(banned);
        if (col >= 0) {
          violations.push({
            entryId: entry.id,
            found: banned,
            suggestion: entry.translation || entry.term,
            line: idx + 1,
            column: col + 1,
          });
        }
      });
    }
  }
  return violations;
}

/**
 * 生成注入到系统提示中的术语约束块。
 * 只注入与被处理片段相关的词条，避免污染上下文。
 */
export function terminologyPromptBlock(entries: TerminologyEntry[], relevantText?: string): string {
  const selected = relevantText
    ? entries.filter(
        (e) =>
          relevantText.includes(e.term) ||
          relevantText.includes(e.translation) ||
          e.forbidden.some((f) => relevantText.includes(f)),
      )
    : entries;
  const active = selected.length > 0 ? selected : entries.slice(0, 12);
  if (active.length === 0) return '';
  const rows = active.map(
    (e) => `- ${e.term} → ${e.translation}（禁用：${e.forbidden.join('、') || '无'}）`,
  );
  return `【术语表（必须严格遵守，禁止使用"禁用"列中的写法）】\n${rows.join('\n')}`;
}

export function findEntry(entries: TerminologyEntry[], text: string): TerminologyEntry | undefined {
  return entries.find(
    (e) => e.term === text || e.translation === text || e.forbidden.includes(text),
  );
}
