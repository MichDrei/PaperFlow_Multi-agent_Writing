/**
 * Monaco 初始化：本地打包（不依赖 CDN），并注册 LaTeX 语言与主题。
 * 必须在任何 <Editor /> 挂载前执行，因此由 main.tsx 直接 import。
 */

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { registerLatexLanguages } from './latex-language';

interface MonacoEnvironmentLike {
  getWorker(moduleId: string, label: string): Worker;
}

(globalThis as unknown as { MonacoEnvironment: MonacoEnvironmentLike }).MonacoEnvironment = {
  getWorker() {
    // LaTeX/BibTeX 走 Monarch 词法，不需要额外语言服务 worker。
    return new EditorWorker();
  },
};

registerLatexLanguages(monaco);
loader.config({ monaco });

/** 文件扩展名 → Monaco 语言 id。 */
export function languageForPath(path: string): string {
  if (path.endsWith('.bib')) return 'bibtex';
  if (path.endsWith('.tex') || path.endsWith('.sty') || path.endsWith('.cls')) return 'latex';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.py')) return 'python';
  return 'plaintext';
}
