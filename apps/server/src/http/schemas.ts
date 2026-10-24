/** 请求体 schema：把"契约"这件事落到运行时可验证的层面。 */

import { z } from 'zod';

export const selectionSchema = z.object({
  fileId: z.string().min(1),
  start: z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() }),
  end: z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() }),
  text: z.string().max(200_000),
});

export const chatTurnSchema = z.object({
  threadId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128).optional(),
  clientId: z.string().max(64).optional(),
  channel: z.enum(['room', 'private']).optional(),
  mainFile: z
    .object({
      fileId: z.string().min(1).max(500),
      path: z.string().min(1).max(500),
      content: z.string().max(8_000_000),
      version: z.number().int().nonnegative(),
    })
    .optional(),
  prompt: z.string().min(1).max(20_000),
  selection: selectionSchema.optional(),
  intent: z
    .enum(['rewrite', 'tighten', 'polish', 'translate', 'expand', 'review', 'critique'])
    .optional(),
  participants: z.array(z.string().min(1)).max(16).optional(),
  clientMessageId: z.string().optional(),
  quotedMessageId: z.string().optional(),
  document: z
    .object({
      fileId: z.string().min(1),
      content: z.string().max(2_000_000),
      version: z.number().int().nonnegative(),
    })
    .optional(),
});

export const compileRequestSchema = z.object({
  fileId: z.string().min(1),
  engine: z.enum(['auto', 'pdflatex', 'xelatex', 'lualatex']).optional(),
  content: z.string().max(2_000_000),
  mainPath: z.string().min(1).max(500).optional(),
  projectId: z.string().min(1).max(128).optional(),
  auxFiles: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        content: z.string().max(64 * 1024 * 1024),
        encoding: z.enum(['utf8', 'base64']).optional(),
      }),
    )
    .max(500)
    .optional(),
});

export const addReferenceSchema = z.object({
  title: z.string().max(300).optional().default(''),
  // 上限 2MB 文本：足够放下十几页论文，又不至于让检索与提示词爆掉
  text: z.string().min(1).max(2_000_000),
  kind: z.enum(['pdf', 'text', 'bibtex', 'note', 'url']).default('text'),
  source: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  /**
   * PDF 页面图像（data URL）。上限 8 张、每张约 200KB：
   * 图像只是给视觉模型看的，不应该把落盘文件撑爆。
   */
  /** 单张约 200KB base64，8 张 → 约 1.6MB，留出余量设 4MB 上限 */
  pageImages: z.array(z.string().max(4_000_000)).max(8).optional(),
  pageCount: z.number().int().positive().max(5000).optional(),
});

export const importBibtexSchema = z.object({
  bibtex: z.string().min(1).max(2_000_000),
});

export const locateSchema = z.object({
  page: z.number().int().min(1),
  /** bp（1/72 英寸），原点在页面左下角 */
  x: z.number(),
  y: z.number(),
  pageHeight: z.number().positive(),
});

export const importPathSchema = z.object({
  name: z.string().max(120).optional(),
  /** 服务器本地路径：目录或 .zip */
  path: z.string().min(1).max(4096),
  replace: z.boolean().optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  /** 新建时可直接带上一个 zip（"上传 IROS 的压缩包 → 多一个项目"） */
  zipBase64: z.string().min(1).max(200 * 1024 * 1024).optional(),
  /** 服务端用演示论文初始化（前端新建空项目时不需要）。 */
  seed: z.boolean().optional(),
});
export const renameProjectSchema = z.object({ name: z.string().min(1).max(120) });

export const readEntrySchema = z.object({ path: z.string().min(1).max(500) });
export const writeFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(64 * 1024 * 1024),
  encoding: z.enum(['utf8', 'base64']).optional(),
});
export const createFolderSchema = z.object({ path: z.string().min(1).max(500) });
export const renameEntrySchema = z.object({
  from: z.string().min(1).max(500),
  to: z.string().min(1).max(500),
});
export const deleteEntrySchema = z.object({ path: z.string().min(1).max(500) });
export const setRootSchema = z.object({ path: z.string().min(1).max(500) });
export const importZipSchema = z.object({
  /** 整个 zip 的 base64（Overleaf 导出的项目就是这个形态） */
  zipBase64: z.string().min(1).max(200 * 1024 * 1024),
  /** 是否清空现有文件后再导入（默认合并，同名覆盖） */
  replace: z.boolean().optional(),
});

export type ImportBibtexBody = z.infer<typeof importBibtexSchema>;
export type AddReferenceBody = z.infer<typeof addReferenceSchema>;
export type ChatTurnBody = z.infer<typeof chatTurnSchema>;
export type CompileRequestBody = z.infer<typeof compileRequestSchema>;
