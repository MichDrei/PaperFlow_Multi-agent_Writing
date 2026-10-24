/**
 * 文件树：对应 Overleaf 左侧那一栏。
 *
 * 支持的能力（与 Overleaf 对齐）：
 * - 新建文件 / 新建文件夹（支持 `a/b/c.tex` 这种路径一次建多层）
 * - 重命名、删除（.tex 还能"设为主文档"）
 * - **拖动上传**：把文件或整个项目 zip 拖到面板上
 * - 导入 / 导出项目压缩包
 *
 * 服务端才是项目的真相来源（磁盘上的真实文件），这里只负责渲染清单与发起操作。
 */

import { useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileCode2,
  FilePlus2,
  FileText,
  FolderPlus,
  Image,
  Loader2,
  Package,
  Pencil,
  Quote,
  RefreshCw,
  Settings2,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { FileKind, PaperFile } from '@paperflow/core';
import { useWorkspaceStore } from '@/stores/workspaceStore';

interface TreeItem {
  /** 目录项没有 id */
  id?: string;
  name: string;
  path: string;
  depth: number;
  kind: FileKind;
  isDirectory: boolean;
  size: number;
  isRoot: boolean;
}

/** 由扁平的文件清单推导出有序的树形列表（目录在前）。 */
export function buildTreeItems(files: Record<string, PaperFile>, rootPath: string): TreeItem[] {
  const items: TreeItem[] = [];
  const directories = new Set<string>();

  for (const file of Object.values(files)) {
    const segments = file.path.split('/');
    for (let i = 1; i < segments.length; i += 1) directories.add(segments.slice(0, i).join('/'));
  }

  const seen = new Set<string>();
  const addDirectory = (path: string, depth: number): void => {
    if (seen.has(path)) return;
    seen.add(path);
    items.push({
      name: path.split('/').pop() ?? path,
      path,
      depth,
      kind: 'other',
      isDirectory: true,
      size: 0,
      isRoot: false,
    });
  };

  // 先按路径排序，保证目录与其内容相邻
  const paths = [...new Set([...directories, ...Object.values(files).map((f) => f.path)])].sort((a, b) =>
    a.localeCompare(b),
  );
  for (const path of paths) {
    const depth = path.split('/').length - 1;
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) addDirectory(segments.slice(0, i).join('/'), i - 1);
    const file = files[path];
    if (!file) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    items.push({
      id: file.id,
      name: segments[segments.length - 1]!,
      path,
      depth,
      kind: file.kind,
      isDirectory: false,
      size: file.size ?? file.content.length,
      isRoot: path === rootPath,
    });
  }
  return items;
}

function iconFor(item: TreeItem) {
  if (item.isDirectory) return <ChevronDown className="size-3 text-ink-500" />;
  if (item.kind === 'bib') return <Quote className="size-3 shrink-0 text-accent-amber" />;
  if (item.kind === 'image') return <Image className="size-3 shrink-0 text-accent-violet" />;
  if (item.kind === 'style') return <Settings2 className="size-3 shrink-0 text-ink-400" />;
  if (item.kind === 'tex') return <FileCode2 className="size-3 shrink-0 text-brand-400" />;
  return <FileText className="size-3 shrink-0 text-ink-500" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileTree() {
  const document_ = useWorkspaceStore((s) => s.document);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const activeFileId = useWorkspaceStore((s) => s.activeFileId);
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile);
  const loadProject = useWorkspaceStore((s) => s.loadProject);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createFolder = useWorkspaceStore((s) => s.createFolder);
  const renameEntry = useWorkspaceStore((s) => s.renameEntry);
  const removeEntry = useWorkspaceStore((s) => s.removeEntry);
  const uploadFiles = useWorkspaceStore((s) => s.uploadFiles);
  const setRootFile = useWorkspaceStore((s) => s.setRootFile);
  const exportProject = useWorkspaceStore((s) => s.exportProject);
  const saveActiveFile = useWorkspaceStore((s) => s.saveActiveFile);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; value: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * "往哪个目录里加东西"。
   *
   * 之前的实现把所有新文件都放在项目根下——用户点了 figures 目录再新建文件，
   * 文件却出现在与 figures 并列的位置。现在由这个状态决定：
   * 点目录行会切换目标目录，拖到目录行上会临时以该目录为目标。
   */
  const [targetDir, setTargetDir] = useState<string>('');

  const items = useMemo(() => buildTreeItems(document_.files, rootPath), [document_.files, rootPath]);

  // 折叠目录：隐藏其下所有子项
  const visible = useMemo(() => {
    return items.filter((item) => {
      const segments = item.path.split('/');
      for (let i = 1; i < segments.length; i += 1) {
        if (collapsed.has(segments.slice(0, i).join('/'))) return false;
      }
      return true;
    });
  }, [items, collapsed]);

  const report = (result: { ok: boolean; error?: string }, successText: string) => {
    setNotice(result.ok ? { kind: 'ok', text: successText } : { kind: 'err', text: result.error ?? '操作失败' });
    setTimeout(() => setNotice(null), 4000);
  };

  /** 把相对路径拼到目标目录下（目标为空则落在项目根）。 */
  const joinTarget = (name: string): string =>
    targetDir ? `${targetDir}/${name.replace(/^\/+/, '')}` : name.replace(/^\/+/, '');

  const handleNewFile = async () => {
    const name = window.prompt(
      targetDir ? `在 ${targetDir}/ 下新建文件` : '新建文件（可含目录，例如 sections/related.tex）',
      'untitled.tex',
    );
    if (!name) return;
    await saveActiveFile();
    const path = joinTarget(name.trim());
    report(await createFile(path), `已创建 ${path}`);
  };

  const handleNewFolder = async () => {
    const name = window.prompt(
      targetDir ? `在 ${targetDir}/ 下新建子目录` : '新建文件夹（例如 figures）',
      'figures',
    );
    if (!name) return;
    const path = joinTarget(name.trim());
    report(await createFolder(path), `已创建文件夹 ${path}`);
  };

  const handleUpload = async (files: FileList | null, intoDir?: string) => {
    // ⚠️ 必须在任何 await 之前把 FileList 拷成数组：
    // 调用方紧接着会清空 input.value，而 FileList 是**活引用**，清空后就变成空的了
    // （之前表现为"已上传 0 个文件"，排查起来很费劲）。
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setBusy(true);
    await saveActiveFile();
    const result = await uploadFiles(list, intoDir ?? targetDir);
    setBusy(false);
    report(result, result.message);
  };

  return (
    <div
      className={`flex h-full flex-col ${dragging ? 'ring-2 ring-brand-500 ring-inset' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        // 子元素（文件夹行）已经 stopPropagation 的不会走到这里
        void handleUpload(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-1 px-2.5 py-1.5">
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-400 uppercase">项目文件</span>
        <span className="ml-auto flex items-center gap-0.5">
          <button type="button" title="新建文件" onClick={() => void handleNewFile()} className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200">
            <FilePlus2 className="size-3" />
          </button>
          <button type="button" title="新建文件夹" onClick={() => void handleNewFolder()} className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200">
            <FolderPlus className="size-3" />
          </button>
          <button type="button" title="上传文件（也可直接把文件或项目 zip 拖进来）" onClick={() => fileInputRef.current?.click()} className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
          </button>
          <button type="button" title="下载整个项目（zip）" onClick={() => void exportProject()} className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200">
            <Download className="size-3" />
          </button>
          <button type="button" title="重新读取项目" onClick={() => void loadProject()} className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200">
            <RefreshCw className="size-3" />
          </button>
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleUpload(e.target.files);
          // 清空以便再次选择同一个文件；handleUpload 内部已经做了快照
          e.target.value = '';
        }}
      />

      {dragging && (
        <p className="mx-2.5 mb-1 rounded border border-brand-500/50 bg-brand-500/10 px-2 py-1.5 text-[10.5px] leading-snug text-brand-300">
          松开即可上传到 <span className="font-mono">{targetDir || '项目根目录'}</span>；
          拖到某个文件夹行上可上传到该文件夹里。
          <br />
          若拖入的是 <span className="font-mono">.zip</span>，会**合并**进当前项目（想新建项目请用顶部项目切换器里的"导入 zip 为新项目"）。
        </p>
      )}

      {targetDir && !dragging && (
        <p className="mx-2.5 mb-1 flex items-center gap-1 rounded border border-ink-750 bg-ink-900 px-2 py-1 text-[10.5px] text-ink-400">
          <FolderPlus className="size-3 text-brand-400" />
          新建/上传目标：<span className="font-mono text-ink-200">{targetDir}/</span>
          <button
            type="button"
            onClick={() => setTargetDir('')}
            className="ml-auto rounded p-0.5 hover:bg-ink-800 hover:text-ink-200"
            title="改回项目根目录"
          >
            <X className="size-3" />
          </button>
        </p>
      )}

      {notice && (
        <p
          className={`mx-2.5 mb-1 rounded px-2 py-1 text-[10.5px] leading-snug ${
            notice.kind === 'ok'
              ? 'border border-accent-teal/40 bg-accent-teal/10 text-accent-teal'
              : 'border border-accent-rose/40 bg-accent-rose/10 text-accent-rose'
          }`}
        >
          {notice.text}
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
        {visible.map((item) => {
          const active = item.id === activeFileId;
          const isEditing = editing?.path === item.path;
          return (
            <li key={item.path}>
              <div
                className={`group flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[11.5px] transition-colors ${
                  active ? 'bg-brand-500/15 text-brand-300' : 'text-ink-300 hover:bg-ink-850'
                } ${item.isDirectory && targetDir === item.path ? 'ring-1 ring-brand-500/50 ring-inset' : ''}`}
                style={{ paddingLeft: 8 + item.depth * 12 }}
                onDragOver={(e) => {
                  if (!item.isDirectory) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setTargetDir(item.path);
                }}
                onDrop={(e) => {
                  if (!item.isDirectory) return;
                  // 拖到文件夹上 → 上传到该文件夹里（而不是与它并列）
                  e.preventDefault();
                  e.stopPropagation();
                  setDragging(false);
                  void handleUpload(e.dataTransfer.files, item.path);
                }}
              >
                {item.isDirectory ? (
                  <button
                    type="button"
                    className="flex items-center gap-1"
                    title="点击展开/折叠；右键前先点一下可把它设为「新建/上传的目标目录」"
                    onClick={() => {
                      setTargetDir((prev) => (prev === item.path ? '' : item.path));
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.path)) next.delete(item.path);
                        else next.add(item.path);
                        return next;
                      });
                    }}
                  >
                    {collapsed.has(item.path) ? <ChevronRight className="size-3 text-ink-500" /> : iconFor(item)}
                  </button>
                ) : (
                  iconFor(item)
                )}

                {isEditing ? (
                  <input
                    autoFocus
                    value={editing.value}
                    onChange={(e) => setEditing({ path: item.path, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const next = editing.value.trim();
                        setEditing(null);
                        if (next && next !== item.path) report(renameResult(renameEntry, item.path, next), `已重命名为 ${next}`);
                      }
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                    className="min-w-0 flex-1 rounded border border-brand-500/60 bg-ink-900 px-1 font-mono text-[11px] text-ink-100 outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    disabled={item.isDirectory}
                    onClick={() => !item.isDirectory && setActiveFile(item.id!)}
                    className="min-w-0 flex-1 truncate text-left font-mono"
                    title={item.path}
                  >
                    {item.name}
                  </button>
                )}

                {item.isRoot && (
                  <span title="主文档（编译入口）" className="shrink-0">
                    <Star className="size-2.5 fill-accent-amber text-accent-amber" />
                  </span>
                )}
                {!item.isDirectory && item.size > 0 && (
                  <span className="shrink-0 font-mono text-[9.5px] text-ink-600">{formatSize(item.size)}</span>
                )}

                {!item.isDirectory && (
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {item.kind === 'tex' && !item.isRoot && (
                      <button
                        type="button"
                        title="设为主文档（编译入口）"
                        onClick={() => void setRootFile(item.path)}
                        className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-accent-amber"
                      >
                        <Star className="size-2.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      title="重命名"
                      onClick={() => setEditing({ path: item.path, value: item.path })}
                      className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                    >
                      <Pencil className="size-2.5" />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      onClick={() => {
                        if (!window.confirm(`删除 ${item.path}？`)) return;
                        void removeEntry(item.path).then((r) => report(r, `已删除 ${item.path}`));
                      }}
                      className="rounded p-0.5 text-ink-500 hover:bg-accent-rose/15 hover:text-accent-rose"
                    >
                      <Trash2 className="size-2.5" />
                    </button>
                  </span>
                )}
                {item.isDirectory && (
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      title={`在 ${item.path}/ 里新建文件`}
                      onClick={() => {
                        const name = window.prompt(`在 ${item.path}/ 下新建文件`, 'untitled.tex');
                        if (!name) return;
                        const path = `${item.path}/${name.trim().replace(/^\/+/, '')}`;
                        void createFile(path).then((r) => report(r, `已创建 ${path}`));
                      }}
                      className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                    >
                      <FilePlus2 className="size-2.5" />
                    </button>
                    <button
                      type="button"
                      title={`上传文件到 ${item.path}/`}
                      onClick={() => {
                        setTargetDir(item.path);
                        fileInputRef.current?.click();
                      }}
                      className="rounded p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-200"
                    >
                      <Upload className="size-2.5" />
                    </button>
                    <button
                      type="button"
                      title="删除文件夹"
                      onClick={() => {
                        if (!window.confirm(`删除文件夹 ${item.path} 及其内容？`)) return;
                        void removeEntry(item.path).then((r) => report(r, `已删除 ${item.path}`));
                      }}
                      className="rounded p-0.5 text-ink-500 hover:bg-accent-rose/15 hover:text-accent-rose"
                    >
                      <Trash2 className="size-2.5" />
                    </button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="px-3 py-3 text-center text-[10.5px] leading-relaxed text-ink-600">
            项目里还没有文件。
            <br />
            把 Overleaf 导出的 zip 拖进来即可导入。
          </li>
        )}
      </ul>

      <div className="flex items-center gap-1 border-t border-ink-850 px-2.5 py-1.5 text-[10px] text-ink-600">
        <Package className="size-2.5" />
        主文档 <span className="font-mono text-ink-400">{rootPath}</span>
        {busy && <Loader2 className="ml-auto size-3 animate-spin text-brand-400" />}
        {!busy && notice?.kind === 'ok' && <Check className="ml-auto size-3 text-accent-teal" />}
      </div>
    </div>
  );
}

/** 把 Promise 包成 report 需要的形状（重命名是异步的，这里保持调用点简洁）。 */
function renameResult(
  rename: (from: string, to: string) => Promise<{ ok: boolean; error?: string }>,
  from: string,
  to: string,
): { ok: boolean; error?: string } {
  // 先乐观返回，真实结果由调用方随后刷新
  void rename(from, to);
  return { ok: true };
}
