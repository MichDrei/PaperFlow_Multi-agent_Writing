/**
 * 论文文档与共享知识上下文的领域模型。
 */

export type FileId = string;

export type FileKind = 'tex' | 'bib' | 'style' | 'image' | 'other';

export interface PaperFile {
  id: FileId;
  path: string;
  kind: FileKind;
  content: string;
  /**
   * 内容编码。二进制资源（图片、.cls、.bst、.pdf）用 base64——
   * 不能强行当 UTF-8 文本，否则读出来是乱码、也写不回磁盘。
   */
  encoding?: 'utf8' | 'base64';
  /** 字节数，用于在文件树里显示大小。 */
  size?: number;
  /** 每次成功编辑 +1，用于判断 diff 提议是否已过期。 */
  version: number;
}

/** 文件树节点（由 PaperFile 派生，用于侧栏展示）。 */
export interface FileTreeNode {
  id: FileId;
  name: string;
  kind: FileKind;
  children?: FileTreeNode[];
}

/**
 * 项目清单（服务端项目存储的对外视图）。
 * 只含元信息，不含文件正文——正文按需读取，避免一个响应塞进整篇论文加所有图片。
 */
export interface ProjectManifest {
  projectId: string;
  /** 主文件名（编译入口），对应 Overleaf 里的"主文档"。 */
  rootPath: string;
  files: ProjectFileEntry[];
}

export interface ProjectFileEntry {
  path: string;
  kind: FileKind;
  encoding: 'utf8' | 'base64';
  size: number;
  /** 目录项（由路径推导，不是真实文件）。 */
  isDirectory?: boolean;
}

export interface PaperDocument {
  id: string;
  title: string;
  rootFileId: FileId;
  files: Record<FileId, PaperFile>;
  updatedAt: string;
}

/** 参考文献条目（BibTeX 的规范化形态）。 */
export interface Citation {
  key: string;
  type: 'article' | 'inproceedings' | 'book' | 'misc' | 'techreport';
  title: string;
  authors: string[];
  year: number;
  venue?: string;
  doi?: string;
  url?: string;
  tags: string[];
}

/** 术语一致性词条：统一译法 + 禁用写法。 */
export interface TerminologyEntry {
  id: string;
  term: string;
  translation: string;
  definition: string;
  /** 不允许出现的同义/错误写法，用于一致性检查。 */
  forbidden: string[];
  locked: boolean;
}

export interface FigureAsset {
  id: string;
  label: string;
  path: string;
  caption: string;
  /** 源码中引用该图的文件与行号。 */
  referencedAt?: { fileId: FileId; line: number }[];
}

/**
 * 用户添加的参考资料（论文全文 / 摘录 / 笔记 / 网址正文）。
 *
 * 与 Citation 的区别：Citation 是**结构化条目**（作者、年份、出处），用于生成 \cite{}；
 * ReferenceDocument 是**可检索的正文**，会被 BM25 检索后注入模型上下文，
 * 让模型能引用你指定的材料，而不是只靠训练记忆。
 */
export type ReferenceKind = 'pdf' | 'text' | 'bibtex' | 'note' | 'url';

export interface ReferenceDocument {
  id: string;
  title: string;
  kind: ReferenceKind;
  /** 已提取的纯文本（PDF 在浏览器端用 pdf.js 提取后上传）。 */
  text: string;
  /** 来源说明：文件名 / 网址 / "手动粘贴"。 */
  source?: string;
  addedAt: string;
  charCount: number;
  tags: string[];
  /**
   * PDF 渲染出的页面图像（data URL，客户端渲染，最多若干页）。
   *
   * 为什么要它：纯文本提取会丢版面（公式、表格、图），而且用户明确要求"不要让模型看 OCR 文本，
   * 让它自己看图"。**只有支持视觉的模型**能收到这些图片；纯文本模型仍用上面的 text。
   */
  pageImages?: string[];
  /** 原始 PDF 页数（可能大于 pageImages.length，因为会限流）。 */
  pageCount?: number;
}

/** 所有协作方（人与模型）共享的知识底座。 */
export interface SharedContext {
  citations: Citation[];
  terminology: TerminologyEntry[];
  figures: FigureAsset[];
  /** 用户添加的参考资料；会参与检索并注入模型上下文。 */
  references: ReferenceDocument[];
}
