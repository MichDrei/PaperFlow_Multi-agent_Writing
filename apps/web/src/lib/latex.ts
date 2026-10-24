/** LaTeX 源码的轻量静态分析：大纲、标签、引用、行范围。 */

import { normalizeEol } from '@paperflow/core';

export interface OutlineItem {
  level: 1 | 2 | 3;
  title: string;
  line: number;
}

const SECTION_RE = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;

export function extractOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const content = normalizeEol(source);
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    SECTION_RE.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = SECTION_RE.exec(line)) !== null) {
      const cmd = hit[1] ?? 'section';
      items.push({
        level: cmd === 'section' ? 1 : cmd === 'subsection' ? 2 : 3,
        title: (hit[2] ?? '').trim(),
        line: idx + 1,
      });
    }
  });
  return items;
}

export interface LabelRef {
  label: string;
  line: number;
}

export function extractLabels(content: string): LabelRef[] {
  const out: LabelRef[] = [];
  content.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(/\\label\{([^}]*)\}/g)) out.push({ label: m[1] ?? '', line: idx + 1 });
  });
  return out;
}

export function extractCitationKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const m of content.matchAll(/\\(?:cite|citep|citet|autocite)\{([^}]*)\}/g)) {
    for (const k of (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) keys.add(k);
  }
  return [...keys];
}

/** 把 1-based 行范围替换为 newText。 */
export function replaceLineRange(
  content: string,
  startLine: number,
  endLine: number,
  newText: string,
): string {
  const lines = content.split('\n');
  const before = lines.slice(0, Math.max(0, startLine - 1));
  const after = lines.slice(Math.max(0, endLine));
  return [...before, ...newText.split('\n'), ...after].join('\n');
}

export function getLineRange(content: string, startLine: number, endLine: number): string {
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

/** 找到第 line 行所属的 section 标题，用于在群聊里给出"你在改哪一节"的上下文。 */
export function sectionAtLine(content: string, line: number): OutlineItem | undefined {
  const outline = extractOutline(content);
  let current: OutlineItem | undefined;
  for (const item of outline) {
    if (item.line <= line) current = item;
    else break;
  }
  return current;
}
