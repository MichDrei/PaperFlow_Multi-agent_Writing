/**
 * 编排器：一次群聊回合的完整生命周期。
 *
 * 采用 **async generator** 暴露事件流：服务端只是 for-await 地把事件写成 SSE 帧，
 * 不关心内部有几个模型、跑了几轮。并发扇出用「事件队列」合并，
 * 因此多个模型的增量输出会按到达顺序交织在同一条流里——这正是群聊的观感。
 */

import {
  DEFAULT_MODEL_CATALOG,
  segmentInstruction,
  type AgentRole,
  type ChatMessage,
  type EditIntent,
  type ModelDescriptor,
  type ModelId,
  type PaperFile,
  type Selection,
  type SharedContext,
  type StreamEvent,
  type Usage,
} from '@paperflow/core';
import { retrieve, type RetrievedChunk } from '@paperflow/context';
import type { LlmGateway, LlmMessage } from '@paperflow/llm';
import { serializeMessages } from './serializer.js';
import { parseProposal } from './proposal.js';
import { planTurn } from './router.js';

export interface OrchestratorOptions {
  gateway: LlmGateway;
  catalog?: ModelDescriptor[];
  maxConcurrency?: number;
  crossReview?: boolean;
  temperature?: number;
  /** 每轮历史预算（字符）。 */
  historyBudgetChars?: number;
}

export interface TurnInput {
  /** 项目主文档（编译入口）——论文正文用它。 */
  mainFile?: PaperFile;
  /** 编译产物（PDF）的全文，供 agent 了解"读者看到的正文"。 */
  compiledText?: string;
  threadId: string;
  prompt: string;
  selection?: Selection;
  intent?: EditIntent;
  participants: ModelId[];
  document?: { fileId: string; content: string; version: number };
  files?: PaperFile[];
  sharedContext: SharedContext;
  history?: ChatMessage[];
  /** 用户显式引用的历史回答（以及它出自哪个模型）。 */
  quoted?: { modelId: ModelId; text: string }[];
  signal?: AbortSignal;
}

let idCounter = 0;

/**
 * 本地 id 生成：刻意不用 node:crypto，保持本包可以在任何 JS 运行时里跑
 * （Node / Bun / Deno / 边缘函数 / 甚至浏览器 Worker）。
 */
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 多生产者 → 单消费者 的事件队列。 */
class EventQueue<T> {
  private items: T[] = [];

  private resolvers: ((value: IteratorResult<T>) => void)[] = [];

  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as never, done: true });
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

export class Orchestrator {
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions) {
    this.options = options;
  }

  /** 执行一次回合，产出完整事件流。 */
  async *streamTurn(input: TurnInput): AsyncGenerator<StreamEvent> {
    const catalog = this.options.catalog ?? DEFAULT_MODEL_CATALOG;
    const turnId = newId('turn');
    const plan = planTurn(input.prompt, {
      catalog,
      participants: input.participants,
      maxConcurrency: this.options.maxConcurrency,
      intent: input.intent,
      hasSelection: Boolean(input.selection),
      crossReview: this.options.crossReview,
    });

    yield { type: 'turn.start', turnId, targets: plan.targets };

    for (const warning of plan.warnings) {
      yield { type: 'system', label: '路由', text: warning };
    }
    if (input.selection) {
      yield {
        type: 'system',
        label: '上下文',
        text: `已附带选区快照：${input.selection.fileId} L${input.selection.start.line}–${input.selection.end.line}（${input.selection.text.length} 字符）`,
      };
    }
    if (plan.targets.length === 0) {
      // 没有目标不是"系统错误"，而是"这次没点名成功"——上面的 system 事件已经把
      // 候选模型列清楚了。用 done 结束，避免前端弹误导性的"生成失败"横幅。
      yield { type: 'turn.end', turnId, status: 'done' };
      return;
    }

    const retrieved = this.retrieveContext(input);
    // 把混合指令拆成"每个模型该做什么"，避免模型读到针对别人的要求而困惑
    const segments = segmentInstruction(input.prompt, catalog);
    const instructionFor = (modelId: ModelId): string => {
      const own = segments.byModel.get(modelId);
      const combined = [segments.common, own].filter(Boolean).join(' ').trim();
      // 该模型没有被单独点名（例如 @all）时，退回整条指令
      return combined || plan.mentions.instruction;
    };
    const outputs = new Map<ModelId, string>();
    const messageIds = new Map<ModelId, string>();

    const queue = new EventQueue<StreamEvent>();
    const producer = (async () => {
      try {
        if (plan.mode === 'sequential') {
          // 依次发言：每个模型都能看到前面所有模型的回答。
          // 这是"让 B 评价 A"能真正成立的前提——并发运行时 B 根本看不到 A。
          const spoken: { modelId: ModelId; text: string }[] = [];
          for (const [index, modelId] of plan.targets.entries()) {
            if (input.signal?.aborted) break;
            const role = plan.roles.get(modelId) ?? 'assistant';
            const previous = spoken[spoken.length - 1];
            const result = await this.runModel({
              modelId,
              role,
              input,
              retrieved,
              catalog,
              queue,
              instruction: instructionFor(modelId),
              peerTargets: plan.targets,
              quoted: input.quoted,
              // 前一位发言者的回答：交给当前模型针对性地回应
              ...(index > 0 && previous
                ? { peerAnswer: { modelId: previous.modelId, text: previous.text } }
                : {}),
              ...(index > 0 && spoken.length > 1
                ? {
                    quoted: [
                      ...(input.quoted ?? []),
                      ...spoken.map((sp) => ({ modelId: sp.modelId, text: sp.text })),
                    ],
                  }
                : {}),
            });
            outputs.set(modelId, result.text);
            messageIds.set(modelId, result.messageId);
            spoken.push({ modelId, text: result.text });
          }
        } else {
          await Promise.all(
            plan.targets.map(async (modelId) => {
              const role = plan.roles.get(modelId) ?? 'assistant';
              const result = await this.runModel({
                modelId,
                role,
                input,
                retrieved,
                catalog,
                queue,
                instruction: instructionFor(modelId),
                peerTargets: plan.targets,
                quoted: input.quoted,
              });
              outputs.set(modelId, result.text);
              messageIds.set(modelId, result.messageId);
            }),
          );
        }

        // 第二轮：交叉评审——让另一个模型评价刚才的产出（不产生新的 diff）。
        if (plan.crossReview) {
          const { reviewer, subject } = plan.crossReview;
          const subjectText = outputs.get(subject);
          if (subjectText && subjectText.trim().length > 0 && !input.signal?.aborted) {
            queue.push({
              type: 'system',
              label: '编排',
              text: `已让 ${reviewer} 对 ${subject} 的输出发起交叉评审（这对应"@某个模型修改/评价另一个模型的回答"）。`,
            });
            await this.runModel({
              modelId: reviewer,
              role: 'reviewer',
              input,
              retrieved,
              catalog,
              queue,
              instruction: plan.mentions.instruction,
              peerTargets: plan.targets,
              quoted: input.quoted,
              peerAnswer: { modelId: subject, text: subjectText },
              replyToId: messageIds.get(subject),
              reviewOnly: true,
            });
          }
        }
      } finally {
        queue.close();
      }
    })();

    try {
      for await (const event of queue.drain()) yield event;
      await producer;
      yield { type: 'turn.end', turnId, status: input.signal?.aborted ? 'cancelled' : 'done' };
    } catch (err) {
      yield {
        type: 'system',
        label: '编排',
        text: `回合异常终止：${err instanceof Error ? err.message : String(err)}`,
      };
      yield { type: 'turn.end', turnId, status: 'error' };
    }
  }

  private retrieveContext(input: TurnInput): RetrievedChunk[] {
    const query = [input.prompt, input.selection?.text ?? ''].join('\n');
    if (!query.trim()) return [];
    try {
      return retrieve(query, input.files ?? [], input.sharedContext, { topK: 6 });
    } catch {
      // 检索失败不应阻断主流程——它只是增强，不是依赖。
      return [];
    }
  }

  private async runModel(args: {
    modelId: ModelId;
    role: AgentRole;
    input: TurnInput;
    retrieved: RetrievedChunk[];
    catalog: ModelDescriptor[];
    queue: EventQueue<StreamEvent>;
    /** 去掉 @提及 的指令正文。 */
    instruction: string;
    peerTargets: string[];
    quoted?: { modelId: ModelId; text: string }[];
    peerAnswer?: { modelId: ModelId; text: string };
    replyToId?: string;
    reviewOnly?: boolean;
  }): Promise<{ messageId: string; text: string }> {
    const { modelId, role, input, retrieved, catalog, queue, peerAnswer, replyToId, reviewOnly } = args;
    const selfDescriptor = catalog.find((m) => m.id === modelId);
    const messageId = newId('msg');
    const startedAt = Date.now();

    queue.push({ type: 'message.start', messageId, modelId, role, replyToId });

    const messages: LlmMessage[] = serializeMessages({
      role,
      instruction: args.instruction,
      selfModel: { id: modelId, label: selfDescriptor?.label ?? modelId },
      quoted: args.quoted,
      peerTargets: args.peerTargets,
      // 用目标模型真实的上下文窗口决定"资料能发多少"，而不是拍一个固定字数
      modelContextWindow: selfDescriptor?.contextWindow,
      // 只有声明了 vision 能力的模型才附带 PDF 页面图像（纯文本模型收到图片会报错）
      supportsVision: selfDescriptor?.capabilities.includes('vision') ?? false,
      selection: input.selection
        ? {
            text: input.selection.text,
            fileId: input.selection.fileId,
            startLine: input.selection.start.line,
            endLine: input.selection.end.line,
          }
        : undefined,
      activeFile: input.files?.find((f) => f.id === input.document?.fileId) ?? input.files?.[0],
      // 论文正文用主文档；改写仍作用在 activeFile 上
      mainFile: input.mainFile,
      compiledText: input.compiledText,
      sharedContext: input.sharedContext,
      retrieved,
      history: input.history ?? [],
      historyBudgetChars: this.options.historyBudgetChars ?? 6000,
      peerAnswer,
    });

    let text = '';
    let usage: Usage = { promptTokens: 0, completionTokens: 0 };
    let failed = false;

    try {
      for await (const chunk of this.options.gateway.stream(modelId, {
        messages,
        temperature: this.options.temperature ?? 0.4,
        signal: input.signal,
      })) {
        if (input.signal?.aborted) break;
        if (chunk.type === 'text') {
          text += chunk.text;
          queue.push({ type: 'message.delta', messageId, text: chunk.text });
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        }
      }
    } catch (err) {
      failed = true;
      queue.push({
        type: 'message.error',
        messageId,
        code: 'generation_failed',
        message: err instanceof Error ? err.message : '生成失败',
      });
    }

    // 只有"撰写者"且用户提供了文档快照时才产出可应用的 diff。
    const shouldPropose =
      !failed && !reviewOnly && role === 'author' && Boolean(input.selection) && Boolean(input.document);
    if (shouldPropose && input.selection && input.document) {
      const parsed = parseProposal({
        raw: text,
        modelId,
        fileId: input.selection.fileId,
        baseVersion: input.document.version,
        range: { startLine: input.selection.start.line, endLine: input.selection.end.line },
        intent: input.intent ?? 'rewrite',
        documentContent: input.document.content,
      });
      if (parsed) {
        queue.push({
          type: 'proposal',
          messageId,
          proposal: parsed.proposal,
          hunks: parsed.hunks,
        });
      } else if (text.trim().length > 0) {
        // 模型回答了，但没能解析出可替换的 LaTeX（例如它认为无需修改，
        // 或者把结论写成了纯评论）。明确说一声，否则用户只会看到"有回复但没有 diff"。
        queue.push({
          type: 'system',
          label: '编辑提议',
          text: '本轮没有生成可应用的 diff：模型未给出可直接替换的 LaTeX（可能认为无需修改）。可以换个说法，或 @ 另一个模型再试。',
        });
      }
    }

    queue.push({
      type: 'message.end',
      messageId,
      usage: { ...usage, latencyMs: Date.now() - startedAt },
    });

    const model = catalog.find((m) => m.id === modelId);
    return { messageId, text: `${model?.label ?? modelId}: ${text}` };
  }
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}
