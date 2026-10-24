/**
 * 前后端唯一的传输契约：SSE 事件联合类型 + 客户端请求体。
 * 服务端只允许发送这里定义的形状，前端只处理这里定义的形状。
 */

import type { ChatMessage, MessageId, ThreadId, TurnId } from './chat.js';
import type { DiffHunk, EditProposal, Selection, EditIntent } from './edit.js';
import type { AgentRole, ModelId, Usage } from './model.js';

export interface ChatTurnRequest {
  threadId: ThreadId;
  /**
   * 所属项目。多项目并列时，共享知识（文献/术语/参考资料）必须按项目隔离，
   * 否则 ICRA 的术语表会和 RAL 的参考文献串味。
   */
  projectId?: string;
  /** 用户原始输入，含 @提及。 */
  prompt: string;
  selection?: Selection;
  intent?: EditIntent;
  /** 当前房间阵容：未 @任何人时，请求将扇出到这些模型。 */
  participants?: ModelId[];
  /**
   * 用户引用的历史回答（点消息上的「引用」按钮）。
   * 有了它就不需要把上一条回答复制粘贴进输入框。
   */
  quotedMessageId?: MessageId;
  /** 客户端乐观插入的用户消息 id，便于回填。 */
  clientMessageId?: MessageId;
  /** 浏览器实例 id：群聊广播时用来排除"发起者自己"，避免消息重复。 */
  clientId?: string;
  /**
   * 通道：
   * - `room`：公聊，广播给房间、写公共历史（默认）
   * - `private`：私聊，**不广播、不落公共历史**，别人看不到
   */
  channel?: 'room' | 'private';
  /** 当前文档快照（服务端据此计算 diff，避免二次往返）。 */
  document?: {
    fileId: string;
    content: string;
    version: number;
  };
  /**
   * 项目**主文档**（编译入口）的内容。
   *
   * 必须与 `document`（当前打开的文件）分开：用户问"解析一下项目里的文章"时，
   * agent 该看到**整篇论文**，而不是恰好开着的那个标签页——实测因为只发活动文件，
   * agent 读到的是一份残留的 main.tex，而不是真正的主文档。
   * 改写仍然作用在 `document` 上，两者互不影响。
   */
  mainFile?: { fileId: string; path: string; content: string; version: number };
}

/**
 * 编译引擎。对应 Overleaf 左上角的下拉框。
 *
 * 经验法则：**中文与英文用同一个引擎（XeLaTeX）即可**——这也是 Overleaf 上中文作者的
 * 常规做法，因为 XeLaTeX 原生支持 UTF-8 与系统字体，不必再折腾 inputenc。
 * `auto` 会按内容自动判断（含中日韩字符时补 CJK 支持）。
 */
export type LatexEngine = 'auto' | 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileRequest {
  fileId: string;
  content: string;
  /** 项目里的其它文件（\input / .cls / .bib / 图片）：全部交给编译器才能正确排版。 */
  auxFiles?: { path: string; content: string; encoding?: 'utf8' | 'base64' }[];
  /** 编译入口文件在项目中的路径，默认 main.tex。 */
  mainPath?: string;
  /** 编译引擎，默认 auto。 */
  engine?: LatexEngine;
  /** 所属项目。用于把 SyncTeX 索引缓存到对应项目上（不做隔离会串项目）。 */
  projectId?: string;
}

export interface CompileDiagnostic {
  level: 'error' | 'warning' | 'info';
  file: string;
  line: number;
  column?: number;
  message: string;
}

/** 源码行 → PDF 位置，用于 SyncTeX 式的"改动后跳到对应页并高亮"。 */
export interface SourceAnchor {
  /** 源码行号（1-based）。 */
  line: number;
  /** 页码（0-based）。 */
  page: number;
  /** 该行在页面上的基线 y 坐标（PDF 坐标系，原点左下）。 */
  y: number;
}

export interface CompileResult {
  ok: boolean;
  /** 生成 PDF 的地址（浏览器内编译时为 blob URL）。 */
  pdfUrl?: string;
  /** PDF 原始字节的 base64（服务端编译时使用，避免服务持有状态）。 */
  pdfBase64?: string;
  log: string;
  diagnostics: CompileDiagnostic[];
  /** 必须随结果一起返回：前端靠它把"AI 改动的行"映射到 PDF 页面上。 */
  anchors: SourceAnchor[];
  durationMs: number;
  /** 是否命中编译缓存。 */
  cached?: boolean;
}

export type StreamEvent =
  | { type: 'turn.start'; turnId: TurnId; targets: ModelId[] }
  | { type: 'message.start'; messageId: MessageId; modelId: ModelId; role: AgentRole; replyToId?: MessageId }
  | { type: 'message.delta'; messageId: MessageId; text: string }
  | { type: 'message.tool'; messageId: MessageId; tool: string; args: unknown }
  | { type: 'proposal'; messageId: MessageId; proposal: EditProposal; hunks: DiffHunk[] }
  | { type: 'message.end'; messageId: MessageId; usage: Usage }
  | { type: 'message.error'; messageId: MessageId; code: string; message: string }
  | { type: 'system'; label: string; text: string }
  | { type: 'turn.end'; turnId: TurnId; status: 'done' | 'error' | 'cancelled' };

export interface ApiError {
  code: string;
  message: string;
  detail?: unknown;
}

/** 会话快照，用于刷新后恢复。 */
export interface SessionSnapshot {
  threadId: ThreadId;
  messages: ChatMessage[];
  participants: ModelId[];
}
