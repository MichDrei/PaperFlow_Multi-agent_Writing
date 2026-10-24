/**
 * 把模型输出解析成结构化的 EditProposal。
 *
 * 模型返回的是自然语言 + 代码块，这里负责稳定地抽出"替换文本"。
 * 三种策略，按可靠性从高到低：
 *   1. ```latex / ```tex 围栏（系统提示里强制的格式）；
 *   2. 任意围栏；
 *   3. 整段文本（仅当意图是改写且输出看起来像 LaTeX）。
 * 抽不出来就返回 undefined —— 宁可"只给建议不生成 diff"，也不要污染用户的论文。
 */

import { buildHunks, type DiffHunk, type EditIntent, type EditProposal, type ModelId } from '@paperflow/core';

export interface ParseInput {
  raw: string;
  modelId: ModelId;
  fileId: string;
  baseVersion: number;
  range: { startLine: number; endLine: number };
  intent: EditIntent;
  /** 应用替换后的完整文件内容，用于生成 diff。 */
  documentContent: string;
}

export interface ParsedProposal {
  proposal: EditProposal;
  hunks: DiffHunk[];
  /** 供 UI 展示的"解释部分"（围栏之外的自然语言）。 */
  commentary: string;
}

const FENCE_RE = /```(latex|tex|LaTeX)?\s*\n([\s\S]*?)```/g;

export function extractLatexBlock(raw: string): string | undefined {
  FENCE_RE.lastIndex = 0;
  let best: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(raw)) !== null) {
    const body = match[2] ?? '';
    // 取最长的代码块：模型有时会先给一小段示例再给完整替换。
    if (!best || body.length > best.length) best = body;
  }
  return best?.trim();
}

function looksLikeLatex(text: string): boolean {
  return /\\[a-zA-Z]+|^[^%]*\{\s*$|\$[^$]+\$/m.test(text);
}

/** 用于重叠度计算的轻量分词（英文按词、中文按二元组，与检索器保持一致的思路）。 */
function looseTokens(text: string): string[] {
  const out: string[] = [];
  for (const part of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue;
    if (/[\u4e00-\u9fff]/.test(part)) {
      const chars = [...part];
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    } else if (part.length > 1) {
      out.push(part);
    }
  }
  return out;
}

/**
 * 从"散文式"回复里挖出替换文本。
 *
 * 为什么需要：系统提示要求撰写者把结果放进 ```latex 围栏，但**真实模型经常不遵守**——
 * 它们会写成"我压缩了…：\n\n<替换文本>"。实测 deepseek-chat / deepseek-reasoner 都这样。
 * 只认围栏的话，用户会看到模型"回答了但没有 diff"，以为功能坏了。
 *
 * 策略：按段落切分，找出与原文**词面重叠度高但内容不同**的那一段。
 * 阈值取 0.6——足够识别"这是在给替换文本"，又不会把普通的评论当成替换。
 */
export function extractReplacementByOverlap(raw: string, selection: string): string | undefined {
  const selTokens = new Set(looseTokens(selection));
  if (selTokens.size < 3) return undefined;

  const paragraphs = raw
    .split(/\n{2,}/)
    .map((p) => p.trim())
    // 去掉 markdown 引用/列表前缀，避免把"1. "这类序号当成正文
    .map((p) => p.replace(/^(?:[>\-*+]|\d+[.)])\s*/gm, '').trim())
    .filter(Boolean);

  let best: { text: string; score: number } | undefined;
  for (const paragraph of paragraphs) {
    const tokens = looseTokens(paragraph);
    if (tokens.length < 4) continue;
    const overlap = tokens.filter((t) => selTokens.has(t)).length / tokens.length;
    if (!best || overlap > best.score) best = { text: paragraph, score: overlap };
  }

  if (!best || best.score < 0.6) return undefined;
  // 与原文相同 = 模型只是把原文抄了一遍，不算改动
  if (best.text.replace(/\s+/g, ' ').trim() === selection.replace(/\s+/g, ' ').trim()) return undefined;
  return best.text;
}

export function parseProposal(input: ParseInput): ParsedProposal | undefined {
  const currentSelection = input.documentContent
    .split('\n')
    .slice(Math.max(0, input.range.startLine - 1), input.range.endLine)
    .join('\n');

  // 三级提取策略（可靠性从高到低）：
  // 1) ```latex 围栏 —— 提示词要求的格式，最可靠；
  // 2) 整段就是 LaTeX —— 模型直接给了代码；
  // 3) 散文里嵌着替换文本 —— 真实模型最常出现的情况，用重叠度识别。
  const fenced = extractLatexBlock(input.raw);
  const plain = !fenced && looksLikeLatex(input.raw) ? input.raw.trim() : undefined;
  const overlapped = !fenced && !plain ? extractReplacementByOverlap(input.raw, currentSelection) : undefined;
  const replacement = (fenced ?? plain ?? overlapped ?? '').replace(/\s+$/, '');

  if (!replacement) return undefined;

  const lines = input.documentContent.split('\n');
  const before = lines.slice(0, Math.max(0, input.range.startLine - 1));
  const after = lines.slice(input.range.endLine);
  const currentText = lines.slice(input.range.startLine - 1, input.range.endLine).join('\n');

  // 两种"不算改动"的情况：
  // 1. 逐字相同 —— 模型只是把原文抄了回来；
  // 2. 只有空白差异且行数不变 —— 同样是回声。
  // 但"重新折行"（行数变化、非空白内容相同）是真实的源码改动，必须保留。
  const sameContent = normalize(currentText) === normalize(replacement);
  const sameLineStructure = countLines(currentText) === countLines(replacement);
  if (sameContent && sameLineStructure) return undefined;

  const updated = [...before, ...replacement.split('\n'), ...after].join('\n');
  const hunks = buildHunks(input.documentContent, updated);
  if (hunks.length === 0) return undefined;

  const commentary = fenced ? input.raw.replace(FENCE_RE, '').trim() : '';

  return {
    proposal: {
      id: `proposal-${Math.random().toString(36).slice(2, 10)}`,
      fileId: input.fileId,
      baseVersion: input.baseVersion,
      range: input.range,
      replacement,
      rationale: commentary.split('\n').filter(Boolean).slice(0, 3).join(' ') || '模型给出的改写建议。',
      modelId: input.modelId,
      intent: input.intent,
      createdAt: new Date().toISOString(),
    },
    hunks,
    commentary,
  };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countLines(text: string): number {
  return text.replace(/\s+$/, '').split('\n').length;
}
