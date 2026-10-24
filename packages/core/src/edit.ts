/**
 * 编辑选区和"改写提议 → diff → 应用"的领域模型。
 * 这是 Cursor 式交互的契约：模型永远不直接改文档，只提交 EditProposal，由人裁决后应用。
 */

import type { FileId } from './document.js';
import type { ModelId } from './model.js';

export interface Position {
  line: number;
  column: number;
}

/** 编辑器中被选中的片段（1-based 行列，与 Monaco 一致）。 */
export interface Selection {
  fileId: FileId;
  start: Position;
  end: Position;
  /** 选中的原始文本，发送给模型时直接使用。 */
  text: string;
}

export type EditIntent =
  | 'rewrite'
  | 'tighten'
  | 'polish'
  | 'translate'
  | 'expand'
  | 'review'
  | 'critique';

/** 模型提出的一次编辑：替换 [startLine, endLine] 的整行区间。 */
export interface EditProposal {
  id: string;
  fileId: FileId;
  /** 提议基于的文件版本；应用时若文件版本已变则要求用户重新确认。 */
  baseVersion: number;
  range: { startLine: number; endLine: number };
  replacement: string;
  rationale: string;
  modelId: ModelId;
  intent: EditIntent;
  createdAt: string;
}

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 原文件行号（add 行为 undefined）。 */
  oldLine?: number;
  /** 新文件行号（del 行为 undefined）。 */
  newLine?: number;
}

export interface DiffHunk {
  id: string;
  header: string;
  lines: DiffLine[];
}

/** diff 卡片的状态机。 */
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'partial' | 'stale';

export interface ApplyResult {
  fileId: FileId;
  fromVersion: number;
  toVersion: number;
  appliedHunkIds: string[];
  rejectedHunkIds: string[];
}
