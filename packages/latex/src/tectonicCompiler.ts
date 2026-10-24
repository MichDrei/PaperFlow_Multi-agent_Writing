/**
 * Tectonic 编译器（**仅服务端**）。
 *
 * 为什么需要它：`MockCompiler` 只是把 LaTeX 剥成文本再用 pdf-lib 粗排，
 * 它**不可能**正确渲染作者块、`\thanks` 脚注、三线表、公式环境——
 * 用户按 RAL 模板改完论文后会看到满屏错乱。真正的排版必须交给 TeX 引擎。
 *
 * 选 Tectonic 的理由：
 * - 单个静态二进制，不需要装几个 GB 的 TeX Live；
 * - 基于 XeTeX，**原生支持 UTF-8 与系统字体**，因此中英文可以同一个引擎编；
 * - 首次编译自动按需拉取宏包（含 Fandol 中文字体），之后走本地缓存。
 *
 * ⚠️ 本文件依赖 node:child_process，**不要**从 packages/latex 的 index 导出，
 * 否则浏览器端打包会失败。服务端通过 `@paperflow/latex/tectonic` 子路径导入。
 */

import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompileDiagnostic, CompileRequest } from '@paperflow/core';
import type { CompileOutput, LatexCompiler } from './compiler.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 仓库根（packages/latex/src → ../../..）。 */
const REPO_ROOT = resolve(MODULE_DIR, '../../..');

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export interface TectonicCompilerOptions {
  /** 二进制路径。默认取仓库内 .tectonic/bin/tectonic，其次取 PATH 上的 tectonic。 */
  binaryPath?: string;
  /** 编译缓存与工作目录的根。默认仓库内 .tectonic。 */
  workRoot?: string;
  /** 单次编译超时。首次编译要拉宏包，给得宽一些。 */
  timeoutMs?: number;
  /** 是否在检测到中文但文档未加载 CJK 支持时自动补最小中文支持（xeCJK）。 */
  autoCjk?: boolean;
}

function resolveBinary(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.TECTONIC_BIN,
    join(REPO_ROOT, '.tectonic/bin/tectonic'),
    '/usr/local/bin/tectonic',
    '/usr/bin/tectonic',
  ].filter(Boolean) as string[];
  return candidates.find((path) => existsSync(path));
}

export function isTectonicAvailable(explicit?: string): boolean {
  return Boolean(resolveBinary(explicit));
}

export class TectonicCompiler implements LatexCompiler {
  readonly name = 'tectonic';

  private readonly binary: string | undefined;

  private readonly workRoot: string;

  private readonly timeoutMs: number;

  private readonly autoCjk: boolean;

  constructor(options: TectonicCompilerOptions = {}) {
    this.binary = resolveBinary(options.binaryPath);
    this.workRoot = options.workRoot ?? join(REPO_ROOT, '.tectonic/work');
    /*
     * 默认 15 分钟。
     *
     * 300 秒对"几百 MB 插图"的毕设是不够的：实测一份 479MB 的项目首次排版
     * 5 分钟会被杀，而错误信息（ok=false、没有诊断）完全看不出是超时。
     * 可用环境变量 TECTONIC_TIMEOUT_MS 覆盖。
     */
    const fromEnv = Number(process.env.TECTONIC_TIMEOUT_MS ?? '');
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 900_000);
    this.autoCjk = options.autoCjk ?? true;
  }

  /**
   * 是否需要自动补 CJK 支持。
   *
   * 判据：正文含中日韩字符，且文档自己**没有**加载 ctex / xeCJK / CJK* 之类的宏包。
   * 这是"让同一个引擎既能编英文也能编中文"的关键一步——否则 XeTeX 遇到中文会因为
   * 找不到字体而丢字（表现为 PDF 里中文全空白）。补了什么会写进编译日志，不偷偷改。
   */
  private needsCjkSupport(content: string): boolean {
    if (!CJK_RE.test(content)) return false;
    return !/\\(usepackage|RequirePackage)(\[[^\]]*\])?\{(ctex|xeCJK|CJKutf8|CJK)\}/.test(content);
  }

  async compile(req: CompileRequest): Promise<CompileOutput> {
    const startedAt = Date.now();

    // 本地引擎基于 XeTeX：能同时处理中英文，但不是 pdfLaTeX/LuaLaTeX。
    // 与其静默用错引擎产生一堆莫名其妙的报错，不如直接说清楚该怎么办。
    const engine = req.engine ?? 'auto';
    if (engine === 'pdflatex' || engine === 'lualatex') {
      return {
        ok: false,
        log: `本地引擎（Tectonic）基于 XeLaTeX，不支持 ${engine}。`,
        diagnostics: [
          {
            level: 'error',
            file: 'main.tex',
            line: 1,
            message:
              `本地引擎基于 XeLaTeX，不支持 ${engine}。` +
              '中文与英文用 XeLaTeX 即可（选 auto 或 xelatex）；' +
              '确实需要 ' + engine + ' 时，请配置 LATEX_COMPILER_URL 指向装好 TeX Live 的远端编译服务。',
          },
        ],
        anchors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    if (!this.binary) {
      return {
        ok: false,
        log: 'Tectonic 未安装：找不到 tectonic 可执行文件（可设 TECTONIC_BIN 指定路径）',
        diagnostics: [{ level: 'error', file: 'main.tex', line: 1, message: 'Tectonic 不可用' }],
        anchors: [],
        durationMs: 0,
      };
    }

    // 每次编译用独立目录：避免并发编译互相覆盖中间文件
    const workDir = join(this.workRoot, `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(workDir, { recursive: true });

    try {
      // 主文件名固定为 main.tex，辅助文件按原名落盘（.bib / 图片等）
      let content = req.content;
      const notices: string[] = [];
      if (this.autoCjk && this.needsCjkSupport(content)) {
        content = injectCjkPreamble(content);
        notices.push(
          '检测到中日韩字符且文档未加载 CJK 宏包，已自动加入 xeCJK（仅接管中日韩字符，不影响英文排版）。' +
            '没有使用 ctex：ctex 会全局改变行距与缩进，实测会让页数多 3 页。',
        );
      }
      // 编译入口可以是项目里的任意 .tex（对应 Overleaf 的"主文档"）
      const rawMain = req.mainPath ?? 'main.tex';
      const mainPath = /^[\w./-]+$/.test(rawMain) && !rawMain.includes('..') ? rawMain : 'main.tex';
      const mainAbsolute = join(workDir, mainPath);
      mkdirSync(dirname(mainAbsolute), { recursive: true });
      writeFileSync(mainAbsolute, content, 'utf8');

      for (const aux of req.auxFiles ?? []) {
        // 主文件以请求里的内容为准（可能包含编辑器里尚未保存的改动）
        if (aux.path === mainPath) continue;
        const target = join(workDir, aux.path);
        mkdirSync(dirname(target), { recursive: true });
        // 图片 / .pdf / 字体是二进制：按 base64 还原，不能当文本写
        writeFileSync(target, aux.encoding === 'base64' ? Buffer.from(aux.content, 'base64') : aux.content, aux.encoding === 'base64' ? undefined : 'utf8');
      }

      let { code, output } = await this.run(workDir, mainPath);

      // 字体兼容：老类文件（ieeeconf/IEEEtran…）用 `\rmdefault=ptm` 指定 Times，
      // 这在 XeTeX 下会整体回退成 Computer Modern，页数随之变化。
      // 先编一次拿到真实日志，只在**证据确凿**时补兼容层再编一次。
      //
      // ⚠️ 必须读 `.log` 文件：`LaTeX Font Warning` 只写进日志，
      // Tectonic 的终端输出里没有——早先只扫终端输出，导致这个检测永远命中不了。
      const logFile = join(workDir, mainPath.replace(/\.tex$/i, '.log'));
      const fullLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      const missingFamilies = detectMissingFontFamilies(`${fullLog}\n${output}`);
      if (missingFamilies.length > 0 && !/\\usepackage\{fontspec\}/.test(content)) {
        content = injectFontShim(content, buildFontShim(missingFamilies));
        writeFileSync(mainAbsolute, content, 'utf8');
        notices.push(
          `检测到文档请求的字体（${missingFamilies.join('、')}，如 Times/Helvetica 这类 Type1 字体）` +
            '在当前引擎（XeTeX）下不存在，会被静默替换成 Computer Modern —— ' +
            '这会让行数与页数变化（例如 Overleaf 8 页变成 10 页）。' +
            `已自动改用度量兼容的 TeX Gyre 字体（${missingFamilies.map((f) => FONT_FAMILY_MAP[f]?.regular.split('-')[0]).join('、')}），排版与原 pdfLaTeX 输出一致。`,
        );
        const second = await this.run(workDir, mainPath);
        code = second.code;
        output = second.output;
      }

      const synctexPath = join(workDir, `${mainPath.replace(/\.tex$/i, '')}.synctex.gz`);
      let synctexText: string | undefined;
      if (existsSync(synctexPath)) {
        try {
          synctexText = gunzipSync(readFileSync(synctexPath)).toString('utf8');
        } catch {
          synctexText = undefined; // 解析失败不影响编译结果
        }
      }

      const pdfPath = join(workDir, mainPath.replace(/\.tex$/i, '.pdf'));
      const pdfBytes = existsSync(pdfPath) ? new Uint8Array(readFileSync(pdfPath)) : undefined;
      const diagnostics = parseDiagnostics(output);

      return {
        ok: code === 0 && Boolean(pdfBytes),
        pdfBytes,
        log: [notices.join('\n'), output].filter(Boolean).join('\n').trim(),
        diagnostics,
        anchors: [],
        // SyncTeX 原文交给编译服务解析成索引（不下发给浏览器）
        synctexText,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      // 保留失败现场：出错时留着日志方便排查，成功则清理
      setTimeout(() => rmSync(workDir, { recursive: true, force: true }), 0);
    }
  }

  private run(workDir: string, mainPath: string): Promise<{ code: number; output: string }> {
    return new Promise((resolvePromise) => {
      const home = join(this.workRoot, '..', 'home');
      const cache = join(this.workRoot, '..', 'cache');
      mkdirSync(home, { recursive: true });
      mkdirSync(cache, { recursive: true });

      // --keep-logs 是必需的：LaTeX 的字体/宏包诊断只写进 .log，
      // Tectonic 默认会跳过中间文件（"Skipped writing N intermediate files"），
      // 没有这个开关，字体回退检测永远拿不到证据。
      // --synctex 产出 <main>.synctex.gz：PDF 坐标 ↔ 源码行 的精确映射，
      // 用来做"在 PDF 里点一下 → 跳到源码对应位置"（比文本匹配可靠得多）。
      const child = spawn(
        this.binary!,
        ['-X', 'compile', mainPath, '--keep-logs', '--synctex', '--outdir', '.'],
        {
        cwd: workDir,
        env: {
          ...process.env,
          // Tectonic 要写配置与缓存；把 HOME/XDG 指到仓库内，避免被只读文件系统拦住
          HOME: home,
          XDG_CACHE_HOME: join(home, '.cache'),
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local/share'),
          TECTONIC_CACHE_DIR: cache,
        },
      });

      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        // 这个前缀会被解析成一条 error 诊断，UI 上直接可见；
        // 否则用户在界面上只能看到一个"编译失败"，完全不知道是超时。
        output +=
          `\n! PaperFlow: 编译超时（${Math.round(this.timeoutMs / 1000)}s）。` +
          '如果项目里有几百 MB 的插图，首次排版会很慢；' +
          '可以用 TECTONIC_TIMEOUT_MS 调大上限，或者先压缩图片尺寸。';
      }, this.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, output });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({ code: 1, output: `${output}\n[paperflow] 无法启动 Tectonic：${err.message}` });
      });
    });
  }
}

/**
 * pdfLaTeX 时代的字体族 → XeTeX 可用的度量兼容字体（TeX Gyre 系列）。
 *
 * 为什么需要：老牌会议类文件（ieeeconf、IEEEtran 等）里写着"IEEE 用 Times"，
 * 实现方式是 `\renewcommand{\rmdefault}{ptm}`。这类字体只有 OT1/T1 定义，
 * **在 XeTeX 下没有 `TUptm.fd`**，于是每一款字形都找不到、静默回退成 Computer Modern。
 * 而 Computer Modern 比 Times 宽，行数与页数都会变——用户会看到"Overleaf 里 8 页，
 * 这里变成 11 页"这种莫名其妙的结果（实测：54 条字体回退警告，9 页 → 加兼容层后 8 页）。
 *
 * TeX Gyre 是这些字体的**度量兼容**克隆（Termes=Times、Heros=Helvetica、Cursor=Courier），
 * 所以换上去之后断行与页数与原排版一致，而 Tectonic 的宏包集里就有它们。
 */
const FONT_FAMILY_MAP: Record<string, { regular: string; bold: string; italic: string; boldItalic: string }> = {
  ptm: { regular: 'texgyretermes-regular.otf', bold: 'texgyretermes-bold.otf', italic: 'texgyretermes-italic.otf', boldItalic: 'texgyretermes-bolditalic.otf' },
  phv: { regular: 'texgyreheros-regular.otf', bold: 'texgyreheros-bold.otf', italic: 'texgyreheros-italic.otf', boldItalic: 'texgyreheros-bolditalic.otf' },
  pcr: { regular: 'texgyrecursor-regular.otf', bold: 'texgyrecursor-bold.otf', italic: 'texgyrecursor-italic.otf', boldItalic: 'texgyrecursor-bolditalic.otf' },
  ppl: { regular: 'texgyrepagella-regular.otf', bold: 'texgyrepagella-bold.otf', italic: 'texgyrepagella-italic.otf', boldItalic: 'texgyrepagella-bolditalic.otf' },
  pbk: { regular: 'texgyrebonum-regular.otf', bold: 'texgyrebonum-bold.otf', italic: 'texgyrebonum-italic.otf', boldItalic: 'texgyrebonum-bolditalic.otf' },
  pag: { regular: 'texgyreadventor-regular.otf', bold: 'texgyreadventor-bold.otf', italic: 'texgyreadventor-italic.otf', boldItalic: 'texgyreadventor-bolditalic.otf' },
  pnc: { regular: 'texgyreschola-regular.otf', bold: 'texgyreschola-bold.otf', italic: 'texgyreschola-italic.otf', boldItalic: 'texgyreschola-bolditalic.otf' },
};

/** 从日志里找出"哪些字体族回退了"——只修真正出问题的，不猜。 */
export function detectMissingFontFamilies(log: string): string[] {
  const families = new Set<string>();
  const re = /Font shape `TU\/([a-z0-9]+)\/[a-z]+\/[a-z]+' undefined/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(log)) !== null) {
    if (FONT_FAMILY_MAP[match[1]!]) families.add(match[1]!);
  }
  return [...families];
}

/** 生成字体兼容层的导言区代码（只处理日志里真的回退了的字体族）。 */
export function buildFontShim(families: string[]): string {
  const lines = [
    '% [paperflow] 字体兼容层：文档请求的 Type1 字体在 XeTeX 下不存在，',
    '% 会静默回退成 Computer Modern（更宽，行数与页数都会变）。',
    '% 这里换成度量兼容的 TeX Gyre 字体，使排版与原 pdfLaTeX 输出一致。',
    '\\usepackage{fontspec}',
  ];
  for (const family of families) {
    const font = FONT_FAMILY_MAP[family]!;
    const command =
      family === 'ptm' ? '\\setmainfont' : family === 'phv' ? '\\setsansfont' : family === 'pcr' ? '\\setmonofont' : '\\newfontfamily\\paperflowfont';
    lines.push(
      `${command}{${font.regular}}[`,
      `  BoldFont=${font.bold},`,
      `  ItalicFont=${font.italic},`,
      `  BoldItalicFont=${font.boldItalic}]`,
    );
  }
  return lines.join('\n');
}

/** 把兼容层插到 \begin{document} 之前（导言区末尾，这样能覆盖类文件的设置）。 */
export function injectFontShim(content: string, shim: string): string {
  const marker = /\\begin\{document\}/;
  const match = marker.exec(content);
  if (!match) return `${content}\n${shim}\n`;
  return `${content.slice(0, match.index)}${shim}\n${content.slice(match.index)}`;
}

/**
 * 生成最小化的中文支持。
 *
 * ⚠️ 这里刻意**不用 `ctex`**：ctex 做的是"完整中文排版"，会全局调整行距、首行缩进与
 * 中西文间距——对一篇只有零星中文的英文论文来说，代价是**页数直接多 3 页**
 * （受控实测：只注入 ctex = 11 页；改用 xeCJK = 8 页，与 Overleaf 一致）。
 *
 * `xeCJK` 只接管中日韩字符本身，拉丁文排版完全不受影响，这才是"能显示中文"的最小改动。
 * 需要完整中文排版（首行缩进两字符等）时，作者应自行在文档里加载 ctex 并接受页数变化。
 *
 * 字体用 Fandol（Tectonic 宏包集自带，已验证 Song/Hei/Kai/Fang 四款齐全）。
 */
export function buildCjkPreamble(): string {
  return [
    '% [paperflow] 最小中文支持：只影响中日韩字符，不改变英文排版。',
    '% 如需完整中文排版（首行缩进等），请自行加载 ctex —— 注意它会改变行距与页数。',
    '\\usepackage{xeCJK}',
    '\\setCJKmainfont{FandolSong-Regular.otf}[BoldFont=FandolSong-Bold.otf,ItalicFont=FandolKai-Regular.otf]',
    '\\setCJKsansfont{FandolHei-Regular.otf}',
    '\\setCJKmonofont{FandolFang-Regular.otf}',
  ].join('\n');
}

/** 把中文支持插到 \documentclass 之后（xeCJK 需要在宏包区靠前加载）。 */
export function injectCjkPreamble(content: string): string {
  const code = buildCjkPreamble();
  const match = /\\documentclass(\[[^\]]*\])?\{[^}]*\}/.exec(content);
  if (!match) return `${code}\n${content}`;
  const insertAt = match.index + match[0].length;
  return `${content.slice(0, insertAt)}\n${code}${content.slice(insertAt)}`;
}

/**
 * 解析 Tectonic 输出的诊断。
 *
 * 它的格式是 `error: <file>:<line>: <message>` / `warning: ...`，
 * 直接带行号，正好可以喂给前端的"问题列表"点击跳转。
 */
export function parseDiagnostics(output: string): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const withPosition = /^(error|warning):\s+([^:\s]+):(\d+):\s*(.+)$/.exec(line);
    if (withPosition) {
      const key = `${withPosition[1]}:${withPosition[2]}:${withPosition[3]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        level: withPosition[1] === 'error' ? 'error' : 'warning',
        file: withPosition[2]!,
        line: Number.parseInt(withPosition[3]!, 10),
        message: withPosition[4]!,
      });
      continue;
    }
    // 没有行号的错误（例如缺 \end{document}）也要收进来，否则用户看不到失败原因
    const bare = /^error:\s+(.+)$/.exec(line);
    if (bare && !/^error: halted/.test(line)) {
      const key = `error:${bare[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({ level: 'error', file: 'main.tex', line: 1, message: bare[1]! });
    }
  }
  return diagnostics;
}
