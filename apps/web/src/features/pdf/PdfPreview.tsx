/**
 * PDF 预览（pdf.js）。
 *
 * 除了渲染，它还承担"源码 ↔ 产物"的联动：
 * 编译结果里的 anchors（源码行 → 页码 + y 坐标）让我们能实现 SyncTeX 式的
 * 双向定位——AI 提议应用后自动跳到受影响的那一页并高亮对应行。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Info,
  Maximize2,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { CompileDiagnostic } from '@paperflow/core';
import { Button, EmptyState, IconButton, Segmented } from '@paperflow/ui';
import type { LatexEngine } from '@paperflow/core';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { PdfDocumentView, type PdfPoint, type PdfSelection } from './PdfDocumentView';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;


/**
 * SyncTeX 定位开关，默认关闭。
 *
 * 打开方式：`VITE_SYNCTEX=1 npm run dev:web`。
 * 关掉的原因：当前实现按"最内层包含框"选记录，在有浮动图的版面上会命中图的框，
 * 给出错误的行号（详见 synctex.ts 的注释与 README）。文本匹配反而更可靠，
 * 而且能给出列区间、真正高亮到词。
 */
const SYNCTEX_ENABLED = ((import.meta.env.VITE_SYNCTEX as string | undefined) ?? '') === '1';

export function PdfPreview() {
  const pdfUrl = useWorkspaceStore((s) => s.compileState.pdfUrl);
  const compileStatus = useWorkspaceStore((s) => s.compileState.status);
  const anchors = useWorkspaceStore((s) => s.compileState.anchors);
  const diagnostics = useWorkspaceStore((s) => s.compileState.diagnostics);
  const log = useWorkspaceStore((s) => s.compileState.log);
  const compiledAt = useWorkspaceStore((s) => s.compileState.compiledAt);
  const engine = useWorkspaceStore((s) => s.compileState.engine);
  const durationMs = useWorkspaceStore((s) => s.compileState.durationMs);
  const highlightRange = useWorkspaceStore((s) => s.highlightRange);
  const reveal = useWorkspaceStore((s) => s.reveal);
  const locateTextInSource = useWorkspaceStore((s) => s.locateTextInSource);
  const locatePdfPoint = useWorkspaceStore((s) => s.locatePdfPoint);
  const compile = useWorkspaceStore((s) => s.compile);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.15);
  const [error, setError] = useState<string | null>(null);
  /** PDF→源码定位的结果提示（找不到时要说清楚，而不是静默无反应）。 */
  const [locateNotice, setLocateNotice] = useState<string | null>(null);
  /** 同时只保留一个隐藏定时器：否则上一次的定时器会把新提示提前清掉（实测踩过）。 */
  const locateTimerRef = useRef<number | null>(null);
  const flashLocate = (text: string) => {
    setLocateNotice(text);
    if (locateTimerRef.current !== null) window.clearTimeout(locateTimerRef.current);
    locateTimerRef.current = window.setTimeout(() => setLocateNotice(null), 4000);
  };
  const [footer, setFooter] = useState<'log' | 'problems'>('problems');
  /**
   * 诊断面板默认**折叠**。
   * 它是按需查看的信息，却会占掉 50~130px——而 PDF 连续滚动需要尽可能高的可视区
   * （实测默认展开时滚动区只剩 124px，根本没法用滚轮翻页）。
   * 折叠后计数仍然在底栏显示，不会漏掉错误。
   */
  const [footerOpen, setFooterOpen] = useState(false);
  // 编译引擎：相当于 Overleaf 左上角的下拉框。auto 会按内容自动判断（含中文时补 CJK 支持）。
  const [engineChoice, setEngineChoice] = useState<LatexEngine>('auto');
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const activeFile = useWorkspaceStore((s) => s.activeFile());
  const setRootFile = useWorkspaceStore((s) => s.setRootFile);
  // 编译的是"主文档"，不是"你正在看的文件"。两者不一致时必须让用户看得见，
  // 否则会出现"我明明在编译 A，报错却是 B"这种极难排查的情况。
  const activeIsTex = activeFile.kind === 'tex';
  const activeIsRoot = activeFile.path === rootPath;

  /** 源码定位锚点对应的页码（1 起）；没有锚点时为空。 */
  const anchorPage = useMemo(() => {
    if (!highlightRange || anchors.length === 0) return undefined;
    const anchor = anchors.find(
      (a) => a.line >= highlightRange.startLine && a.line <= highlightRange.endLine,
    );
    return anchor ? anchor.page + 1 : undefined;
  }, [highlightRange, anchors]);

  const errorCount = diagnostics.filter((d) => d.level === 'error').length;
  const warningCount = diagnostics.filter((d) => d.level === 'warning').length;
  const problems = diagnostics;

  // 2) 连续滚动 + 文本层由 PdfDocumentView 负责；
  //    这里只保留"源码改动后跳到受影响页"的能力（锚点来自编译器）。
  useEffect(() => {
    if (anchorPage) setPage(anchorPage);
  }, [anchorPage]);

  /** PDF 里双击选中文字 → 源码定位。 */
  const handleLocate = useCallback(
    async (point: PdfPoint, selection: PdfSelection, ratio: number) => {
      /*
       * 定位策略：**文本匹配优先**。
       *
       * 顺序是踩过坑才定下来的：
       * · SyncTeX 本该更准，但当前实现在"浮动图"密集的版面上会把 figure 的框
       *   当成命中对象（实测点标题返回 figure 内部的行号），所以它只作为实验特性，
       *   需要显式打开（VITE_SYNCTEX=1）；
       * · 文本匹配虽然依赖 pdf.js 文本层给出的词，但它能给出**精确的列区间**，
       *   于是能真正把那个词选中并高亮——而 SyncTeX 只给行，高亮不出东西来。
       */
      if (SYNCTEX_ENABLED) {
        const precise = await locatePdfPoint(point.page, point.x, point.y, point.pageHeight);
        if (precise.ok) {
          flashLocate(`SyncTeX：已跳到 ${precise.file}:${precise.line}`);
          return;
        }
      }

      if (selection.word.length >= 2) {
        // 带上同一行的左右文字：同一个词常出现几十次，靠上下文才能选中正确那一处
        const result = locateTextInSource(selection.word, {
          ratio,
          before: selection.before,
          after: selection.after,
        });
        if (result.ok) {
          flashLocate(`已跳到 ${result.file}:${result.line}:${result.column ?? 1}`);
          return;
        }
        flashLocate(`源码里没找到「${selection.word}」（可能跨了公式或宏定义）`);
      } else {
        flashLocate('没识别到词：请双击在正文文字上');
      }
    },
    [locatePdfPoint, locateTextInSource],
  );

  const stepPage = (delta: number) => {
    // 只改页码：PdfDocumentView 会在页码"由外部改动"时平滑滚过去
    setPage((p) => Math.min(Math.max(1, p + delta), Math.max(1, numPages)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-925">
      {/*
        工具栏用具名分组 + 允许换行。
        之前是单行不换行：左右分栏时面板只有约 336px，而内容需要 760px，
        于是"重新编译"被截成"重新"、引擎选择器错位。现在窄了就整组换到下一行。
      */}
      <header className="@container flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-ink-800 px-2.5 py-1 whitespace-nowrap">
        <span className="shrink-0 text-[11px] font-semibold tracking-wide text-ink-300 uppercase">PDF</span>
        {engine && (
          <span
            className={`rounded px-1 text-[9.5px] ${
              engine === 'mock'
                ? 'bg-accent-amber/15 text-accent-amber'
                : 'bg-accent-teal/15 text-accent-teal'
            }`}
            title={
              engine === 'mock'
                ? '浏览器内近似排版：不解析真实 LaTeX 结构，作者块/表格/公式会失真。请确认后端已启动（npm run dev）。'
                : '真实 TeX 引擎（Tectonic / XeLaTeX）：正确解析作者块、三线表、公式与中文。'
            }
          >
            {engine === 'mock' ? '近似排版' : engine}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] whitespace-nowrap text-ink-500">
          {compileStatus === 'compiling' && <span className="text-brand-400">编译中…</span>}
          {compileStatus === 'ok' && (
            <span className="text-accent-teal">
              编译成功{typeof durationMs === 'number' ? ` · ${durationMs}ms` : ''}
            </span>
          )}
          {compileStatus === 'error' && <span className="text-accent-rose">编译失败</span>}
          {compiledAt && compileStatus !== 'compiling' && (
            <span className="text-ink-500">· {new Date(compiledAt).toLocaleTimeString()}</span>
          )}
        </span>

        <div className="ml-auto hidden shrink-0 items-center gap-1 @[190px]:flex">
          {numPages > 0 && (
            <>
              <IconButton title="上一页" icon={<ChevronLeft className="size-3.5" />} onClick={() => stepPage(-1)} />
              <span className="min-w-[52px] shrink-0 text-center font-mono text-[11px] whitespace-nowrap text-ink-400">
                {page} / {numPages}
              </span>
              <IconButton title="下一页" icon={<ChevronRight className="size-3.5" />} onClick={() => stepPage(1)} />
            </>
          )}
        </div>

        {/* 缩放单独成组：窄面板（<300px）时收起，避免工具栏堆成五行 */}
        <div className="hidden shrink-0 items-center gap-1 @[300px]:flex">
          {numPages > 0 && (
            <>
              <IconButton title="缩小" icon={<ZoomOut className="size-3.5" />} onClick={() => setScale((s) => Math.max(0.4, +(s - 0.1).toFixed(2)))} />
              <span className="w-9 shrink-0 text-center font-mono text-[11px] whitespace-nowrap text-ink-400">
                {Math.round(scale * 100)}%
              </span>
              <IconButton title="放大" icon={<ZoomIn className="size-3.5" />} onClick={() => setScale((s) => Math.min(3, +(s + 0.1).toFixed(2)))} />
              <IconButton title="适宽" icon={<Maximize2 className="size-3.5" />} onClick={() => setScale(1.15)} />
            </>
          )}
        </div>

        {/*
          下面两组刻意放在 ml-auto 容器的**外面**：
          只有拆成独立分组，flex-wrap 才有地方断行。之前它们和页码/缩放同属一个
          不可压缩的容器，整组 440px 宽，窄面板下既换不了行也放不下。
        */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/*
            引擎选择用原生下拉框而不是四段按钮组：
            四段（自动/XeLaTeX/pdfLaTeX/LuaLaTeX）光文字就要 290px 以上，
            左右分栏时 PDF 面板常只有 200~300px，怎么换行都放不下。
            下拉框宽度固定且可收缩，交互也和 Overleaf 的编译器下拉一致。
          */}
          <label
            className="flex shrink-0 items-center gap-1 text-[10.5px] text-ink-500"
            title="编译引擎（对应 Overleaf 左上角的编译器下拉框）"
          >
            <span className="hidden @[340px]:inline">引擎</span>
            <select
              value={engineChoice}
              onChange={(e) => {
                const value = e.target.value as LatexEngine;
                setEngineChoice(value);
                // 切引擎后自动重编一次，省得用户再点一下
                void compile({ engine: value });
              }}
              className="max-w-[92px] rounded border border-ink-700 bg-ink-900 px-1 py-[2px] text-[10.5px] text-ink-200 outline-none hover:border-ink-600 focus:border-brand-600/60"
            >
              <option value="auto">自动</option>
              <option value="xelatex">XeLaTeX</option>
              <option value="pdflatex">pdfLaTeX</option>
              <option value="lualatex">LuaLaTeX</option>
            </select>
          </label>
          {/*
            只留图标 + 悬浮提示：中文按字断行，宽度再宽也可能被上层压缩；
            去掉文字是物理上不可能换行的做法（空间紧时反而更清爽）。
          */}
          <Button
            size="xs"
            variant="outline"
            title={compileStatus === 'compiling' ? '正在编译…' : '编译（Ctrl/⌘+Enter）'}
            className="size-6 shrink-0 justify-center p-0"
            icon={<RefreshCw className={`size-3 ${compileStatus === 'compiling' ? 'animate-spin' : ''}`} />}
            onClick={() => void compile({ engine: engineChoice })}
            disabled={compileStatus === 'compiling'}
          />
        </div>
      </header>

      {/*
        主文档提示单独一行：它是"信息"而不是"操作"，塞进工具栏只会让窄面板更挤。
        只有当正在编辑的文件不是主文档时才出现——那正是最容易搞混的时候。
      */}
      {activeIsTex && !activeIsRoot && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-accent-amber/25 bg-accent-amber/8 px-2.5 py-1 text-[10.5px] text-accent-amber">
          {/* 文字要短：窄面板里 flex-1 + truncate 会把长句截没，只剩一个孤零零的按钮 */}
          <span className="min-w-0 flex-1 truncate" title={`编译的是主文档：${rootPath}；你正在编辑：${activeFile.path}`}>
            编译的是主文档 <span className="font-mono">{rootPath}</span>
          </span>
          <Button
            size="xs"
            variant="outline"
            className="shrink-0 whitespace-nowrap"
            onClick={async () => {
              await setRootFile(activeFile.path);
              void compile({ engine: engineChoice });
            }}
          >
            编译当前文件
          </Button>
        </div>
      )}

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto bg-ink-950 p-3">
        {!pdfUrl && (
          <EmptyState
            icon={<FileWarning className="size-7" />}
            title="还没有 PDF 产物"
            hint="点击右上角「重新编译」，或在顶栏按 Ctrl/⌘+Enter。当前使用浏览器端 Mock 编译器，无需本地 TeX 环境。"
          />
        )}
        {error && (
          <div className="m-4 rounded-lg border border-accent-rose/40 bg-accent-rose/10 p-3 text-xs text-accent-rose">
            {error}
          </div>
        )}
        {pdfUrl && !error && (
          <PdfDocumentView
            pdfUrl={pdfUrl}
            scale={scale}
            page={page}
            onPageChange={(next, total) => {
              setPage(next);
              setNumPages(total);
            }}
            onLocate={handleLocate}
            highlightPage={anchorPage}
          />
        )}

        {/* PDF→源码定位的结果提示 */}
        {locateNotice && (
          <div
            data-locate-notice
            className="pf-enter pointer-events-none absolute inset-x-2 bottom-2 rounded-md border border-brand-600/40 bg-ink-900/95 px-2.5 py-1.5 text-[10.5px] text-brand-200 shadow-lg"
          >
            {locateNotice}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-ink-800 bg-ink-900">
        <div className="flex h-8 items-center gap-2 px-2.5">
          <Segmented
            value={footer}
            onChange={(value) => {
              // 再点当前项 = 折叠/展开，这样既切换内容也能收回空间
              if (footerOpen && value === footer) setFooterOpen(false);
              else {
                setFooter(value);
                setFooterOpen(true);
              }
            }}
            options={[
              { value: 'problems', label: `问题 ${problems.length}` },
              { value: 'log', label: '编译日志' },
            ]}
          />
          <button
            type="button"
            onClick={() => setFooterOpen((v) => !v)}
            title={footerOpen ? '收起诊断面板（把空间让给 PDF）' : '展开诊断面板'}
            className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
          >
            {footerOpen ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          </button>
          <div className="ml-auto flex items-center gap-3 text-[11px]">
            {errorCount > 0 && <span className="text-accent-rose">{errorCount} 个错误</span>}
            {warningCount > 0 && <span className="text-accent-amber">{warningCount} 个警告</span>}
            {errorCount === 0 && warningCount === 0 && compileStatus === 'ok' && (
              <span className="text-accent-teal">无诊断信息</span>
            )}
          </div>
        </div>
        {footerOpen && (
        <div className="max-h-32 overflow-auto border-t border-ink-850 px-2.5 py-1.5">
          {footer === 'log' ? (
            <pre className="font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-400">{log}</pre>
          ) : problems.length === 0 ? (
            <p className="py-2 text-[11px] text-ink-500">没有错误或警告。</p>
          ) : (
            <ul className="space-y-0.5">
              {problems.map((d, idx) => (
                <DiagnosticRow key={idx} diagnostic={d} onJump={() => reveal(d.line)} />
              ))}
            </ul>
          )}
        </div>
        )}
      </footer>
    </div>
  );
}

function DiagnosticRow({ diagnostic, onJump }: { diagnostic: CompileDiagnostic; onJump: () => void }) {
  const isError = diagnostic.level === 'error';
  return (
    <li>
      <button
        type="button"
        onClick={onJump}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-ink-850"
      >
        {isError ? (
          <AlertTriangle className="size-3 shrink-0 text-accent-rose" />
        ) : (
          <Info className="size-3 shrink-0 text-accent-amber" />
        )}
        <span className={`shrink-0 font-mono ${isError ? 'text-accent-rose' : 'text-accent-amber'}`}>
          {diagnostic.file}:{diagnostic.line}
        </span>
        <span className="truncate text-ink-300">{diagnostic.message}</span>
      </button>
    </li>
  );
}

/** 把 anchors（PDF 点坐标）换算成当前视口下的 CSS 像素矩形。 */
