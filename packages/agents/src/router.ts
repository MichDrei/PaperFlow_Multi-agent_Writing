/**
 * 路由与回合策略：决定"这次谁说话、说几轮"。
 *
 * @提及的**解析**在 `@paperflow/core/mentions`（前后端共用同一份纯函数）；
 * 这里放的是服务端策略：并发上限、角色分配、是否触发交叉评审。
 */

import {
  DEFAULT_MODEL_CATALOG,
  resolveMentions,
  type AgentRole,
  type ModelDescriptor,
  type ModelId,
  type ResolvedMentions,
} from '@paperflow/core';
import { assignRole } from './roles.js';

export interface RouteOptions {
  catalog?: ModelDescriptor[];
  /** 房间阵容（未 @ 任何人时的默认目标）。 */
  participants: ModelId[];
  /** 单回合最多并发多少个模型，防止误写 @all 打爆配额。 */
  maxConcurrency?: number;
  intent?: string;
  hasSelection?: boolean;
  /** 是否允许第二轮交叉评审。 */
  crossReview?: boolean;
}

export interface RoutePlan {
  mentions: ResolvedMentions;
  targets: ModelId[];
  roles: Map<ModelId, AgentRole>;
  /** 需要发起交叉评审时：由谁去点评谁。 */
  crossReview?: { reviewer: ModelId; subject: ModelId };
  /**
   * 执行方式。
   * - `parallel`：各答各的（默认，最快）
   * - `sequential`：依次发言，**后面的模型能看到前面模型的回答**
   *   （用户说"@qwen 评价一下 @deepseek 的方案"时，必须用这种方式，
   *    否则两者并发运行、互相看不见，用户只能手动复制粘贴）
   */
  mode: 'parallel' | 'sequential';
  warnings: string[];
}

/** 指令里是否在要求"评审/验证/比较另一个模型的回答" */
export function wantsPeerReview(instruction: string): boolean {
  return /评价|点评|评审|审阅|验证|核对|检查|批判|反驳|挑错|对比|比较|打分|评估|review|critique|verify|validate|check|compare|evaluate|rebut/i.test(
    instruction,
  );
}

/**
 * 为写错的 @提及 找最接近的候选。
 * 例：`@qwen-max` 不存在时，把同前缀/同家族的模型列出来，而不是只说"认不出"。
 */
export function suggestModels(tokens: string[], catalog: ModelDescriptor[], limit = 4): ModelId[] {
  const out: ModelId[] = [];
  for (const token of tokens) {
    const prefix = token.toLowerCase().split(/[.\-]/)[0] ?? token.toLowerCase();
    for (const model of catalog) {
      const sameFamily = model.family.toLowerCase() === prefix || model.family.toLowerCase().startsWith(prefix);
      const samePrefix = model.id.toLowerCase().startsWith(prefix);
      if ((sameFamily || samePrefix) && !out.includes(model.id)) out.push(model.id);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function planTurn(prompt: string, options: RouteOptions): RoutePlan {
  const catalog = options.catalog ?? DEFAULT_MODEL_CATALOG;
  const mentions = resolveMentions(prompt, catalog, options.participants);
  const warnings: string[] = [];
  const maxConcurrency = options.maxConcurrency ?? 4;

  let targets = mentions.targets;

  // 用户明确 @ 了模型，但一个都没匹配上：不要静默回退成"全员应答"——
  // 那会消耗 4 倍 token，而且看起来像"@ 的那个人没理我"。
  // 正确做法是停下来，把候选和可用清单摆出来。
  const onlyUnresolvedMentions =
    mentions.raw.length > 0 && !mentions.broadcast && mentions.unknown.length === mentions.raw.length;
  if (onlyUnresolvedMentions) {
    const suggestions = suggestModels(mentions.unknown, catalog);
    const available = catalog
      .filter((m) => m.available !== false)
      .map((m) => m.id);
    const pool = available.length > 0 ? available : catalog.map((m) => m.id);
    warnings.push(
      [
        `无法识别的提及：${mentions.unknown.map((u) => `@${u}`).join('、')}（本轮未调用任何模型）。`,
        suggestions.length > 0 ? `你是否想用：${suggestions.map((s) => `@${s}`).join(' 或 ')}？` : '',
        `可用模型：${pool.slice(0, 12).join('、')}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return { mentions, targets: [], roles: new Map(), mode: 'parallel', warnings };
  }

  if (targets.length === 0) {
    warnings.push('没有可用目标（房间为空）。');
    targets = [];
  }
  if (targets.length > maxConcurrency) {
    warnings.push(`目标数 ${targets.length} 超过并发上限 ${maxConcurrency}，仅执行前 ${maxConcurrency} 个。`);
    targets = targets.slice(0, maxConcurrency);
  }
  if (mentions.unknown.length > 0) {
    warnings.push(`无法识别的提及：${mentions.unknown.map((u) => `@${u}`).join('、')}`);
  }

  const roles = new Map<ModelId, AgentRole>();
  targets.forEach((id, index) => {
    roles.set(id, assignRole(index, targets.length, options.hasSelection ?? false, options.intent ?? 'rewrite'));
  });

  // 交叉评审：有选区、至少两个目标、且用户没有明确要求"只评审"时才启用。
  // 让第二个模型针对第一个模型的产出发言，这是"模型互相修改"的最小实现。
  const crossReviewEnabled = options.crossReview ?? true;
  const crossReview =
    crossReviewEnabled && options.hasSelection && targets.length >= 2
      ? { reviewer: targets[1]!, subject: targets[0]! }
      : undefined;

  // 串行执行的两种情况：
  // 1) 有选区 + 多目标：撰写者先写，审稿人再看（已有的交叉评审）
  // 2) 用户在指令里要求"评价/验证/比较"且点了多个模型：
  //    必须串行，否则后一个模型看不到前一个的回答——这正是用户抱怨的"彼此封闭"
  const reviewRequested = wantsPeerReview(mentions.instruction);
  const mode: 'parallel' | 'sequential' =
    targets.length >= 2 && (Boolean(crossReview) || reviewRequested) ? 'sequential' : 'parallel';

  if (mode === 'sequential' && targets.length >= 2 && reviewRequested && !crossReview) {
    warnings.push(
      `检测到评审意图：${targets.join(' → ')} 将依次发言，后面的模型会看到前面模型的回答。`,
    );
  }

  return { mentions, targets, roles, crossReview, mode, warnings };
}
