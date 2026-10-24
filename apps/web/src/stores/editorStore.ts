/** 编辑器侧的瞬时状态（光标、选区度量）。高频更新，因此与文档状态分离。 */

import { create } from 'zustand';
import type { Position } from '@paperflow/core';

interface EditorState {
  cursor: Position;
  selectedLines: number;
  selectedChars: number;
  /** 编辑器是否持有焦点，用于决定是否显示浮动工具栏。 */
  focused: boolean;
  setCursor: (cursor: Position) => void;
  setSelectionMetrics: (lines: number, chars: number) => void;
  setFocused: (focused: boolean) => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  cursor: { line: 1, column: 1 },
  selectedLines: 0,
  selectedChars: 0,
  focused: false,
  setCursor: (cursor) => set({ cursor }),
  setSelectionMetrics: (selectedLines, selectedChars) => set({ selectedLines, selectedChars }),
  setFocused: (focused) => set({ focused }),
}));
