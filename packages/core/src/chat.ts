/**
 * 群聊会话（Thread）领域模型：一条线程里人和多个模型混排发言。
 */

import type { FileId } from './document.js';
import type { Selection } from './edit.js';
import type { AgentRole, ModelId, Usage } from './model.js';

export type MessageId = string;
export type ThreadId = string;
export type TurnId = string;

export type MessageAuthor =
  /** 人的发言。`remote` 表示"别人发的"（决定气泡左右与是否显示名字）。 */
  | { kind: 'user'; name?: string; remote?: boolean }
  | { kind: 'model'; modelId: ModelId; role: AgentRole }
  /** 系统旁白：例如"编排器已让 GPT-4o 评审 Claude 的改写"。 */
  | { kind: 'system'; label: string };

export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error';

/** 一次 @提及：既记录原始写法，也记录解析出的模型。 */
export interface Mention {
  raw: string;
  modelId: ModelId;
}

export interface ChatMessage {
  id: MessageId;
  threadId: ThreadId;
  author: MessageAuthor;
  /** Markdown / LaTeX 混合文本。 */
  text: string;
  createdAt: string;
  status: MessageStatus;
  /** 消息属于哪个通道：缺省视为公聊（房间）。 */
  channel?: 'room' | 'private';
  /** 私聊时属于哪个会话（用于多个私聊对话之间隔离上下文）。 */
  privateThread?: string;
  mentions?: Mention[];
  /** 该条消息针对的编辑器选区（发出去时快照，避免随后选区变化导致语义漂移）。 */
  selection?: Selection;
  /** 若该消息附带编辑提议，指向 EditProposal.id。 */
  proposalId?: string;
  /** 引用的其他消息（用于"请评审上一条"这类交叉评审）。 */
  replyToId?: MessageId;
  usage?: Usage;
  error?: string;
}

export interface Thread {
  id: ThreadId;
  title: string;
  messages: ChatMessage[];
  /** 当前在房间里的模型（决定未 @任何人时的默认扇出目标）。 */
  participants: ModelId[];
  /** 默认阵容里"主答"的模型。 */
  leadModelId?: ModelId;
  createdAt: string;
}

export type TurnStatus = 'running' | 'done' | 'error' | 'cancelled';

/** 一次用户提问触发的编排回合。 */
export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  prompt: string;
  /** 解析后的目标模型。 */
  targets: ModelId[];
  /** 未 @时的默认阵容快照。 */
  selection?: Selection;
  status: TurnStatus;
  createdAt: string;
}

/** 群聊面板里用于渲染模型阵容的条目。 */
export interface RoomMember {
  modelId: ModelId;
  role: AgentRole;
  /** 本轮是否已被点名。 */
  mentioned?: boolean;
  busy?: boolean;
}
