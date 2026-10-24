/**
 * 内存存储：原型阶段的持久层。
 *
 * 接口刻意设计成"可替换"的形状（SessionStore / ContextStore 两个窄接口），
 * 之后换成 SQLite 或 Postgres 时，只有这一层需要改动。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage, PaperDocument, ReferenceDocument, SharedContext } from '@paperflow/core';
import { DEMO_CONTEXT, DEMO_DOCUMENT } from '@paperflow/context';

export interface SessionRecord {
  threadId: string;
  messages: ChatMessage[];
  participants: string[];
  updatedAt: string;
}

export interface SessionStore {
  get(threadId: string): SessionRecord;
  save(record: SessionRecord): void;
  list(): SessionRecord[];
  /** 清空某个线程（前端点"清空会话"时必须同时清服务端，否则模型会看到已删除的旧上下文）。 */
  clear(threadId: string): void;
}

/**
 * 会话存储（落盘）。
 *
 * 为什么必须落盘：多模型协作的全部价值建立在"记得别人说过什么"之上。
 * 之前会话只在内存里，`tsx watch` 每次因源码改动重启都会静默清空历史——
 * 用户看到的是"模型互相看不见"，而真正的原因是他的对话被抹掉了。
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly persistPath: string | null;

  constructor(options: { persistPath?: string | null } = {}) {
    this.persistPath = options.persistPath === undefined ? defaultSessionsPath() : options.persistPath;
    this.restore();
  }

  private restore(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, SessionRecord>;
      for (const [threadId, record] of Object.entries(raw)) {
        this.sessions.set(threadId, { ...record, messages: record.messages ?? [] });
      }
    } catch {
      // 文件损坏不应阻止服务启动
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
      const temporary = `${this.persistPath}.tmp`;
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, this.persistPath);
    } catch {
      // 落盘失败不影响对话
    }
  }

  get(threadId: string): SessionRecord {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const created: SessionRecord = {
      threadId,
      messages: [],
      participants: [],
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(threadId, created);
    return created;
  }

  save(record: SessionRecord): void {
    this.sessions.set(record.threadId, { ...record, updatedAt: new Date().toISOString() });
    this.persist();
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  clear(threadId: string): void {
    this.sessions.set(threadId, {
      threadId,
      messages: [],
      participants: [],
      updatedAt: new Date().toISOString(),
    });
    this.persist();
  }
}

/** 会话落盘位置：仓库根 .paperflow/sessions.json（已 gitignore）。 */
export function defaultSessionsPath(): string {
  return resolve(MODULE_DIR, '../../../../.paperflow/sessions.json');
}

export interface ContextStore {
  /** 共享知识（文献 / 术语 / 图表 / 参考资料）。 */
  sharedContext(projectId: string): SharedContext;
  document(projectId: string): PaperDocument;
  saveSharedContext(projectId: string, context: SharedContext): void;
  /** 添加参考资料，返回落库后的条目。 */
  addReference(projectId: string, reference: ReferenceDocument): ReferenceDocument;
  removeReference(projectId: string, referenceId: string): boolean;
}

/** 单个项目最多保留多少份参考资料，防止内存无限增长。 */
export const MAX_REFERENCES = 50;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 默认落盘位置：仓库根下的 .paperflow/context.json（已加入 .gitignore）。 */
export function defaultContextPath(): string {
  return resolve(MODULE_DIR, '../../../../.paperflow/context.json');
}

export interface MemoryContextStoreOptions {
  /**
   * 共享知识落盘路径。传 null 表示纯内存（测试用）。
   *
   * 为什么需要落盘：资料存在内存里时，`tsx watch` 每次因源码改动重启都会清空它——
   * 表现为"我刚加的三篇论文不见了"，而用户完全无从判断发生了什么。
   */
  persistPath?: string | null;
}

export interface MemoryContextStoreOptions {
  persistPath?: string | null;
  /**
   * 用演示文献库播种的项目 id。
   * 其它项目**从空开始**——新论文项目里出现一堆演示论文的参考文献会让人莫名其妙。
   */
  seedProjectId?: string;
}

export class MemoryContextStore implements ContextStore {
  private readonly contexts = new Map<string, SharedContext>();

  private readonly seedProjectId: string | undefined;

  private readonly documents = new Map<string, PaperDocument>();

  private readonly persistPath: string | null;

  constructor(options: MemoryContextStoreOptions = {}) {
    this.persistPath = options.persistPath === undefined ? defaultContextPath() : options.persistPath;
    this.seedProjectId = options.seedProjectId;
    this.restore();
  }

  /** 启动时恢复上次的共享知识（文献/术语/图表/参考资料）。 */
  private restore(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as Record<string, SharedContext>;
      for (const [projectId, context] of Object.entries(raw)) {
        this.contexts.set(projectId, { ...context, references: context.references ?? [] });
      }
    } catch {
      // 文件损坏不应阻止服务启动：忽略它，用种子数据继续
    }
  }

  /** 原子写入：先写临时文件再 rename，避免进程中途退出留下半个 JSON。 */
  private persist(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(this.contexts), null, 2);
      const temporary = `${this.persistPath}.tmp`;
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, this.persistPath);
    } catch {
      // 落盘失败不应影响对话本身
    }
  }

  sharedContext(projectId: string): SharedContext {
    const stored = this.contexts.get(projectId);
    if (stored) return stored;
    // 克隆一层，避免调用方无意间改到"种子数据"（DEMO_CONTEXT 是模块级常量）
    const seeded: SharedContext =
      this.seedProjectId === undefined || this.seedProjectId === projectId
        ? { ...DEMO_CONTEXT, references: [] }
        : { citations: [], terminology: [], figures: [], references: [] };
    this.contexts.set(projectId, seeded);
    return seeded;
  }

  /**
   * 取某项目的文档。
   *
   * ⚠️ 只有**种子项目**才回退到演示论文。早先对任何未知项目都返回 `DEMO_DOCUMENT`，
   * 后果很隐蔽：agent 读到的"论文正文"是那份演示论文，而不是用户自己的文章
   * （实测用户问"解析一下项目里的文章"，模型回答的却是演示论文的标题）。
   */
  document(projectId: string): PaperDocument {
    const stored = this.documents.get(projectId);
    if (stored) return stored;
    return this.seedProjectId === undefined || this.seedProjectId === projectId
      ? DEMO_DOCUMENT
      : { id: projectId, title: '', files: {}, rootFileId: '', updatedAt: new Date().toISOString() };
  }

  saveSharedContext(projectId: string, context: SharedContext): void {
    this.contexts.set(projectId, context);
    this.persist();
  }

  addReference(projectId: string, reference: ReferenceDocument): ReferenceDocument {
    const context = this.sharedContext(projectId);
    // 同源同标题视为重复：重新添加等于替换（用户往往是在修正内容）
    const existing = context.references.findIndex(
      (r) => r.title === reference.title && r.source === reference.source,
    );
    const references = [...context.references];
    if (existing >= 0) references[existing] = reference;
    else references.push(reference);

    // 超出上限时丢掉最早的（保留最近添加的）
    const trimmed = references.slice(-MAX_REFERENCES);
    this.contexts.set(projectId, { ...context, references: trimmed });
    this.persist();
    return reference;
  }

  removeReference(projectId: string, referenceId: string): boolean {
    const context = this.sharedContext(projectId);
    const references = context.references.filter((r) => r.id !== referenceId);
    if (references.length === context.references.length) return false;
    this.contexts.set(projectId, { ...context, references });
    this.persist();
    return true;
  }
}

/** 会话内存保护：单线程最多保留多少条消息，防止长时间运行内存无限增长。 */
export const MAX_SESSION_MESSAGES = 400;
