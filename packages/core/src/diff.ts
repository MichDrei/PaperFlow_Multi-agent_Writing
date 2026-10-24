/**
 * 纯函数式的行级 diff 引擎（零依赖）。
 *
 * 用途：
 * 1. 模型返回 EditProposal 后，服务端/前端把「原文 vs 替换文本」转成 DiffHunk；
 * 2. 用户在 diff 卡片上逐 hunk 接受/拒绝，再由 applyHunks 生成新文档内容。
 *
 * 之所以放在 core 而不是某个 app 内：它是前后端共享的领域算法。
 */

import type { DiffHunk, DiffLine } from './edit.js';

const MAX_LCS_LINES = 4000;

/** 经典 LCS 回溯；超长文件退化为"整块替换"，保证不会卡死 UI。 */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_LCS_LINES * 64) {
    return [
      ...a.map((text, i) => ({ kind: 'del' as const, text, oldLine: i + 1 })),
      ...b.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]!, oldLine: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]!, newLine: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i]!, oldLine: ++i });
  while (j < m) out.push({ kind: 'add', text: b[j]!, newLine: ++j });
  return out;
}

/**
 * 把两份文本整理成分组后的 hunk 列表。
 * @param context 每个 hunk 前后保留的上下文行数。
 */
export function buildHunks(oldText: string, newText: string, context = 3): DiffHunk[] {
  const diff = lcsDiff(oldText.split('\n'), newText.split('\n'));
  const changed = diff
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => line.kind !== 'context')
    .map(({ idx }) => idx);

  if (changed.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(diff.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map((range, i) => {
    const lines = diff.slice(range.start, range.end + 1);
    const first = lines[0]!;
    const oldStart = first.oldLine ?? 1;
    const newStart = first.newLine ?? 1;
    const oldCount = lines.filter((l) => l.kind !== 'add').length;
    const newCount = lines.filter((l) => l.kind !== 'del').length;
    return {
      id: `hunk-${i + 1}`,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    } satisfies DiffHunk;
  });
}

/**
 * 按用户选择应用 hunk：被接受的 hunk 取新内容，被拒绝的保留原内容。
 * 未出现在 accepted 中的 hunk 视为拒绝。
 */
export function applyHunks(originalText: string, hunks: DiffHunk[], accepted: Iterable<string>): string {
  const acceptedSet = new Set(accepted);
  const original = originalText.split('\n');
  const result: string[] = [];
  let cursor = 0; // 已消费到原文件的行索引（0-based）

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((l) => l.kind !== 'add');
    const firstOld = oldLines[0]?.oldLine;
    if (firstOld === undefined) continue;
    const hunkStart = firstOld - 1;

    // 补上 hunk 未覆盖的原文
    while (cursor < hunkStart) {
      result.push(original[cursor] ?? '');
      cursor++;
    }

    if (acceptedSet.has(hunk.id)) {
      for (const line of hunk.lines) {
        if (line.kind !== 'del') result.push(line.text);
      }
    } else {
      for (const line of hunk.lines) {
        if (line.kind !== 'add') result.push(line.text);
      }
    }
    cursor += oldLines.length;
  }

  while (cursor < original.length) {
    result.push(original[cursor] ?? '');
    cursor++;
  }
  return result.join('\n');
}

/** 统计新增/删除行数，用于卡片上的 "+12 −4" 摘要。 */
export function summarizeHunks(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added++;
      else if (line.kind === 'del') removed++;
    }
  }
  return { added, removed };
}
