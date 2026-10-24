/** 底部状态栏：编译状态、光标/选区、字数与粗糙 token 估算。 */

import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { countWords, estimateTokens } from '@/lib/rewrite';
import { paperBudgetChars } from '@paperflow/core';
import { useChatStore } from '@/stores/chatStore';
import { sectionAtLine } from '@/lib/latex';

export function StatusBar() {
  const activeFile = useWorkspaceStore((s) => s.activeFile());
  const compileState = useWorkspaceStore((s) => s.compileState);
  const selection = useWorkspaceStore((s) => s.selection);
  const cursor = useEditorStore((s) => s.cursor);
  const selectedLines = useEditorStore((s) => s.selectedLines);

  // 二进制文件（图片/PDF）的内容是 base64，按文本估算 token 毫无意义——
  // 一张 5MB 的 PNG 会被算成十几万 token，把状态栏变成误导信息。
  const isBinary = activeFile.encoding === 'base64';
  const words = isBinary ? 0 : countWords(activeFile.content);
  const tokens = isBinary ? 0 : estimateTokens(activeFile.content);
  // 上下文成本：论文 + 参考资料（这两个是每轮都会注入的大头）。
  // 用与序列化器**同一份**预算公式，避免界面显示与实际发送不一致。
  const references = useWorkspaceStore((s) => s.context.references);
  const catalog = useChatStore((s) => s.catalog);
  const referenceTokens = references.reduce((sum, r) => sum + estimateTokens(r.text), 0);
  const contextTokens = tokens + referenceTokens;
  // 以最小可用模型的窗口为基准做提示——最坏情况才是有意义的提示
  const smallestWindow = catalog.length
    ? Math.min(...catalog.map((m) => m.contextWindow))
    : 64_000;
  const smallestPaperBudget = estimateTokens('x'.repeat(paperBudgetChars(smallestWindow)));
  const overBudget = tokens > smallestPaperBudget;
  const section = sectionAtLine(activeFile.content, cursor.line);
  const errorCount = compileState.diagnostics.filter((d) => d.level === 'error').length;
  const warnCount = compileState.diagnostics.filter((d) => d.level === 'warning').length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-ink-800 bg-ink-925 px-3 text-[10.5px] text-ink-500">
      <span className="flex items-center gap-1.5">
        {compileState.status === 'compiling' && (
          <>
            <Loader2 className="size-3 animate-spin text-brand-400" />
            <span className="text-brand-400">正在编译…</span>
          </>
        )}
        {compileState.status === 'ok' && errorCount === 0 && (
          <>
            <CheckCircle2 className="size-3 text-accent-teal" />
            <span className="text-accent-teal">编译通过</span>
          </>
        )}
        {compileState.status === 'error' && (
          <>
            <AlertCircle className="size-3 text-accent-rose" />
            <span className="text-accent-rose">{errorCount} 个错误</span>
          </>
        )}
        {compileState.status === 'idle' && <span>未编译</span>}
        {warnCount > 0 && compileState.status !== 'error' && (
          <span className="flex items-center gap-1 text-accent-amber">
            <AlertTriangle className="size-3" />
            {warnCount}
          </span>
        )}
      </span>

      <span className="h-3 w-px bg-ink-800" />
      <span className="font-mono">{activeFile.path}</span>
      {section && <span className="truncate text-ink-600">§ {section.title}</span>}

      <span className="ml-auto flex items-center gap-3 font-mono">
        {selection ? (
          <span className="text-brand-300">
            选区 {selectedLines} 行 / {selection.text.length} 字符
          </span>
        ) : (
          <span>
            Ln {cursor.line}, Col {cursor.column}
          </span>
        )}
        {isBinary ? (
          <span className="text-ink-500">
            {activeFile.path.split('.').pop()?.toUpperCase()} 二进制 · {((activeFile.size ?? 0) / 1024).toFixed(1)} KB
          </span>
        ) : (
          <>
            <span>{words} 词</span>
            <span title="当前文件的字符估算（4 字符/token 英文、1.5 中文）">文件 ≈{tokens} tokens</span>
          </>
        )}
        <span
          className={overBudget ? 'text-accent-amber' : undefined}
          title={
            `每轮注入的上下文估算：论文 ${tokens} + 参考资料 ${referenceTokens} tokens。\n` +
            `最小可用模型窗口 ${smallestWindow / 1000}K，其论文预算约 ${smallestPaperBudget} tokens。` +
            (overBudget ? '\n⚠ 论文已超出小窗口模型的预算，会被截断（改用大窗口模型或缩小注入范围）。' : '')
          }
        >
          上下文 ≈{contextTokens} tokens{overBudget ? ' ⚠' : ''}
        </span>
        <span className="text-ink-600">UTF-8</span>
        <span className="text-ink-600">LaTeX</span>
      </span>
    </footer>
  );
}
