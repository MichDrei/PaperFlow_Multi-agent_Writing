/**
 * 群聊用例：把 HTTP 请求翻译成编排器输入，并把流式事件**同时**用于
 * 1) 回传前端；2) 维护服务端会话历史。
 *
 * 这样做的意义：即使客户端崩溃/刷新，服务端仍然持有完整上下文，
 * 下一个回合的模型能看到之前所有模型的发言（多模型协作的前提）。
 */

import type { ChatMessage, ChatTurnRequest, StreamEvent } from '@paperflow/core';
import type { Orchestrator } from '@paperflow/agents';
import { MAX_SESSION_MESSAGES, type ContextStore, type SessionStore } from '../storage/memory.js';

export interface ChatServiceDeps {
  orchestrator: Orchestrator;
  sessions: SessionStore;
  contexts: ContextStore;
  /** 请求未带 projectId 时的默认项目。 */
  projectId: string;
  /** 读取某项目最近一次编译产物的全文（PDF 提取），没有则返回 undefined。 */
  compiledText?: (projectId: string) => string | undefined;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  /**
   * 记录一条**只发给人**的消息（不触发模型的消息）。
   *
   * 关键点：这类消息也必须进会话历史，否则 agent 完全不知道成员之间聊了什么——
   * 实测用户 @模型 问"王五说的对吗"，模型回答"群里没有王五这个人"。
   */
  recordHumanMessage(threadId: string, text: string, authorName: string | undefined, projectId: string | undefined): void {
    // `get` 在未知线程上会返回一个空记录，直接用它即可（不需要 create）
    const session = this.deps.sessions.get(threadId);
    const message: ChatMessage = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      threadId,
      author: { kind: 'user', name: authorName, remote: true },
      text,
      createdAt: new Date().toISOString(),
      status: 'done',
    };
    session.messages = [...session.messages, message].slice(-MAX_SESSION_MESSAGES);
    this.deps.sessions.save(session);
  }

  async *handle(req: ChatTurnRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const { sessions, contexts } = this.deps;
    const projectId = req.projectId?.trim() || this.deps.projectId;
    const session = sessions.get(req.threadId);
    const participants = req.participants?.length ? req.participants : session.participants;

    const userMessage: ChatMessage = {
      id: req.clientMessageId ?? `user-${Date.now()}`,
      threadId: req.threadId,
      author: { kind: 'user' },
      text: req.prompt,
      createdAt: new Date().toISOString(),
      status: 'done',
      selection: req.selection,
    };

    // 传给编排器的历史 = 本回合之前的所有消息（不含刚插入的这条）。
    const history = [...session.messages];

    // 用户引用的那条回答：从会话历史里取出原文，连同发言人一起交给模型。
    // 这样"@qwen 评价 ds 上一条回答"就不需要用户复制粘贴。
    const quoted = req.quotedMessageId
      ? history
          .filter((m) => m.id === req.quotedMessageId)
          .map((m) => ({
            modelId: m.author.kind === 'model' ? m.author.modelId : 'user',
            text: m.text,
          }))
      : [];

    const document = contexts.document(projectId);
    // 主文档：论文正文用它（而不是"恰好开着的标签页"）
    // 前端给的主文档**优先**（那是磁盘上的真实项目文件）；
    // 服务端内存里的文档只是兜底，且只对种子项目才有内容。
    const rootFile = document.files[document.rootFileId];
    const mainFile = req.mainFile
      ? {
          id: req.mainFile.fileId,
          path: req.mainFile.path,
          kind: 'tex' as const,
          content: req.mainFile.content,
          version: req.mainFile.version,
        }
      : rootFile
        ? { id: rootFile.id, path: rootFile.path, kind: rootFile.kind, content: rootFile.content, version: rootFile.version }
        : undefined;
    const activeFile = req.document
      ? {
          id: req.document.fileId,
          path: document.files[req.document.fileId]?.path ?? 'main.tex',
          kind: 'tex' as const,
          content: req.document.content,
          version: req.document.version,
        }
      : document.files[document.rootFileId];

    const stream = this.deps.orchestrator.streamTurn({
      threadId: req.threadId,
      prompt: req.prompt,
      selection: req.selection,
      intent: req.intent,
      participants: participants.length ? participants : ['claude-sonnet-4'],
      document: req.document,
      mainFile,
      // 编译产物的全文由编译服务提供（PDF 提取），让 agent 拿到读者看到的正文
      compiledText: this.deps.compiledText?.(projectId),
      files: Object.values(document.files),
      sharedContext: contexts.sharedContext(projectId),
      history,
      quoted,
      signal,
    });

    // 边转发边落库。
    const pending = new Map<string, ChatMessage>();

    for await (const event of stream) {
      switch (event.type) {
        case 'message.start':
          pending.set(event.messageId, {
            id: event.messageId,
            threadId: req.threadId,
            author: { kind: 'model', modelId: event.modelId, role: event.role },
            text: '',
            createdAt: new Date().toISOString(),
            status: 'streaming',
            replyToId: event.replyToId,
          });
          break;
        case 'message.delta': {
          const message = pending.get(event.messageId);
          if (message) message.text += event.text;
          break;
        }
        case 'message.end': {
          const message = pending.get(event.messageId);
          if (message) {
            message.status = 'done';
            message.usage = event.usage;
          }
          break;
        }
        case 'message.error': {
          const message = pending.get(event.messageId);
          if (message) {
            message.status = 'error';
            message.error = event.message;
          }
          break;
        }
        case 'proposal': {
          const message = pending.get(event.messageId);
          if (message) message.proposalId = event.proposal.id;
          break;
        }
        default:
          break;
      }

      yield event;
    }

    /*
     * 回合结束后写回会话。
     * 私聊（`channel === 'private'`）**不落盘**：用户要求私聊历史存在本地，
     * 服务器只保留本次内存中的上下文，重启即消失。
     */
    if (req.channel !== 'private') {
      const finished = [userMessage, ...pending.values()].filter(
        (m) => m.text.trim().length > 0 || m.id === userMessage.id,
      );
      session.messages = [...session.messages, ...finished].slice(-MAX_SESSION_MESSAGES);
      session.participants = participants;
      sessions.save(session);
    }
  }
}
