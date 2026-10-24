/**
 * @提及解析：把"@claude 帮我压一下这段" 变成 { targets, instruction }。
 *
 * 这里是纯函数（无 IO、无状态），所以前端可以直接用它做输入框高亮与预校验，
 * 后端也用同一份实现做权威路由——避免"前端显示 @ 了 3 个模型，后端只跑了 2 个"。
 * 服务端专属的策略（并发上限、角色分配、轮次控制）在 packages/agents 里。
 */

import type { ModelDescriptor, ModelId } from './model.js';

export interface ResolvedMentions {
  /** 解析出的目标模型（去重、保持出现顺序）。 */
  targets: ModelId[];
  /** 写了 @ 但无法匹配任何模型的字样。 */
  unknown: string[];
  /** 是否需要全员响应（@all / @everyone）。 */
  broadcast: boolean;
  /** 去掉 @提及 后的指令正文。 */
  instruction: string;
  /** 原始提及文本，便于 UI 展示。 */
  raw: string[];
}

// 允许斜杠：OpenRouter 的 `anthropic/claude-sonnet-4`、DashScope 转售的 `kimi/kimi-k3`
// 都带命名空间前缀，不允许斜杠就没法 @ 它们。
export const MENTION_RE = /@([\w][\w.\-/]*)/g;

const BROADCAST_TOKENS = new Set(['all', 'everyone', 'everybody', 'team', '全部', '所有人']);

function matchModel(token: string, catalog: ModelDescriptor[]): ModelDescriptor | undefined {
  const t = token.toLowerCase();
  return (
    catalog.find((m) => m.id.toLowerCase() === t) ??
    catalog.find((m) => m.id.toLowerCase().startsWith(t)) ??
    catalog.find((m) => m.family.toLowerCase() === t) ??
    catalog.find((m) => m.label.toLowerCase().replace(/\s+/g, '-') === t) ??
    catalog.find((m) => m.label.toLowerCase().startsWith(t))
  );
}

/**
 * @param fallback 未 @任何人时的默认扇出目标（房间阵容）。
 */
export function resolveMentions(
  prompt: string,
  catalog: ModelDescriptor[],
  fallback: ModelId[] = [],
): ResolvedMentions {
  const targets: ModelId[] = [];
  const unknown: string[] = [];
  const raw: string[] = [];
  let broadcast = false;

  MENTION_RE.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = MENTION_RE.exec(prompt)) !== null) {
    const token = hit[1] ?? '';
    raw.push(hit[0]);
    if (BROADCAST_TOKENS.has(token.toLowerCase())) {
      broadcast = true;
      continue;
    }
    const model = matchModel(token, catalog);
    if (model) {
      if (!targets.includes(model.id)) targets.push(model.id);
    } else {
      unknown.push(token);
    }
  }

  // @all 或未点名 → 使用房间默认阵容；否则只跑被点名的模型。
  const effective = broadcast || targets.length === 0 ? fallback : targets;
  return {
    targets: dedupe(effective).filter((id) => catalog.some((m) => m.id === id)),
    unknown,
    broadcast,
    instruction: stripMentions(prompt),
    raw,
  };
}

function dedupe(ids: ModelId[]): ModelId[] {
  return [...new Set(ids)];
}

export function stripMentions(prompt: string): string {
  return prompt
    .replace(MENTION_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s*[,，、]\s*/, '')
    .trim();
}

/** 输入框中当前正在输入的 @片段（用于弹出候选菜单）。 */
export function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const fragment = before.slice(at + 1);
  if (/[\s]/.test(fragment)) return null;
  // 前面必须是行首或空白，避免把邮箱地址当成提及
  const prev = at === 0 ? ' ' : before[at - 1]!;
  if (!/\s/.test(prev)) return null;
  return { query: fragment, start: at };
}

export function filterCatalog(catalog: ModelDescriptor[], query: string): ModelDescriptor[] {
  const q = query.toLowerCase();
  if (!q) return catalog;
  return catalog.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      m.family.toLowerCase().includes(q) ||
      m.label.toLowerCase().includes(q),
  );
}


/**
 * 按 @提及把一条指令拆成"每个模型该做什么"。
 *
 * 为什么需要：用户常写成一条混合指令——
 *   `@deepseek-chat 请先说明加速上限，@qwen-plus 请评价 deepseek-chat 的说法`
 * 如果把整句发给每个模型，deepseek-chat 会读到"请评价 deepseek-chat 的说法"而困惑
 * （实测它回复"我本身就是 deepseek-chat，本轮我尚未发表任何说法"）。
 *
 * 规则：从每个 @提及 开始、到下一个 @提及 之前为一段，归该模型；
 * 第一段之前的前缀（如"大家好，"）作为公共部分附加给所有模型。
 */
export function segmentInstruction(
  prompt: string,
  catalog: ModelDescriptor[],
): { common: string; byModel: Map<ModelId, string> } {
  const byModel = new Map<ModelId, string>();
  const matches = [...prompt.matchAll(MENTION_RE)];
  if (matches.length === 0) return { common: stripMentions(prompt), byModel };

  const common = prompt.slice(0, matches[0]!.index ?? 0).trim();
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? prompt.length) : prompt.length;
    const segment = stripMentions(prompt.slice(start, end))
      .replace(/^[，,、；;]\s*/, '')
      // 段尾的逗号/顿号/分号是"连接下一个模型"用的，不属于本条指令
      .replace(/[，,、；;]\s*$/, '')
      .trim();
    const model = matchModel(match[1] ?? '', catalog);
    if (!model) return;
    // 同一个模型被提到多次时拼接它的所有片段
    const existing = byModel.get(model.id);
    byModel.set(model.id, existing ? `${existing} ${segment}` : segment);
  });

  return { common, byModel };
}
