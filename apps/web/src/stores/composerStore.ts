/** 输入框状态：草稿、@提及追加、聚焦请求。与消息线程解耦，避免无谓重渲染。 */

import { create } from 'zustand';
import type { ModelId } from '@paperflow/core';

export interface QuotedAnswer {
  messageId: string;
  /** 模型消息才有；引用「人」的消息时为空（不自动 @ 模型）。 */
  modelId?: string;
  preview: string;
}

interface ComposerState {
  draft: string;
  /** 递增令牌：变化时 Composer 会把焦点移回输入框。 */
  focusToken: number;
  /** 被引用的历史回答：发送时一并交给服务端，模型必须针对它发言。 */
  quoted: QuotedAnswer | null;
  setDraft: (draft: string) => void;
  appendMention: (modelId: ModelId) => void;
  setDraftAndFocus: (draft: string) => void;
  requestFocus: () => void;
  quoteAnswer: (answer: QuotedAnswer) => void;
  clearQuote: () => void;
}

export const useComposerStore = create<ComposerState>()((set) => ({
  draft: '',
  focusToken: 0,
  quoted: null,
  setDraft: (draft) => set({ draft }),
  appendMention: (modelId) =>
    set((state) => ({
      draft: `${state.draft}${state.draft && !state.draft.endsWith(' ') ? ' ' : ''}@${modelId} `,
      focusToken: state.focusToken + 1,
    })),
  setDraftAndFocus: (draft) => set((state) => ({ draft, focusToken: state.focusToken + 1 })),
  requestFocus: () => set((state) => ({ focusToken: state.focusToken + 1 })),

  /** 点消息上的「引用」：把那条回答挂到输入框，并自动 @ 该模型方便继续追问。 */
  quoteAnswer: (answer) =>
    set((state) => ({
      quoted: answer,
      focusToken: state.focusToken + 1,
      draft: state.draft.trim().length > 0 ? state.draft : `请评价 @${answer.modelId} 的上面这条回答：`,
    })),

  clearQuote: () => set({ quoted: null }),
}));
