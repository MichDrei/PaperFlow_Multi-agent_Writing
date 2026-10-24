/**
 * 连续滚动的 PDF 视图（含可选中文本层）。
 *
 * 两个能力，对应 Overleaf 的体验：
 * 1. **滚轮上下翻页**：所有页在同一个滚动容器里纵向排列，滚动时自动更新页码；
 *    左右翻页按钮仍然保留，但语义变成"滚到某一页"（惯性滚动，而不是切页）。
 * 2. **选中文字 → 跳回源码**：每页覆盖一层 pdf.js 文本层，
 *    双击选中的词句会回调 `onLocate`，由上层在 .tex 里定位到对应行。
 *
 * 性能：一篇带十几张大图的论文一次渲染全部页会很慢，所以只渲染"当前页 ±1"的
 * 页面（其余先占位），滚动到附近再渲染。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { PDFJS_ASSET_OPTIONS } from '@/lib/pdf';

/**
 * 从 PDF 文本层取出的选中内容。
 *
 * 为什么不用 `window.getSelection()`：pdf.js 的文本层粒度是**混的**且会**重叠**——
 * 同一行既有整行 span，又有逐词 span。浏览器按 DOM 文本节点选词，就可能落到
 * 相邻/重叠的另一个 span 上（实测：双击 wrench 却拿到 the）。
 * 所以这里自己按坐标找 span、按横向比例算字符位置，完全绕开浏览器选区。
 */
export interface PdfSelection {
  /** 命中处的词（已去掉首尾标点）。 */
  word: string;
  /** 同一行里左侧的文字（用于在源码中消歧）。 */
  before: string;
  /** 同一行里右侧的文字。 */
  after: string;
}

/** 点击位置换算后的 PDF 坐标（bp，原点在页面左下角）。 */
export interface PdfPoint {
  page: number;
  x: number;
  y: number;
  pageHeight: number;
}

interface PageBox {
  pageNumber: number;
  width: number;
  height: number;
}

export interface PdfDocumentViewProps {
  pdfUrl: string;
  scale: number;
  /** 当前页（1 起）。外部改动它时视图会滚过去。 */
  page: number;
  onPageChange: (page: number, total: number) => void;
  /**
   * 点击 PDF 时的定位回调。
   * @param point 点击位置换算成 bp（1/72 英寸，原点在页面左下角）
   * @param text 当前选中的文字（SyncTeX 不可用时用它兜底匹配）
   * @param ratio 点击处占全文的比例（兜底匹配时用于消歧）
   */
  onLocate: (point: PdfPoint, selection: PdfSelection, ratio: number) => void;
  /** 需要高亮定位结果的页码（1 起），来自源码→PDF 的跳转。 */
  highlightPage?: number;
}

export function PdfDocumentView({
  pdfUrl,
  scale,
  page,
  onPageChange,
  onLocate,
  highlightPage,
}: PdfDocumentViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderedRef = useRef<Set<number>>(new Set());
  const [numPages, setNumPages] = useState(0);
  const [boxes, setBoxes] = useState<PageBox[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 只有"当前页 ±1"需要真正渲染；用一个状态驱动，避免整册重渲
  const [renderWindow, setRenderWindow] = useState(1);
  /** 正在渲染中的页，避免重复触发。 */
  const renderingRef = useRef<Set<number>>(new Set());
  /**
   * 程序化滚动锁。
   *
   * 平滑滚动到目标页的过程中，滚动事件会依次经过中间页并把它们上报给上层，
   * 上层再把页码传回来——于是守卫认为"用户改了页"，又发起一次滚动，把动画打断在中间页。
   * 实测表现：点「上一页」页码纹丝不动。加锁后，动画期间只认目标页。
   */
  const scrollLockRef = useRef<{ target: number; until: number } | null>(null);

  // ① 载入文档并预取每页尺寸（不渲染，很快），用于先撑出占位高度
  useEffect(() => {
    let disposed = false;
    setError(null);
    setNumPages(0);
    setBoxes([]);
    renderedRef.current.clear();
    renderingRef.current.clear();
    docRef.current?.destroy();
    docRef.current = null;

    const task = pdfjs.getDocument({ url: pdfUrl, ...PDFJS_ASSET_OPTIONS });
    task.promise
      .then(async (doc) => {
        if (disposed) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        const next: PageBox[] = [];
        for (let i = 1; i <= doc.numPages; i += 1) {
          const pdfPage = await doc.getPage(i);
          const viewport = pdfPage.getViewport({ scale });
          next.push({ pageNumber: i, width: viewport.width, height: viewport.height });
        }
        if (!disposed) setBoxes(next);
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : 'PDF 解析失败');
      });

    return () => {
      disposed = true;
      void docRef.current?.destroy();
      docRef.current = null;
    };
    // scale 变化时重新算尺寸；这里刻意不带 scale，缩放由下面的尺寸重算处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl]);

  // ② 缩放变化：重算版式尺寸并让已渲染的页失效
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || numPages === 0) return;
    let disposed = false;
    void (async () => {
      const next: PageBox[] = [];
      for (let i = 1; i <= numPages; i += 1) {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale });
        next.push({ pageNumber: i, width: viewport.width, height: viewport.height });
      }
      if (disposed) return;
      renderedRef.current.clear();
      renderingRef.current.clear();
      setBoxes(next);
    })();
    return () => {
      disposed = true;
    };
  }, [scale, numPages]);

  // ③ 渲染单页（canvas + 文本层）
  const renderPage = useCallback(
    async (pageNumber: number) => {
      const doc = docRef.current;
      const host = pageRefs.current.get(pageNumber);
      if (!doc || !host || renderedRef.current.has(pageNumber) || renderingRef.current.has(pageNumber)) return;
      renderingRef.current.add(pageNumber);
      try {
        const pdfPage = await doc.getPage(pageNumber);
        const viewport = pdfPage.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const canvas = host.querySelector('canvas');
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({
          canvasContext: context,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;

        // 文本层：只有它存在，PDF 里的文字才能被选中
        const textLayerHost = host.querySelector('.pf-text-layer');
        if (textLayerHost) {
          textLayerHost.replaceChildren();
          const textLayer = new pdfjs.TextLayer({
            textContentSource: pdfPage.streamTextContent(),
            container: textLayerHost as HTMLElement,
            viewport,
          });
          await textLayer.render();
        }
        renderedRef.current.add(pageNumber);
      } catch (err) {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(err instanceof Error ? err.message : '渲染失败');
        }
      } finally {
        renderingRef.current.delete(pageNumber);
      }
    },
    [scale],
  );

  // ④ 滚动：更新当前页（取视口中心所在的那一页），并扩大渲染窗口
  //
  // ⚠️ 监听器**只注册一次**（依赖里只有 boxes）。
  // 早先把 page / onPageChange 放进依赖，导致每次页码变化都重新注册并立即执行一次 onScroll，
  // 而那一瞬间滚动位置还停在"途经页"上，于是刚发出的跳页立刻被顶回去——
  // 实测表现为翻页按钮点了完全没反应。最新值一律通过 ref 读取。
  const pageStateRef = useRef(page);
  useEffect(() => {
    pageStateRef.current = page;
  }, [page]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || boxes.length === 0) return;

    const pageAt = (scrollTop: number): number => {
      const center = scrollTop + container.clientHeight / 2;
      let acc = 0;
      let current = 1;
      for (const box of boxes) {
        if (center < acc + box.height) return box.pageNumber;
        acc += box.height;
        current = box.pageNumber;
      }
      return current;
    };

    const onScroll = () => {
      const lock = scrollLockRef.current;
      if (lock && Date.now() < lock.until) {
        // 程序化滚动进行中：只跟随目标页，忽略途经页
        setRenderWindow(lock.target);
        return;
      }
      scrollLockRef.current = null;
      const current = pageAt(container.scrollTop);
      setRenderWindow(current);
      if (current !== pageStateRef.current) {
        lastReportedRef.current = current; // 这是"用户滚动"造成的，记下来避免回环
        onPageChangeRef.current?.(current, numPagesRef.current);
      }
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener('scroll', onScroll);
  }, [boxes]);

  // ④b 文档加载完就把**总页数**告诉上层。
  // 只在"页码变化"时通知是不够的：初始时当前页就是 1，与外部状态相同，
  // 于是上层永远拿不到总页数，页码指示器（1 / 8）就永远不显示。
  useEffect(() => {
    if (numPages > 0) onPageChange(renderWindow, numPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPages]);

  // ⑤ 只渲染当前页 ±1
  //
  // ⚠️ 依赖里必须带 boxes.length：页面 DOM 引用（pageRefs）是在 boxes 渲染之后才注册的。
  // 少了它，首次渲染请求会发生在占位 DOM 出现之前（pageRefs 为空）而直接返回，
  // 之后又没有任何变化能再触发一次——表现为 canvas 停在默认的 300x150、整页空白。
  useEffect(() => {
    if (boxes.length === 0) return;
    const wanted = [renderWindow - 1, renderWindow, renderWindow + 1].filter(
      (n) => n >= 1 && n <= numPages,
    );
    for (const n of wanted) void renderPage(n);
  }, [renderWindow, numPages, renderPage, boxes.length]);

  // ⑥ 外部请求跳到某一页（翻页按钮 / 源码定位）
  const scrollToPage = useCallback((target: number, behavior: ScrollBehavior = 'smooth') => {
    const container = scrollRef.current;
    const box = pageRefs.current.get(target);
    if (!container || !box) return;
    scrollLockRef.current = { target, until: Date.now() + 1200 };
    container.scrollTo({ top: box.offsetTop - 8, behavior });
    // 动画结束后解锁（并在落点处确认一次页码）
    window.setTimeout(() => {
      if (scrollLockRef.current?.target !== target) return;
      scrollLockRef.current = null;
      lastReportedRef.current = target;
      onPageChangeRef.current?.(target, numPagesRef.current);
    }, 1250);
  }, []);

  // 定时器里要用到最新的回调与页数，用 ref 兜住，避免把 scrollToPage 变成每次都变的新函数
  const onPageChangeRef = useRef(onPageChange);
  const numPagesRef = useRef(numPages);
  useEffect(() => {
    onPageChangeRef.current = onPageChange;
    numPagesRef.current = numPages;
  }, [onPageChange, numPages]);

  useEffect(() => {
    if (page >= 1 && boxes.length > 0) scrollToPage(page, 'auto');
    // 只在外部页码变化时滚动；用户自己滚动引起的 page 变化由 ④ 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightPage]);

  /**
   * 外部改了页码（翻页按钮 / 源码定位锚点）时滚过去；
   * 用户自己滚动引起的页码变化要忽略，否则会和滚动事件形成回环、页面抖个不停。
   */
  const lastReportedRef = useRef(0);
  useEffect(() => {
    if (page === lastReportedRef.current) return;
    if (page < 1 || boxes.length === 0) return;
    // 在这里（而不是另一个 effect 里）更新 ref：
    // 两个 effect 之间会有执行顺序竞争——若"记录"先跑，守卫就会误判成"自己滚的"而拒绝跳页，
    // 表现为翻页按钮点了没反应。
    lastReportedRef.current = page;
    scrollToPage(page, 'smooth');
  }, [page, boxes.length, scrollToPage]);

  /**
   * 点击/双击文本层 → 交给上层定位。
   *
   * 取词完全自主完成：找**包含点击点的最小 span**（最具体的那层），
   * 再按横向比例定位到字符、扩展到词边界；上下文取同一行其它 span 的文字。
   */
  const handleLocateEvent = useCallback(
    (event: React.MouseEvent) => {
      const host = (event.currentTarget as HTMLElement).closest('[data-page-number]') as HTMLElement | null;
      if (!host) return;
      const pageNumber = Number(host.dataset.pageNumber);
      const box = pageRefs.current.get(pageNumber);
      if (!box) return;

      const rect = box.getBoundingClientRect();
      const heightBp = box.offsetHeight / scale;
      const point: PdfPoint = {
        page: pageNumber,
        x: (event.clientX - rect.left) / scale,
        y: heightBp - (event.clientY - rect.top) / scale, // PDF 原点在左下
        pageHeight: heightBp,
      };
      const selection = wordAtPoint(event.clientX, event.clientY, box);
      const container = scrollRef.current;
      const ratio = container
        ? Math.max(
            0,
            Math.min(
              1,
              (container.scrollTop + event.clientY - container.getBoundingClientRect().top) /
                Math.max(1, container.scrollHeight),
            ),
          )
        : 0;
      onLocate(point, selection, ratio);
    },
    [onLocate, scale],
  );

  const totalHeight = useMemo(() => boxes.reduce((sum, b) => sum + b.height + 12, 0), [boxes]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-[11.5px] text-accent-rose">
        PDF 无法渲染：{error}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-auto bg-ink-950 px-3 py-2" data-pdf-scroll>
      <div className="mx-auto w-fit" style={{ minHeight: totalHeight || undefined }}>
        {boxes.map((box) => (
          <div
            key={box.pageNumber}
            ref={(el) => {
              if (el) pageRefs.current.set(box.pageNumber, el);
              else pageRefs.current.delete(box.pageNumber);
            }}
            data-page-number={box.pageNumber}
            className={`relative mb-3 bg-white shadow-2xl shadow-black/60 ring-1 ${
              highlightPage === box.pageNumber ? 'ring-brand-500' : 'ring-ink-800'
            }`}
            style={{ width: Math.floor(box.width), height: Math.floor(box.height) }}
          >
            <canvas className="block" />
            {/* 文本层：双击/拖选都发生在这一层 */}
            {/*
              只绑 onDoubleClick：之前绑了单击，导致在 PDF 里随便点一下代码端就跳走，
              读论文时非常干扰。定位是**刻意动作**，双击才触发。
            */}
            <div
              className="pf-text-layer"
              onDoubleClick={handleLocateEvent}
              title="双击选中文字 → 跳到源码对应位置（并高亮那个词）"
            />
            <span className="pointer-events-none absolute right-1 bottom-1 rounded bg-ink-950/70 px-1 font-mono text-[9px] text-ink-400">
              {box.pageNumber}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


/**
 * 按坐标从文本层取词，并带回同一行的左右上下文。
 *
 * 步骤：
 * 1. 在**包含该点**的 span 里挑**最小**的那个——文本层会重叠，
 *    整行 span 与逐词 span 叠在一起，最小的那个才是视觉上真正生效的文字；
 * 2. 用横向比例把 x 映射到该 span 文字里的字符位置（等宽近似，足够取词）；
 * 3. 向左右扩展到词边界；
 * 4. 取同一行（垂直中心接近）其它 span 的文字作为前后文，交给源码消歧。
 */
function wordAtPoint(clientX: number, clientY: number, pageBox: HTMLElement): PdfSelection {
  const spans = [...pageBox.querySelectorAll<HTMLElement>('.pf-text-layer span')].filter(
    (s) => (s.textContent ?? '').trim().length > 0,
  );

  let hit: HTMLElement | undefined;
  let hitArea = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const r = span.getBoundingClientRect();
    // 纵向留一点余量：字形比 span 的盒子略高
    if (clientX < r.left - 2 || clientX > r.right + 2) continue;
    if (clientY < r.top - 3 || clientY > r.bottom + 3) continue;
    const area = r.width * r.height;
    if (area < hitArea) {
      hitArea = area;
      hit = span;
    }
  }
  if (!hit) return { word: '', before: '', after: '' };

  const raw = hit.textContent ?? '';
  const rect = hit.getBoundingClientRect();
  // 按横向比例估算字符下标（span 内字形宽度不一，但取词够用）
  const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
  let index = Math.min(raw.length - 1, Math.round(ratio * raw.length));

  const isWordChar = (c: string) => /[A-Za-z0-9'\u2019-]/.test(c);
  // 落点在空白/标点上时，就近找一个词字符
  if (!isWordChar(raw[index] ?? '')) {
    let left = index;
    let right = index;
    while (left >= 0 && !isWordChar(raw[left] ?? '')) left -= 1;
    while (right < raw.length && !isWordChar(raw[right] ?? '')) right += 1;
    index = left >= 0 && (index - left <= right - index || right >= raw.length) ? left : right;
  }
  let start = index;
  let end = index + 1;
  while (start > 0 && isWordChar(raw[start - 1] ?? '')) start -= 1;
  while (end < raw.length && isWordChar(raw[end] ?? '')) end += 1;
  const word = raw.slice(start, end).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (!word) return { word: '', before: '', after: '' };

  // 同一行的其它 span：垂直中心接近即视为同一行
  const center = (rect.top + rect.bottom) / 2;
  const sameLine = spans
    .filter((span) => {
      const r = span.getBoundingClientRect();
      return Math.abs((r.top + r.bottom) / 2 - center) < Math.max(4, r.height * 0.6);
    })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

  const lineText = sameLine.map((span) => span.textContent ?? '').join('');
  const beforeText = lineText.slice(0, Math.max(0, lineText.indexOf(raw) + start));
  const afterText = lineText.slice(lineText.indexOf(raw) + end);
  return {
    word,
    before: beforeText.replace(/\s+/g, ' ').trim().slice(-80),
    after: afterText.replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}
