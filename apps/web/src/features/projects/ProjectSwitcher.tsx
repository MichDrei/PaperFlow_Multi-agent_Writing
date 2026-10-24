/**
 * 项目切换器：多篇论文并列（ICRA / RAL / IROS …），彼此完全独立。
 *
 * 隔离范围（都随 projectId 走）：
 *   文件 · 编译 · 共享知识（文献/术语/参考资料）· 对话历史。
 * 换项目 = 换一套工作区，不会串味。
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen, Loader2, Package, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export function ProjectSwitcher() {
  const projects = useWorkspaceStore((s) => s.projects);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const switchProject = useWorkspaceStore((s) => s.switchProject);
  const createProject = useWorkspaceStore((s) => s.createProject);
  const importFromPath = useWorkspaceStore((s) => s.importProjectFromPath);
  const renameProject = useWorkspaceStore((s) => s.renameProject);
  const deleteProject = useWorkspaceStore((s) => s.deleteProject);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** 「从磁盘导入」输入框里的路径。 */
  const [pathInput, setPathInput] = useState('');
  /** 记住上次用过的路径，省得每次都敲。 */
  useEffect(() => {
    const saved = window.localStorage.getItem('pf.importPath');
    if (saved) setPathInput(saved);
  }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const active = projects.find((p) => p.id === activeProjectId);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    const handleImportPath = async () => {
    const path = pathInput.trim();
    if (!path || busy) return;
    window.localStorage.setItem('pf.importPath', path);
    setBusy('import-path');
    setNotice(`正在从磁盘导入 ${path}…`);
    const result = await importFromPath(path);
    setBusy(null);
    setNotice(
      result.ok
        ? `✓ 已导入「${result.name}」（${result.imported} 个文件` +
            (result.skipped ? `，跳过 ${result.skipped} 个编译产物/视频` : '') +
            '）'
        : `导入失败：${result.error ?? '未知原因'}`,
    );
  };

  return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 4000);
  };

  const handleNew = async () => {
    const name = window.prompt('新项目名称（例如 ICRA 2026 / RAL journal / IROS）', '新论文项目');
    if (!name) return;
    setBusy('create');
    const result = await createProject(name.trim());
    setBusy(null);
    setOpen(false);
    flash(result.ok ? `已创建并切换到「${name.trim()}」` : (result.error ?? '创建失败'));
  };

  /** 上传 zip = 新建一个项目（就像 Overleaf 的 Upload Project） */
  const handleZip = async (file: File | undefined) => {
    if (!file) return;
    const name = file.name.replace(/\.zip$/i, '');
    setBusy(`正在导入 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）…`);
    const result = await createProject(name, file);
    setBusy(null);
    setOpen(false);
    flash(
      result.ok
        ? `已从 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）展开为项目「${name}」`
        : `导入失败：${result.error ?? '未知原因'}`,
    );
  };

  const handleImportPath = async () => {
    const path = pathInput.trim();
    if (!path || busy) return;
    window.localStorage.setItem('pf.importPath', path);
    setBusy('import-path');
    setNotice(`正在从磁盘导入 ${path}…`);
    const result = await importFromPath(path);
    setBusy(null);
    setNotice(
      result.ok
        ? `✓ 已导入「${result.name}」（${result.imported} 个文件` +
            (result.skipped ? `，跳过 ${result.skipped} 个编译产物/视频` : '') +
            '）'
        : `导入失败：${result.error ?? '未知原因'}`,
    );
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[220px] items-center gap-1.5 rounded-md border border-ink-750 bg-ink-900 px-2 py-1 text-[11.5px] text-ink-200 transition-colors hover:border-ink-600"
        title="切换项目（每个项目的文件、编译、共享知识与对话历史完全独立）"
      >
        <FolderOpen className="size-3 text-brand-400" />
        <span className="truncate">{active?.name ?? '加载中…'}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-500" />
      </button>

      {open && (
        <div className="pf-enter absolute top-full left-0 z-50 mt-1 w-[320px] overflow-hidden rounded-lg border border-ink-700 bg-ink-850 shadow-2xl shadow-black/50">
          <div className="border-b border-ink-750 px-2.5 py-1.5 text-[10.5px] text-ink-400">
            项目（{projects.length}）· 各项目的文件与对话互相独立
          </div>

          <ul className="max-h-72 overflow-auto py-1">
            {projects.map((project) => {
              const isActive = project.id === activeProjectId;
              const handleImportPath = async () => {
    const path = pathInput.trim();
    if (!path || busy) return;
    window.localStorage.setItem('pf.importPath', path);
    setBusy('import-path');
    setNotice(`正在从磁盘导入 ${path}…`);
    const result = await importFromPath(path);
    setBusy(null);
    setNotice(
      result.ok
        ? `✓ 已导入「${result.name}」（${result.imported} 个文件` +
            (result.skipped ? `，跳过 ${result.skipped} 个编译产物/视频` : '') +
            '）'
        : `导入失败：${result.error ?? '未知原因'}`,
    );
  };

  return (
                <li key={project.id} className="group flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-ink-800">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      void switchProject(project.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    {isActive ? (
                      <Check className="size-3 shrink-0 text-accent-teal" />
                    ) : (
                      <span className="size-3 shrink-0" />
                    )}
                    <span className={`truncate text-[11.5px] ${isActive ? 'text-accent-teal' : 'text-ink-200'}`}>
                      {project.name}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-600">{project.id}</span>
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      title="重命名项目"
                      onClick={() => {
                        const name = window.prompt('新名称', project.name);
                        if (name) void renameProject(project.id, name.trim());
                      }}
                      className="rounded p-0.5 text-ink-500 hover:bg-ink-700 hover:text-ink-200"
                    >
                      <Pencil className="size-2.5" />
                    </button>
                    <button
                      type="button"
                      title="删除项目（连同文件）"
                      onClick={async () => {
                        if (!window.confirm(`删除项目「${project.name}」及其全部文件？`)) return;
                        const result = await deleteProject(project.id);
                        if (!result.ok) flash(result.error ?? '删除失败');
                      }}
                      className="rounded p-0.5 text-ink-500 hover:bg-accent-rose/15 hover:text-accent-rose"
                    >
                      <Trash2 className="size-2.5" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="flex items-center gap-1.5 border-t border-ink-750 px-2.5 py-2">
            <button
              type="button"
              onClick={() => void handleNew()}
              disabled={Boolean(busy)}
              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-ink-700 px-2 py-1 text-[11px] text-ink-200 hover:border-brand-600/60 hover:text-brand-300"
            >
              {busy === 'create' ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              新建空项目
            </button>
            <button
              type="button"
              onClick={() => zipInputRef.current?.click()}
              disabled={Boolean(busy)}
              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-ink-700 px-2 py-1 text-[11px] text-ink-200 hover:border-brand-600/60 hover:text-brand-300"
              title="上传 Overleaf 导出的 zip，直接成为一个新项目"
            >
              {busy === 'import' ? <Loader2 className="size-3 animate-spin" /> : <Package className="size-3" />}
              {busy?.startsWith('正在导入') ? '导入中…' : '导入 zip 为新项目'}
            </button>
          </div>

          {/*
            从**服务器本地路径**导入（目录或 zip）。

            为什么必须有这条路径：毕设项目动辄几百 MB（插图 + 字体），
            走浏览器上传会撞服务端 body 上限——实测 815MB 的 zip 直接被 413 拒掉。
            服务端本来就能读到本机磁盘（WSL 里 `/mnt/f/...` 就是 Windows 的 F 盘），
            直接读盘没有上限压力。
          */}
          <div className="flex items-center gap-1.5 border-t border-ink-750 px-2.5 py-2">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleImportPath();
              }}
              placeholder="/mnt/f/LaTeX_Paper_Folder/项目文件夹"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[10.5px] text-ink-100 placeholder:text-ink-600 focus:border-brand-600/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleImportPath()}
              disabled={Boolean(busy) || !pathInput.trim()}
              className="shrink-0 rounded-md border border-ink-700 px-2 py-1 text-[11px] text-ink-200 hover:border-brand-600/60 hover:text-brand-300 disabled:opacity-40"
              title="直接读服务器磁盘上的目录或 zip（不经过上传，适合几百 MB 的毕设项目）"
            >
              {busy === 'import-path' ? <Loader2 className="size-3 animate-spin" /> : <FolderOpen className="size-3" />}
              从磁盘导入
            </button>
          </div>

          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              void handleZip(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {notice && (
        <div className="pf-enter absolute top-full left-0 z-50 mt-1 flex w-[320px] items-start gap-1.5 rounded-lg border border-accent-teal/40 bg-accent-teal/10 px-2.5 py-1.5 text-[10.5px] leading-snug text-accent-teal shadow-lg">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0">
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
}
