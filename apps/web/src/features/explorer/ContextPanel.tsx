/**
 * 共享知识面板：文献库 / 术语表 / 图表。
 *
 * 这是"多模型不跑偏"的物理载体——所有模型在生成时都会拿到这里的内容，
 * 所以此处任何修改都会立刻影响下一轮对话的结果。
 */

import { useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  FileText,
  Loader2,
  Lock,
  LockOpen,
  Plus,
  Quote,
  Search,
  Sigma,
  Trash2,
  Unlink,
  Upload,
} from 'lucide-react';
import { Button, Pill, Segmented } from '@paperflow/ui';
import { extractPdfText, referenceKindForFile } from '@/lib/pdf';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useComposerStore } from '@/stores/composerStore';
import { useChatStore } from '@/stores/chatStore';
import { selectUsableModels } from '@/lib/modelSelection';
import { extractCitationKeys } from '@/lib/latex';

type Tab = 'references' | 'citations' | 'terminology' | 'figures';

export function ContextPanel() {
  const context = useWorkspaceStore((s) => s.context);
  const activeFile = useWorkspaceStore((s) => s.activeFile());
  const updateTerminology = useWorkspaceStore((s) => s.updateTerminology);
  const setDraftAndFocus = useComposerStore((s) => s.setDraftAndFocus);

  const [tab, setTab] = useState<Tab>('references');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const usedKeys = useMemo(() => new Set(extractCitationKeys(activeFile.content)), [activeFile.content]);
  const q = query.trim().toLowerCase();

  const citations = context.citations.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.key.includes(q) || c.tags.some((t) => t.includes(q)),
  );
  const terms = context.terminology.filter(
    (t) => !q || t.term.toLowerCase().includes(q) || t.translation.includes(q),
  );
  const figures = context.figures.filter((f) => !q || f.label.includes(q) || f.caption.toLowerCase().includes(q));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <BookOpen className="size-3 text-ink-500" />
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">共享知识</span>
        <span className="ml-auto font-mono text-[10px] text-ink-600">
          {context.references.length}/{context.citations.length}/{context.terminology.length}/{context.figures.length}
        </span>
      </div>

      <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'references', label: `资料 ${context.references.length}` },
            { value: 'citations', label: `文献 ${citations.length}` },
            { value: 'terminology', label: `术语 ${terms.length}` },
            { value: 'figures', label: `图表 ${figures.length}` },
          ]}
        />
      </div>

      <div className="relative px-2.5 pb-1.5">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3 -translate-y-1/2 text-ink-600" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索共享知识…"
          className="w-full rounded-md border border-ink-750 bg-ink-925 py-1 pr-2 pl-6 text-[11px] text-ink-200 outline-none placeholder:text-ink-600 focus:border-brand-600/60"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {tab === 'citations' && (
          <ul className="space-y-1">
            {citations.map((c) => {
              const used = usedKeys.has(c.key);
              const open = expanded === c.key;
              return (
                <li key={c.key} className="rounded-md border border-ink-800 bg-ink-925/70">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : c.key)}
                    className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left"
                  >
                    <span className={`mt-[3px] size-1.5 shrink-0 rounded-full ${used ? 'bg-accent-teal' : 'bg-ink-600'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] leading-snug text-ink-200">{c.title}</span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-500">
                        {c.key} · {c.authors[0] ?? '—'} {c.year} {c.venue ? `· ${c.venue}` : ''}
                      </span>
                    </span>
                    {!used && (
                      <span title="未被引用">
                        <Unlink className="mt-[2px] size-3 shrink-0 text-ink-600" />
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="border-t border-ink-800 px-2 py-1.5">
                      <p className="text-[10.5px] text-ink-400">{c.authors.join('、')}</p>
                      {c.tags.length > 0 && (
                        <p className="mt-0.5 flex flex-wrap gap-1">
                          {c.tags.map((t) => (
                            <span key={t} className="rounded bg-ink-800 px-1 py-[1px] font-mono text-[9.5px] text-ink-400">
                              {t}
                            </span>
                          ))}
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={() => setDraftAndFocus(`@all 这篇文献（${c.key}）与当前方法的关系是什么？应该如何引用？`)}
                        className="mt-1.5 flex items-center gap-1 rounded border border-brand-600/40 px-1.5 py-[2px] text-[10.5px] text-brand-300 hover:bg-brand-500/10"
                      >
                        <Quote className="size-2.5" />
                        问模型
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {citations.length === 0 && <li className="py-3 text-center text-[11px] text-ink-600">无匹配文献</li>}
          </ul>
        )}

        {tab === 'terminology' && (
          <ul className="space-y-1">
            {terms.map((t) => (
              <li key={t.id} className="rounded-md border border-ink-800 bg-ink-925/70 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Sigma className="size-3 shrink-0 text-accent-violet" />
                  <span className="truncate font-mono text-[11px] text-ink-200">{t.term}</span>
                  <span className="shrink-0 text-ink-600">→</span>
                  <span className="truncate text-[11px] text-accent-teal">{t.translation}</span>
                  <button
                    type="button"
                    title={t.locked ? '已锁定：模型必须遵守' : '未锁定：仅提示'}
                    onClick={() => updateTerminology(t.id, { locked: !t.locked })}
                    className="ml-auto shrink-0 rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                  >
                    {t.locked ? <Lock className="size-3 text-accent-amber" /> : <LockOpen className="size-3" />}
                  </button>
                </div>
                <p className="mt-0.5 text-[10.5px] leading-snug text-ink-500">{t.definition}</p>
                {t.forbidden.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="text-[9.5px] text-ink-600">禁用</span>
                    {t.forbidden.map((f) => (
                      <span key={f} className="rounded bg-accent-rose/12 px-1 py-[1px] font-mono text-[9.5px] text-accent-rose/90">
                        {f}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
            {terms.length === 0 && <li className="py-3 text-center text-[11px] text-ink-600">无匹配术语</li>}
          </ul>
        )}

        {tab === 'references' && (
          <ReferenceTab
            composing={composing}
            onToggleCompose={() => setComposing((v) => !v)}
            query={query}
          />
        )}

        {tab === 'figures' && (
          <ul className="space-y-1">
            {figures.map((f) => (
              <li key={f.id} className="rounded-md border border-ink-800 bg-ink-925/70 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-accent-violet">{f.label}</span>
                  {f.referencedAt?.[0] && (
                    <span className="ml-auto flex items-center gap-1 font-mono text-[9.5px] text-ink-500">
                      <Check className="size-2.5 text-accent-teal" />
                      L{f.referencedAt[0].line}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[10.5px] leading-snug text-ink-400">{f.caption}</p>
                <p className="mt-0.5 font-mono text-[9.5px] text-ink-600">{f.path}</p>
              </li>
            ))}
            {figures.length === 0 && <li className="py-3 text-center text-[11px] text-ink-600">无匹配图表</li>}
          </ul>
        )}
      </div>

      <div className="border-t border-ink-850 px-2.5 py-1.5 text-[10px] leading-snug text-ink-600">
        这些内容会自动注入每一轮对话的上下文，是保证多模型表述一致的关键。
      </div>
    </div>
  );
}

/**
 * 「资料」页：添加参考资料。
 *
 * 三条入口对应三种真实用法：
 *   1. 粘贴文本 —— 摘录一段话、贴一段网页正文；
 *   2. 上传 PDF —— 用 pdf.js 在浏览器端提取正文（不上传二进制）；
 *   3. 上传 .bib —— 交给服务端解析成结构化文献条目（进「文献」页）。
 * 添加后内容立即参与 BM25 检索，并在下一轮对话注入模型上下文。
 */
function ReferenceTab({
  composing,
  onToggleCompose,
  query,
}: {
  composing: boolean;
  onToggleCompose: () => void;
  query: string;
}) {
  const context = useWorkspaceStore((s) => s.context);
  const addReference = useWorkspaceStore((s) => s.addReference);
  const removeReference = useWorkspaceStore((s) => s.removeReference);
  const importBibtex = useWorkspaceStore((s) => s.importBibtex);
  const setDraftAndFocus = useComposerStore((s) => s.setDraftAndFocus);

  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<{ images: string[]; pageCount: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const q = query.trim().toLowerCase();
  const references = context.references.filter(
    (r) => !q || r.title.toLowerCase().includes(q) || r.text.toLowerCase().includes(q),
  );
  // 有页面图像时，提示用户 @ 一个支持视觉的模型才能真正"看图"。
  // ⚠️ 必须用「稳定的 selector + useMemo」：直接在 useChatStore 的 selector 里
  // filter/map 会每次返回新数组，zustand v5 会因此判定快照不稳定并无限重渲染
  // （报错 "Maximum update depth exceeded"）。
  const catalog = useChatStore((s) => s.catalog);
  const backend = useChatStore((s) => s.backend);
  const hasImages = references.some((r) => (r.pageImages?.length ?? 0) > 0);
  const visionModels = useMemo(
    () =>
      selectUsableModels(catalog, backend)
        .filter((m) => m.capabilities.includes('vision'))
        .map((m) => m.id),
    [catalog, backend],
  );

  const handleFile = async (file: File) => {
    const kind = referenceKindForFile(file.name);
    setNotice(null);

    if (kind === 'bibtex') {
      setBusy('正在解析 BibTeX…');
      const content = await file.text();
      const result = await importBibtex(content);
      setBusy(null);
      setNotice(
        result.ok
          ? { kind: 'ok', text: `已从 ${file.name} 导入 ${result.added} 条文献到「文献」页` }
          : { kind: 'err', text: result.error ?? '导入失败' },
      );
      return;
    }

    if (kind === 'pdf') {
      try {
        setBusy('正在提取 PDF 正文…');
        const extracted = await extractPdfText(file, (page, total) => setBusy(`正在提取 PDF：${page}/${total} 页`));
        setBusy(null);
        setTitle((current) => current || file.name.replace(/\.pdf$/i, ''));
        setText(extracted.text);
        setPendingImages({ images: extracted.pageImages, pageCount: extracted.pages });
        setNotice({
          kind: 'ok',
          text: [
            `已读取 ${extracted.pages} 页、${extracted.text.length} 字`,
            extracted.pageImages.length > 0
              ? `并渲染了前 ${extracted.pageImages.length} 页图像（视觉模型可直接看图，无需 OCR）`
              : '',
            extracted.emptyPages > 0 ? `注意：${extracted.emptyPages} 页没有文字层` : '',
          ]
            .filter(Boolean)
            .join('；'),
        });
      } catch (err) {
        setBusy(null);
        setNotice({ kind: 'err', text: `PDF 解析失败：${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }

    // 纯文本 / Markdown / LaTeX
    const content = await file.text();
    setTitle((current) => current || file.name);
    setText(content);
    setNotice({ kind: 'ok', text: `已读取 ${file.name}（${content.length} 字），请确认标题后点「添加」` });
  };

  const submit = async () => {
    if (!text.trim()) {
      setNotice({ kind: 'err', text: '内容为空' });
      return;
    }
    setBusy('正在添加…');
    const result = await addReference({
      title,
      text,
      kind: pendingImages ? 'pdf' : 'note',
      source: pendingImages ? 'PDF 上传' : '手动添加',
      pageImages: pendingImages?.images,
      pageCount: pendingImages?.pageCount,
    });
    setBusy(null);
    if (!result.ok) {
      setNotice({ kind: 'err', text: result.error ?? '添加失败' });
      return;
    }
    if (result.error) {
      // 成功但带警告：后端没连上，资料只在浏览器里——必须说清楚，否则用户会白等模型
      setNotice({ kind: 'err', text: result.error });
      return;
    }
    setNotice({ kind: 'ok', text: `已添加《${result.reference?.title}》，下一轮对话即可引用` });
    setTitle('');
    setText('');
    setPendingImages(null);
    onToggleCompose();
  };

  const backendMode = useChatStore((s) => s.backend.mode);

  return (
    <div className="space-y-1.5">
      {backendMode === 'browser-mock' && (
        <p className="rounded border border-accent-amber/40 bg-accent-amber/10 px-2 py-1.5 text-[10.5px] leading-snug text-accent-amber">
          当前是<b>浏览器内 mock 模式</b>（没有连上编排服务）：这里添加的资料模型看不到。
          请启动 <span className="font-mono">npm run dev</span> 后重新添加。
        </p>
      )}
      <button
        type="button"
        onClick={onToggleCompose}
        className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-ink-700 px-2 py-1.5 text-[11px] text-ink-300 transition-colors hover:border-brand-600/60 hover:text-brand-300"
      >
        <Plus className="size-3" />
        {composing ? '收起添加面板' : '添加参考资料（PDF / 文本 / BibTeX）'}
      </button>

      {composing && (
        <div className="space-y-1.5 rounded-md border border-ink-750 bg-ink-925 p-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题（例如：Zhang et al. 2024 论文全文）"
            className="w-full rounded border border-ink-750 bg-ink-900 px-2 py-1 text-[11px] text-ink-100 outline-none placeholder:text-ink-600 focus:border-brand-600/60"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="粘贴正文/摘录，或点下面的按钮上传文件"
            className="w-full resize-y rounded border border-ink-750 bg-ink-900 px-2 py-1 font-mono text-[10.5px] leading-relaxed text-ink-200 outline-none placeholder:text-ink-600 focus:border-brand-600/60"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              icon={<Upload className="size-3" />}
              onClick={() => fileRef.current?.click()}
              disabled={Boolean(busy)}
            >
              上传文件
            </Button>
            <Button
              size="xs"
              variant="primary"
              icon={busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              onClick={() => void submit()}
              disabled={Boolean(busy) || !text.trim()}
            >
              添加
            </Button>
            {text.length > 0 && <span className="font-mono text-[10px] text-ink-600">{text.length} 字</span>}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.txt,.md,.tex,.bib"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleFile(file);
            }}
          />
          <p className="text-[10px] leading-snug text-ink-600">
            PDF 在浏览器端提取正文（不上传文件）；.bib 会解析成结构化条目进「文献」页。
          </p>
        </div>
      )}

      {hasImages && (
        <p className="rounded border border-accent-violet/40 bg-accent-violet/10 px-2 py-1.5 text-[10.5px] leading-snug text-accent-violet">
          这份资料含页面图像。
          {visionModels.length > 0 ? (
            <>
              想看图的模型：{visionModels.map((m) => `@${m}`).join('、')}
              ；纯文本模型（如 deepseek-chat）只会读提取出的文字。
            </>
          ) : (
            <>但你当前没有配置支持视觉的模型，模型只能读提取出的文字。</>
          )}
        </p>
      )}

      {busy && (
        <p className="flex items-center gap-1.5 rounded border border-brand-600/40 bg-brand-500/10 px-2 py-1 text-[10.5px] text-brand-300">
          <Loader2 className="size-3 animate-spin" />
          {busy}
        </p>
      )}
      {notice && (
        <p
          className={`rounded px-2 py-1 text-[10.5px] leading-snug ${
            notice.kind === 'ok'
              ? 'border border-accent-teal/40 bg-accent-teal/10 text-accent-teal'
              : 'border border-accent-amber/40 bg-accent-amber/10 text-accent-amber'
          }`}
        >
          {notice.text}
        </p>
      )}

      <ul className="space-y-1">
        {references.map((reference) => (
          <li key={reference.id} className="rounded-md border border-ink-800 bg-ink-925/70 px-2 py-1.5">
            <div className="flex items-start gap-1.5">
              <FileText className="mt-[2px] size-3 shrink-0 text-brand-400" />
              <button
                type="button"
                onClick={() => setPreview(preview === reference.id ? null : reference.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate text-[11px] text-ink-200">{reference.title}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[9.5px] text-ink-500">
                  <Pill className="!px-1 !py-0 !text-[9px]">{reference.kind}</Pill>
                  {reference.charCount} 字
                  {(reference.pageImages?.length ?? 0) > 0 && (
                    <span
                      className="rounded bg-accent-violet/15 px-1 text-accent-violet"
                      title="已渲染页面图像：@ 一个带「可看图」标记的模型，它会直接看这些图，不依赖文本提取"
                    >
                      {reference.pageImages!.length} 页图像
                    </span>
                  )}
                  {reference.source ? ` · ${reference.source}` : ''}
                </span>
              </button>
              <button
                type="button"
                title="删除这份资料"
                onClick={() => void removeReference(reference.id)}
                className="shrink-0 rounded p-0.5 text-ink-500 transition-colors hover:bg-accent-rose/15 hover:text-accent-rose"
              >
                <Trash2 className="size-3" />
              </button>
            </div>

            {preview === reference.id && (
              <div className="mt-1.5 border-t border-ink-800 pt-1.5">
                <p className="max-h-40 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-ink-400">
                  {reference.text ? reference.text.slice(0, 1200) : '（正文未加载：列表接口只回传元信息）'}
                  {reference.text.length > 1200 ? '\n…' : ''}
                </p>
                <button
                  type="button"
                  onClick={() => setDraftAndFocus(`@all 请根据《${reference.title}》回答：`)}
                  className="mt-1.5 flex items-center gap-1 rounded border border-brand-600/40 px-1.5 py-[2px] text-[10.5px] text-brand-300 hover:bg-brand-500/10"
                >
                  <Quote className="size-2.5" />
                  让模型基于它回答
                </button>
              </div>
            )}
          </li>
        ))}
        {references.length === 0 && (
          <li className="px-1 py-3 text-center text-[10.5px] leading-relaxed text-ink-600">
            还没有参考资料。
            <br />
            添加后会自动参与检索，模型在回答时能引用它。
          </li>
        )}
      </ul>
    </div>
  );
}
