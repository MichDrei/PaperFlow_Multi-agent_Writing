/**
 * 服务端项目存储：磁盘上的真实项目目录。
 *
 * 为什么必须是磁盘而不是内存：
 * 1. TeX 引擎本来就在文件系统上工作——`\input`、`\includegraphics`、`.cls`、`.bib`
 *    都需要真实文件才能解析；把内容在内存里兜一圈再写临时目录是多余且易错的；
 * 2. 用户要能"上传一个从 Overleaf 导出的 zip 然后直接编译"，这要求项目是**一组真实文件**；
 * 3. 图片等二进制资源不能当字符串存。
 *
 * 目录布局：`.paperflow/projects/<projectId>/`（已 gitignore），与 Overleaf 的项目概念对应。
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { FileKind, ProjectFileEntry, ProjectManifest } from '@paperflow/core';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 项目根目录（仓库根下的 .paperflow/projects）。 */
export function defaultProjectsRoot(): string {
  return resolve(MODULE_DIR, '../../../../.paperflow/projects');
}

const TEXT_EXTENSIONS = new Set(['.tex', '.bib', '.cls', '.sty', '.bst', '.txt', '.md', '.tikz', '.def', '.cfg']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.gif', '.webp', '.svg', '.ttf', '.otf']);

/** 单个项目最大字节数（防止误导入一个巨大的目录把磁盘写满）。 */
export const MAX_PROJECT_BYTES = 2 * 1024 * 1024 * 1024;
/** 单个文件最大字节数（毕设里 30MB 级的插图很常见，64MB 够用）。 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * 编译**不需要**的文件：按扩展名跳过。
 *
 * 实测一个毕设项目 815MB，其中：编译产物 PDF 153MB、4 个演示视频 196MB、
 * 中间文件若干——这些既不能用于排版，还会让上传/导入直接超限。
 * 跳过的内容会**如实报告**给用户，不静默丢弃。
 */
const JUNK_EXTENSIONS = new Set([
  // LaTeX 中间产物
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk',
  '.synctex', '.synctex.gz', '.xdv', '.blg', '.bcf', '.run.xml', '.idx', '.ind', '.ilg',
  // 视频/音频：LaTeX 无法嵌入
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wav', '.mp3', '.m4a',
]);

/** 目录里这些子目录整棵跳过（版本库、构建输出）。 */
const JUNK_DIRECTORIES = new Set(['.git', '.svn', '.hg', 'out', 'build', 'node_modules', '.vscode', '.idea']);

/** 该文件是否属于"编译不需要"的垃圾（含与同名 .tex 对应的编译产物 PDF）。 */
export function isJunkFile(path: string, siblingTexBasenames: Set<string> = new Set()): boolean {
  const lower = path.toLowerCase();
  const ext = extensionOf(lower);
  if (JUNK_EXTENSIONS.has(ext)) return true;
  // 复合后缀（`.synctex.gz`、`.run.xml` 这类）要整体匹配，否则只看最后一段会漏
  if (lower.endsWith('.synctex.gz') || lower.endsWith('.run.xml') || lower.endsWith('.fdb_latexmk')) {
    return true;
  }
  // 与同名 .tex 并列的 PDF 是编译产物（`main.tex` → `main.pdf`），但 figures/ 里的图 PDF 要保留
  if (ext === '.pdf') {
    const base = lower.split('/').pop()!.replace(/\.pdf$/, '');
    if (siblingTexBasenames.has(base)) return true;
  }
  return false;
}

/** 收集一批文件里所有 .tex 的基名，用于识别编译产物 PDF。 */
export function texBasenames(paths: string[]): Set<string> {
  const set = new Set<string>();
  for (const path of paths) {
    if (!path.toLowerCase().endsWith('.tex')) continue;
    set.add(path.toLowerCase().split('/').pop()!.replace(/\.tex$/, ''));
  }
  return set;
}

export function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

export function kindForPath(path: string): FileKind {
  const ext = extensionOf(path);
  if (ext === '.tex') return 'tex';
  if (ext === '.bib') return 'bib';
  if (ext === '.cls' || ext === '.sty' || ext === '.bst' || ext === '.def' || ext === '.cfg') return 'style';
  if (BINARY_EXTENSIONS.has(ext)) return 'image';
  return 'other';
}

function encodingForPath(path: string): 'utf8' | 'base64' {
  const ext = extensionOf(path);
  if (TEXT_EXTENSIONS.has(ext)) return 'utf8';
  return BINARY_EXTENSIONS.has(ext) ? 'base64' : 'utf8';
}

/**
 * 规范化并**校验**项目内路径。
 *
 * 这一步是安全边界：`../` 之类的路径能把文件写到项目目录之外。
 * 所有来自 HTTP 的路径都必须先过这里。
 */
export function normalizeProjectPath(input: string): string {
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!raw) throw new Error('路径不能为空');
  const normalized = posix.normalize(raw);
  if (normalized.startsWith('..') || normalized.includes('../') || posix.isAbsolute(normalized)) {
    throw new Error(`非法路径（不允许跳出项目目录）：${input}`);
  }
  if (normalized === '.' || normalized.endsWith('/')) throw new Error(`非法路径：${input}`);
  return normalized;
}

/**
 * 推断哪个 .tex 是"主文档"。
 *
 * 曾经的规则是"按字母序取第一个 .tex"，这在真实项目里会翻车：
 * 用户的 ICRA 包里同时有 `main.tex`（我演示用的种子）与 `root.tex` / `root_modified_version.tex`，
 * `main.tex` 排在最前面被选中，于是编译报 `ieeeconf.cls not found` —— 用户完全不知道
 * 自己"编译错了文件"。
 *
 * 现在的判据，按可靠性排序：
 * 1. 含 `\documentclass` 且含 `\begin{document}` —— 能独立编译的完整文档；
 * 2. 名字像主文档（main / root / paper / manuscript / article）优先；
 * 3. 路径更浅（顶层优先）且更短。
 */
export function pickMainDocument(projectDir: string, files: ProjectFileEntry[]): string {
  const texFiles = files.filter((f) => f.kind === 'tex' && !f.isDirectory);
  if (texFiles.length === 0) return 'main.tex';
  if (texFiles.length === 1) return texFiles[0]!.path;

  const scored = texFiles.map((file) => {
    let score = 0;
    try {
      const head = readFileSync(join(projectDir, file.path), 'utf8').slice(0, 20_000);
      if (/\\documentclass/.test(head)) score += 100;
      if (/\\begin\{document\}/.test(head)) score += 50;
    } catch {
      /* 读不到就不加分 */
    }
    const name = file.path.split('/').pop()?.toLowerCase() ?? '';
    if (/^(main|root|paper|manuscript|article)[._-]/.test(name) || /^(main|root|paper)\.tex$/.test(name)) {
      score += 20;
    }
    // 路径越浅越可能是主文档（\input 的子文件通常在子目录里）
    score -= file.path.split('/').length - 1;
    return { path: file.path, score };
  });

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored[0]!.path;
}

export class ProjectStore {
  readonly root: string;

  /**
   * 编译产物（PDF）的缓存目录。
   *
   * ⚠️ 必须与 `projects/` **同级**，不能放在里面：项目注册表会把 `projects/` 下的
   * 每个子目录都当成一个项目（reconcile），于是 `pdf-cache` 会变成一个假项目，
   * 甚至排到列表第一个——实测用户打开应用后看到"项目名 pdf-cache、只有一个 PDF、没有代码"。
   */
  private readonly cacheRoot: string;

  constructor(options: { root?: string; cacheRoot?: string } = {}) {
    this.root = options.root ?? defaultProjectsRoot();
    this.cacheRoot = options.cacheRoot ?? join(this.root, '..', 'pdf-cache');
  }

  projectDir(projectId: string): string {
    return join(this.root, projectId.replace(/[^\w.-]/g, '_'));
  }

  /** 确保项目目录存在；首次使用时用种子文件初始化。 */
  ensure(projectId: string, seed?: Record<string, string>): void {
    const dir = this.projectDir(projectId);
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of Object.entries(seed ?? {})) {
      const target = this.absolute(projectId, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
  }

  /** 把项目内相对路径转成绝对路径，并再次校验越界。 */
  absolute(projectId: string, path: string): string {
    const dir = this.projectDir(projectId);
    const safe = normalizeProjectPath(path);
    const target = resolve(dir, safe);
    if (!(target === dir || target.startsWith(dir + sep))) {
      throw new Error(`非法路径：${path}`);
    }
    return target;
  }

  /** 主文档记录文件：放在项目目录内，跟着项目走（导出 zip 时会带上）。 */
  private rootMarker(projectId: string): string {
    return join(this.projectDir(projectId), '.paperflow-root');
  }

  /** 读取项目记录的主文档；没有记录或文件已不存在时返回 undefined（交给智能推断）。 */
  rootPathOf(projectId: string): string | undefined {
    const marker = this.rootMarker(projectId);
    if (!existsSync(marker)) return undefined;
    try {
      const path = readFileSync(marker, 'utf8').trim();
      return path && existsSync(this.absolute(projectId, path)) ? path : undefined;
    } catch {
      return undefined;
    }
  }

  setRootPath(projectId: string, path: string): void {
    const safe = normalizeProjectPath(path);
    mkdirSync(this.projectDir(projectId), { recursive: true });
    writeFileSync(this.rootMarker(projectId), safe, 'utf8');
  }

  manifest(projectId: string, rootPath?: string): ProjectManifest {
    this.ensure(projectId);
    const dir = this.projectDir(projectId);
    // ⚠️ 这里**不能**兜底成 'main.tex'：那会让 recorded 恒为真（只要项目里有 main.tex），
    // 智能推断永远轮不上——正是这个兜底让"字母序第一个 .tex"的老毛病复活了。
    const preferred = rootPath ?? this.rootPathOf(projectId);
    const files: ProjectFileEntry[] = [];
    const directories = new Set<string>();

    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; // 跳过 .DS_Store 与 .paperflow-root 之类
        const absolute = join(current, entry.name);
        const path = relative(dir, absolute).split(sep).join('/');
        if (entry.isDirectory()) {
          directories.add(path);
          walk(absolute);
          continue;
        }
        const stats = statSync(absolute);
        files.push({
          path,
          kind: kindForPath(path),
          encoding: encodingForPath(path),
          size: stats.size,
        });
      }
    };
    if (existsSync(dir)) walk(dir);

    // 目录不入 files，由前端按路径前缀推导；这里额外返回空目录，避免它们消失
    for (const dirPath of directories) {
      const hasChild = files.some((f) => f.path.startsWith(`${dirPath}/`));
      if (!hasChild) {
        files.push({ path: dirPath, kind: 'other', encoding: 'utf8', size: 0, isDirectory: true });
      }
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    // 主文档优先级：显式传入 > 项目记录 > 智能推断
    // 注意 files 里不含 .paperflow-root（上面的 walk 会跳过点开头的文件）
    const recorded =
      preferred && files.some((f) => f.path === preferred && f.kind === 'tex') ? preferred : undefined;
    return { projectId, rootPath: recorded ?? pickMainDocument(dir, files), files };
  }

  read(projectId: string, path: string): { content: string; encoding: 'utf8' | 'base64'; size: number } {
    const absolute = this.absolute(projectId, path);
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) {
      throw new Error(`文件不存在：${path}`);
    }
    const buffer = readFileSync(absolute);
    const encoding = encodingForPath(path);
    return {
      content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
      encoding,
      size: buffer.byteLength,
    };
  }

  /** 写入（创建或覆盖）一个文件。 */
  write(projectId: string, path: string, content: string, encoding?: 'utf8' | 'base64'): ProjectFileEntry {
    const safe = normalizeProjectPath(path);
    const absolute = this.absolute(projectId, safe);
    const finalEncoding = encoding ?? encodingForPath(safe);
    const buffer =
      finalEncoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(`文件过大（${buffer.byteLength} 字节），上限 ${MAX_FILE_BYTES}`);
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, buffer);
    return { path: safe, kind: kindForPath(safe), encoding: finalEncoding, size: buffer.byteLength };
  }

  /** 写入原始字节（图片等大文件走这里，避免 base64 膨胀）。 */
  writeRaw(projectId: string, path: string, buffer: Buffer): ProjectFileEntry {
    const safe = normalizeProjectPath(path);
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new Error(`文件 ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB，超过上限 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    const absolute = this.absolute(projectId, safe);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, buffer);
    return {
      path: safe,
      kind: kindForPath(safe),
      encoding: encodingForPath(safe),
      size: buffer.byteLength,
    };
  }

  createFolder(projectId: string, path: string): void {
    const safe = normalizeProjectPath(path);
    mkdirSync(this.absolute(projectId, safe), { recursive: true });
  }

  /** 重命名或移动（自动建父目录）。目录会连同内容一起搬。 */
  rename(projectId: string, from: string, to: string): void {
    const source = this.absolute(projectId, from);
    const target = this.absolute(projectId, to);
    if (!existsSync(source)) throw new Error(`不存在：${from}`);
    if (existsSync(target)) throw new Error(`目标已存在：${to}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
  }

  remove(projectId: string, path: string): void {
    const absolute = this.absolute(projectId, path);
    if (!existsSync(absolute)) throw new Error(`不存在：${path}`);
    rmSync(absolute, { recursive: true, force: true });
  }

  /**
   * 导入一个 zip（Overleaf 导出的项目就是这种）。
   *
   * 几个真实世界的细节：
   * - Overleaf 的压缩包常有一个顶层目录（如 `my-paper-1.2/`），要自动剥掉，
   *   否则主文件会变成 `my-paper-1.2/main.tex`，`\input` 的相对路径也随之失效；
   * - macOS 打包会带 `__MACOSX/` 与 `.DS_Store`，必须忽略；
   * - 二进制条目要按 base64 落盘，不能当文本写。
   */
  /** base64 入口（保留给 JSON 调用方）。 */
  async importZip(
    projectId: string,
    zipBase64: string,
    options: { replace?: boolean } = {},
  ): Promise<{ imported: number; rootPath?: string; skipped: string[] }> {
    return this.importZipBuffer(projectId, Buffer.from(zipBase64, 'base64'), options);
  }

  /**
   * 从**原始字节**导入。
   *
   * 走二进制而不是 base64 的原因：真实 Overleaf 项目带图很容易几十 MB，
   * base64 会再膨胀 33%，而 HTTP 层还有 body 上限——实测 12MB 的 zip
   * 编码成 16MB 后直接超过 8MB 上限，请求被掐断，用户只看到"上传失败"。
   */
  async importZipBuffer(
    projectId: string,
    buffer: Buffer,
    options: { replace?: boolean } = {},
  ): Promise<{ imported: number; rootPath?: string; skipped: string[] }> {
    if (buffer.byteLength > MAX_PROJECT_BYTES) {
      throw new Error(
        `压缩包 ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB，超过上限 ${MAX_PROJECT_BYTES / 1024 / 1024} MB`,
      );
    }

    const zip = await JSZip.loadAsync(buffer);

    /** 打包垃圾：macOS 的 __MACOSX 与 .DS_Store、以及编辑器临时文件。 */
    const isJunk = (path: string): boolean =>
      path.startsWith('__MACOSX/') ||
      path.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._') || seg === '__MACOSX');

    let entries = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => ({ entry, path: entry.name.replace(/\\/g, '/') }))
      .filter(({ path }) => !isJunk(path));

    if (entries.length === 0) throw new Error('压缩包里没有可导入的文件');

    /**
     * 剥掉公共顶层目录。
     *
     * 必须**先过滤垃圾再判断**：Overleaf 导出的包带 `my-paper-1.2/` 顶层目录，
     * 但 macOS 打包会额外塞一个 `__MACOSX/`，只要它参与判断，"公共前缀"就不成立，
     * 结果所有文件都多套一层目录，`\input{sections/intro}` 立刻找不到文件。
     *
     * 用循环剥多层，兼容 `project/src/...` 这种更深的嵌套。
     */
    for (;;) {
      if (entries.length === 0) break;
      const firstSegment = entries[0]!.path.split('/')[0];
      if (!firstSegment) break;
      const allShare = entries.every((e) => e.path.startsWith(`${firstSegment}/`));
      if (!allShare) break;
      entries = entries.map((e) => ({ ...e, path: e.path.slice(firstSegment.length + 1) }));
    }

    // 与同名 .tex 对应的编译产物 PDF（main.tex → main.pdf）也要跳过；
    // figures/ 里的图 PDF 必须保留，所以按"同目录同名 .tex"判定。
    const texNames = texBasenames(entries.map((e) => e.path));
    const skipped = Object.values(zip.files)
      .filter((entry) => !entry.dir && isJunk(entry.name.replace(/\\/g, '/')))
      .map((entry) => entry.name);
    entries = entries.filter(({ path }) => {
      if (!isJunkFile(path, texNames)) return true;
      skipped.push(path);
      return false;
    });

    if (options.replace) {
      const dir = this.projectDir(projectId);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    } else {
      this.ensure(projectId);
    }

    let imported = 0;
    for (const { entry, path } of entries) {
      if (!path) continue;
      let safe: string;
      try {
        safe = normalizeProjectPath(path);
      } catch {
        skipped.push(entry.name);
        continue;
      }
      const data = await entry.async('nodebuffer');
      const absolute = this.absolute(projectId, safe);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, data);
      imported += 1;
    }

    const manifest = this.manifest(projectId);
    return { imported, rootPath: manifest.rootPath, skipped };
  }

  /**
   * 从**服务器本地目录**导入（不经过上传）。
   *
   * 为什么需要它：毕设这种项目常有几百 MB 图片，走 HTTP 上传会撞 body 上限，
   * 而服务端本来就能读到同一台机器上的文件（WSL 里 `/mnt/f/...` 就是 Windows 的 F 盘）。
   * 直接读盘既没有上限压力，也不用把几百 MB 塞进内存。
   */
  async importDirectory(
    projectId: string,
    sourceDir: string,
    options: { replace?: boolean } = {},
  ): Promise<{ imported: number; rootPath?: string; skipped: string[]; bytes: number }> {
    const source = resolve(sourceDir);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`目录不存在：${sourceDir}`);
    }

    if (options.replace) {
      const dir = this.projectDir(projectId);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    } else {
      this.ensure(projectId);
    }

    // 先扫一遍拿到所有 .tex 基名，才能识别"编译产物 PDF"
    const allPaths: string[] = [];
    const walkPaths = (current: string, prefix: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (JUNK_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkPaths(join(current, entry.name), rel);
        else allPaths.push(rel);
      }
    };
    walkPaths(source, '');

    const texNames = texBasenames(allPaths);
    let imported = 0;
    let bytes = 0;
    const skipped: string[] = [];

    for (const rel of allPaths) {
      if (isJunkFile(rel, texNames)) {
        skipped.push(rel);
        continue;
      }
      const from = join(source, rel);
      const size = statSync(from).size;
      if (size > MAX_FILE_BYTES) {
        skipped.push(`${rel}（${(size / 1024 / 1024).toFixed(0)}MB 超过单文件上限）`);
        continue;
      }
      if (bytes + size > MAX_PROJECT_BYTES) {
        skipped.push(`${rel}（项目总量超过上限，后续文件未导入）`);
        break;
      }
      const to = this.absolute(projectId, rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      bytes += size;
      imported += 1;
    }

    const manifest = this.manifest(projectId);
    return { imported, rootPath: manifest.rootPath, skipped, bytes };
  }

  /**
   * 编译产物（PDF）的缓存路径。
   *
   * 为什么要落盘：毕设这类项目的 PDF 可能有几百 MB，塞进 JSON（base64 还要再涨 33%）
   * 会触发 Node 的字符串长度上限——实测 500 `Invalid string length`。改成写文件 + 用 URL 提供。
   */
  pdfCachePath(projectId: string): string {
    const dir = this.cacheRoot;
    mkdirSync(dir, { recursive: true });
    return join(dir, `${projectId.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`);
  }

  /** 把整个项目导出为 zip（与 Overleaf 的 Download → Source 对应）。 */
  async exportZip(projectId: string): Promise<Buffer> {
    const manifest = this.manifest(projectId);
    const zip = new JSZip();
    for (const file of manifest.files) {
      if (file.isDirectory) {
        zip.folder(file.path);
        continue;
      }
      const { content, encoding } = this.read(projectId, file.path);
      zip.file(file.path, encoding === 'base64' ? Buffer.from(content, 'base64') : content);
    }
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  /** 读取项目里所有文件，供编译使用（含二进制）。 */
  readAll(projectId: string): { path: string; content: string; encoding: 'utf8' | 'base64' }[] {
    return this.manifest(projectId)
      .files.filter((f) => !f.isDirectory)
      .map((f) => {
        const { content, encoding } = this.read(projectId, f.path);
        return { path: f.path, content, encoding };
      });
  }

  /** 复制一份项目（用于"另存为"或导入时不覆盖原项目）。 */
  clone(projectId: string, targetId: string): void {
    const source = this.projectDir(projectId);
    if (!existsSync(source)) throw new Error(`项目不存在：${projectId}`);
    const target = this.projectDir(targetId);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}
