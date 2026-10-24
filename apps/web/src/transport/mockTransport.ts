/**
 * MockTransport —— 在浏览器里模拟"多个模型同时被 @、并行流式作答"的完整过程。
 *
 * 为什么值得认真写：它让 UI 雏形阶段就能验证最难的部分——
 * 并发流式渲染、@ 路由、选区快照、EditProposal → DiffHunk → 逐 hunk 应用。
 * 而且它的输出不是随便编的字符串：审稿意见来自对选中文本的真实静态分析，
 * 改写结果来自确定性的文本变换，术语冲突来自共享术语表的真实校验。
 */

import {
  DEFAULT_MODEL_CATALOG,
  DEFAULT_ROOM,
  buildHunks,
  resolveMentions,
  type AgentRole,
  type ChatTurnRequest,
  type EditIntent,
  type ModelDescriptor,
  type ModelId,
  type SharedContext,
  type StreamEvent,
  type TerminologyEntry,
} from '@paperflow/core';
import { auditCitations, checkTerminology } from '@paperflow/context';
import { countWords, estimateTokens, expand, polish, rewrapParagraphs, reviewFindings, tighten, truncate } from '@/lib/rewrite';
import { inferIntent as inferIntentBase, intentLabel as intentLabelBase } from '@/lib/intent';
import { uid, type ChatTransport, type TransportListener } from './types';

const ROLE_CYCLE: AgentRole[] = ['author', 'reviewer', 'methodologist', 'editor'];

const ROLE_LABEL: Record<AgentRole, string> = {
  author: '撰写者',
  reviewer: '审稿人',
  methodologist: '方法学家',
  editor: '编辑',
  assistant: '助手',
};

export interface MockTransportOptions {
  catalog?: ModelDescriptor[];
  /** 动态读取共享知识（术语表、文献），保证 mock 反映当前工作区状态。 */
  getContext?: () => SharedContext;
  getDocumentContent?: () => string;
  chunkSize?: number;
  chunkDelayMs?: number;
}

export class MockTransport implements ChatTransport {
  readonly kind = 'mock' as const;

  private readonly catalog: ModelDescriptor[];

  private readonly getContext: () => SharedContext;

  private readonly getDocumentContent: () => string;

  private readonly chunkSize: number;

  private readonly chunkDelayMs: number;

  private cancelled = new Set<string>();

  constructor(options: MockTransportOptions = {}) {
    this.catalog = options.catalog ?? DEFAULT_MODEL_CATALOG;
    this.getContext = options.getContext ?? (() => ({ citations: [], terminology: [], figures: [], references: [] }));
    this.getDocumentContent = options.getDocumentContent ?? (() => '');
    this.chunkSize = options.chunkSize ?? 4;
    this.chunkDelayMs = options.chunkDelayMs ?? 14;
  }

  cancel(turnId: string): void {
    this.cancelled.add(turnId);
  }

  async send(req: ChatTurnRequest, onEvent: TransportListener): Promise<void> {
    const turnId = uid('turn');
    const room = req.participants?.length ? req.participants : DEFAULT_ROOM;
    const mentions = resolveMentions(req.prompt, this.catalog, room);
    const targets = mentions.targets.length > 0 ? mentions.targets : room.slice(0, 2);

    onEvent({ type: 'turn.start', turnId, targets });

    if (mentions.unknown.length > 0) {
      onEvent({
        type: 'system',
        label: '路由',
        text: `无法识别的提及：${mentions.unknown.map((u) => `@${u}`).join('、')}，已忽略。（可用：${this.catalog
          .map((m) => m.id)
          .join('、')}）`,
      });
    }
    if (req.selection) {
      onEvent({
        type: 'system',
        label: '上下文',
        text: `已附带选区快照：${req.selection.fileId} ${req.selection.start.line}:${req.selection.start.column}–${req.selection.end.line}:${req.selection.end.column}（${countWords(req.selection.text)} 词）`,
      });
    }

    await Promise.all(
      targets.map((modelId, index) => {
        const model = this.catalog.find((m) => m.id === modelId);
        if (!model) return Promise.resolve();
        return this.runModel({ model, index, req, mentionCount: targets.length, turnId, onEvent });
      }),
    );

    onEvent({ type: 'turn.end', turnId, status: this.cancelled.has(turnId) ? 'cancelled' : 'done' });
  }

  private async runModel(args: {
    model: ModelDescriptor;
    index: number;
    req: ChatTurnRequest;
    mentionCount: number;
    turnId: string;
    onEvent: TransportListener;
  }): Promise<void> {
    const { model, index, req, turnId, onEvent } = args;
    const messageId = uid('msg');
    const selection = req.selection;
    const role: AgentRole = selection ? ROLE_CYCLE[index % ROLE_CYCLE.length]! : 'assistant';

    onEvent({ type: 'message.start', messageId, modelId: model.id, role });

    const context = this.getContext();
    const startedAt = Date.now();
    const { text, proposal } = this.composeReply({ model, role, req, context });

    await this.stream(turnId, messageId, text, onEvent);
    if (this.cancelled.has(turnId)) return;

    if (proposal) {
      onEvent({ type: 'proposal', messageId, proposal: proposal.proposal, hunks: proposal.hunks });
    }

    onEvent({
      type: 'message.end',
      messageId,
      usage: {
        promptTokens: estimateTokens((selection?.text ?? '') + req.prompt + 600),
        completionTokens: estimateTokens(text),
        latencyMs: Date.now() - startedAt,
      },
    });
  }

  private async stream(
    turnId: string,
    messageId: string,
    text: string,
    onEvent: TransportListener,
  ): Promise<void> {
    for (let i = 0; i < text.length; i += this.chunkSize) {
      if (this.cancelled.has(turnId)) return;
      onEvent({ type: 'message.delta', messageId, text: text.slice(i, i + this.chunkSize) });
      // 首个 chunk 立即出现，之后按节奏推进，模拟真实首 token 延迟后的稳定吞吐。
      await sleep(i === 0 ? 120 : this.chunkDelayMs);
    }
  }

  private composeReply(input: {
    model: ModelDescriptor;
    role: AgentRole;
    req: ChatTurnRequest;
    context: SharedContext;
  }): {
    text: string;
    proposal?: { proposal: import('@paperflow/core').EditProposal; hunks: import('@paperflow/core').DiffHunk[] };
  } {
    const { model, role, req, context } = input;
    const instruction = req.prompt.replace(/@[\w.\-]+/g, '').trim();
    const intent = req.intent ?? inferIntent(instruction);

    if (!req.selection) {
      return { text: this.composeGeneralReply(model, instruction, context) };
    }

    const selection = req.selection;
    const violations = checkTerminology(selection.text, context.terminology);

    if (role === 'author') {
      return this.composeAuthorReply(model, selection.text, intent, instruction, selection.fileId, req);
    }
    if (role === 'reviewer') {
      return { text: this.composeReviewerReply(model, selection.text, violations.length, context) };
    }
    if (role === 'methodologist') {
      return { text: this.composeMethodologistReply(model, selection.text) };
    }
    return { text: this.composeEditorReply(model, selection.text, violations.length, context) };
  }

  private composeAuthorReply(
    model: ModelDescriptor,
    text: string,
    intent: EditIntent,
    instruction: string,
    fileId: string,
    req: ChatTurnRequest,
  ): {
    text: string;
    proposal?: { proposal: import('@paperflow/core').EditProposal; hunks: import('@paperflow/core').DiffHunk[] };
  } {
    const header = `**${model.label} · ${ROLE_LABEL.author}**\n\n`;

    if (intent === 'translate') {
      return {
        text: `${header}当前处于 **mock 模式**，本地没有真实的翻译模型，因此我不会伪造译文。\n\n接入真实模型后，这里会返回中文译文并生成对应的 diff 提议。请在 \`apps/web/.env.local\` 中配置 \`VITE_API_BASE=http://127.0.0.1:8787\` 并启动 \`apps/server\`。`,
      };
    }
    if (intent === 'review' || intent === 'critique') {
      return { text: this.composeReviewerReply(model, text, 0, this.getContext()) };
    }

    const replacement = transform(text, intent, instruction || 'the proposed method');
    if (replacement === text) {
      return {
        text: `${header}这段文字已经很紧凑，我没有找到值得替换的表达。建议把精力放在论证结构上——可以让我 @ 审稿人模式跑一轮检查。`,
      };
    }

    const selection = req.selection!;
    const originalContent = req.document?.content ?? this.getDocumentContent();
    const lines = originalContent.split('\n');
    const before = lines.slice(0, Math.max(0, selection.start.line - 1));
    const after = lines.slice(selection.end.line);
    const updated = [...before, ...replacement.split('\n'), ...after].join('\n');
    const hunks = buildHunks(originalContent, updated);

    const rationale =
      intent === 'tighten'
        ? '删去填充词与冗余从句，事实与数值全部保留。'
        : intent === 'expand'
          ? '补充了实验章节的交叉引用，使结论可被核查。'
          : '统一了术语与标点风格，并把口语连接词替换为学术表达。';

    const delta = text.length - replacement.length;
    const body = `${header}按「${intentLabel(intent)}」处理完毕，${rationale}\n\n- 词数：${countWords(text)} → ${countWords(replacement)}${delta > 0 ? `（−${delta} 字符）` : ''}\n- 改动位置：${fileId} 第 ${selection.start.line}–${selection.end.line} 行\n\n已在下方生成 diff 提议，请逐块确认后再应用。`;

    return {
      text: body,
      proposal: {
        proposal: {
          id: uid('proposal'),
          fileId,
          baseVersion: req.document?.version ?? 1,
          range: { startLine: selection.start.line, endLine: selection.end.line },
          replacement,
          rationale,
          modelId: model.id,
          intent,
          createdAt: new Date().toISOString(),
        },
        hunks,
      },
    };
  }

  private composeReviewerReply(
    model: ModelDescriptor,
    text: string,
    violations: number,
    context: SharedContext,
  ): string {
    const findings = reviewFindings(text, violations);
    const icon = { high: '🔴', medium: '🟠', low: '🔵' } as const;
    const lines = findings.map((f) => `- ${icon[f.severity]} **${f.severity.toUpperCase()}** ${f.message}`);

    const cited = [...text.matchAll(/\\(?:cite|citep|citet)\{([^}]*)\}/g)].flatMap((m) =>
      (m[1] ?? '').split(',').map((s) => s.trim()),
    );
    const known = new Set(context.citations.map((c) => c.key));
    const missing = cited.filter((c) => !known.has(c));
    if (missing.length > 0) {
      lines.push(`- 🔴 **HIGH** 引用了文献库中不存在的 key：${missing.join('、')}。投稿前会被编辑部打回。`);
    }

    const hitTerms = context.terminology.filter((t) => text.includes(t.term));
    const termNote =
      hitTerms.length > 0
        ? `\n\n术语核对：本段涉及 ${hitTerms.map((t) => `\`${t.term}\`→${t.translation}`).join('、')}，请确认全文一致。`
        : '';

    return `**${model.label} · ${ROLE_LABEL.reviewer}**\n\n我按审稿标准逐句检查了这段（${countWords(text)} 词），共 ${findings.length} 条意见：\n\n${lines.join('\n')}${termNote}\n\n> 我不同意"只改措辞"的做法——若上面的高优先级问题成立，改写之前应先补证据。`;
  }

  private composeMethodologistReply(model: ModelDescriptor, text: string): string {
    const mathSpans = text.match(/\$[^$]+\$/g) ?? [];
    const symbols = new Set<string>();
    for (const span of mathSpans) {
      for (const m of span.matchAll(/[A-Za-z]\w*/g)) symbols.add(m[0]);
    }
    const hasEquationEnv = /\\begin\{(equation|align)\}/.test(text);
    const parts: string[] = [];

    if (mathSpans.length === 0 && !hasEquationEnv) {
      parts.push('本段没有公式，因此我从实验协议角度审查。请确认控制变量与随机种子在正文中显式给出，否则结果不可复现。');
    } else {
      parts.push(
        `检测到 ${mathSpans.length} 处行内公式、${hasEquationEnv ? '包含' : '不含'}公式环境。符号表：${
          [...symbols].slice(0, 12).join(', ') || '（无）'
        }。`,
      );
      if (symbols.size > 0) {
        parts.push('请确认每个符号在首次出现处都有定义，且与符号表章节完全一致——多模型协作最容易在这里产生漂移。');
      }
      parts.push('建议明确写出假设：草稿分布与目标分布的独立同分布假设在长上下文下并不总是成立。');
    }
    return `**${model.label} · ${ROLE_LABEL.methodologist}**\n\n${parts.map((p) => `- ${p}`).join('\n')}`;
  }

  private composeEditorReply(
    model: ModelDescriptor,
    text: string,
    violations: number,
    context: SharedContext,
  ): string {
    const terms = context.terminology.filter((t) => text.includes(t.term) || text.includes(t.translation));
    return `**${model.label} · ${ROLE_LABEL.editor}**\n\n汇总本轮意见：\n\n1. 撰写者给出了可应用的改写提议，已生成 diff，可直接逐块接受。\n2. 审稿人提出的高优先级问题（证据缺失${violations > 0 ? `、术语冲突 ${violations} 处` : ''}）不应被措辞修改掩盖。\n3. 涉及术语：${terms.map((t) => t.translation).join('、') || '无'}。\n\n我的建议：**先接受第 1 块的措辞改动，暂缓其余**，等补上 \`\\cite{}\` 之后再整体重跑一轮。`;
  }

  private composeGeneralReply(model: ModelDescriptor, instruction: string, context: SharedContext): string {
    const content = this.getDocumentContent();
    const sections = [...content.matchAll(/\\section\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    const audit = auditCitations(content, context.citations);
    const angle: Record<string, string> = {
      anthropic: '我偏向从**行文与论证连贯性**切入。',
      openai: '我偏向从**实验设计与结论强度**切入。',
      google: '我偏向从**跨章节一致性与文献覆盖**切入。',
      deepseek: '我偏向从**公式表达与中文可读性**切入。',
      moonshot: '我偏向从**资料归纳**切入。',
      qwen: '我偏向从**数学推导**切入。',
    };

    const lines = [
      `**${model.label} · ${ROLE_LABEL.assistant}**`,
      '',
      angle[model.provider] ?? '我从整体结构切入。',
      '',
      `当前文档共 ${sections.length} 个章节：${sections.join(' / ') || '（未检测到 \\section）'}，约 ${countWords(content)} 词。`,
    ];

    if (audit.missing.length > 0) lines.push(`⚠️ 有 ${audit.missing.length} 个引用 key 在 \`refs.bib\` 中不存在：${audit.missing.join('、')}。`);
    if (audit.unused.length > 0) lines.push(`ℹ️ 有 ${audit.unused.length} 条文献从未被引用：${audit.unused.slice(0, 4).join('、')}${audit.unused.length > 4 ? '…' : ''}。`);

    lines.push(
      '',
      instruction ? `关于「${truncate(instruction, 60)}」：请把光标放到具体段落并**选中文本**，我就能直接产出可应用的改写 diff。` : '请选中一段文本，或 @ 我给出具体任务。',
      '',
      `> 当前为 mock 模式：回复由本地静态分析生成。配置 API Key 并启动 \`apps/server\` 后，这条消息将由 ${model.label} 真实生成。`,
    );
    return lines.join('\n');
  }
}

function transform(text: string, intent: EditIntent, topic: string): string {
  // 与浏览器内 mock 一致的策略：先合并段内硬换行，再做语义变换。
  // 服务端的 Mock 提供方（packages/llm/providers/mock.ts）使用同一套 core 函数，
  // 因此两种降级路径产出的 diff 是一致的。
  switch (intent) {
    case 'tighten':
      return rewrapParagraphs(tighten(text));
    case 'rewrite':
      return rewrapParagraphs(polish(tighten(text)));
    case 'polish':
      return rewrapParagraphs(polish(text));
    case 'expand':
      return rewrapParagraphs(expand(text, topic));
    default:
      return rewrapParagraphs(polish(text));
  }
}

export function inferIntent(instruction: string): EditIntent {
  return inferIntentBase(instruction);
}

export function intentLabel(intent: EditIntent): string {
  return intentLabelBase(intent);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function terminologySummary(terminology: TerminologyEntry[]): string {
  return terminology.map((t) => `${t.term}→${t.translation}`).join('；');
}

export type { ModelId };
