# services/latex-compiler （P3）

真正的 LaTeX 编译服务。当前**尚未实现**：开发期由 `packages/latex` 里的 `MockCompiler`
（pdf-lib 粗排，浏览器端即可运行）承担"编辑 → 编译 → 预览 → 定位"的链路验证。

本文件锁定接口契约，保证接入时上层零改动（`HttpCompiler` 已按此实现）。

## 接口

### `POST /compile`

请求体（与 `@paperflow/core` 的 `CompileRequest` 一致）：

```json
{
  "fileId": "file-main",
  "content": "\\documentclass{article}...",
  "auxFiles": [{ "path": "refs.bib", "content": "@article{...}" }]
}
```

响应体：

```json
{
  "ok": true,
  "log": "…TeX 引擎输出…",
  "diagnostics": [
    { "level": "error", "file": "main.tex", "line": 42, "column": 3, "message": "Undefined control sequence" }
  ],
  "pdfBase64": "JVBERi0xLjQK…",
  "anchors": [{ "line": 42, "page": 1, "y": 512.3 }],
  "durationMs": 1830
}
```

- `diagnostics` 必须带**可定位的行号**——前端把它渲染成可点击的问题列表，直接跳转到编辑器对应行。
- `anchors` 是 SyncTeX 的简化形态（源码行 → 页码 + PDF 坐标系 y），用于"AI 改动后跳到对应页并高亮"。
- `pdfBase64` 而不是 URL，是为了让服务保持无状态、可水平扩容。

## 实现建议

```dockerfile
FROM rust:1-slim AS build
RUN cargo install tectonic

FROM debian:bookworm-slim
COPY --from=build /usr/local/cargo/bin/tectonic /usr/local/bin/tectonic
# 首次编译会按需拉取宏包；预热常用宏包可显著降低 P95 延迟
```

外层建议再包一层 HTTP（FastAPI / Fastify 均可）+ 作业队列：

- 单次编译超时（默认 120s）与内存上限（`--max-cache-size`）；
- 以源码内容哈希做结果缓存（`apps/server/src/services/compileService.ts` 已有同构的缓存层）；
- 编译沙箱**禁止网络**（除首次宏包拉取），避免不可信 LaTeX 触发 `\write18` 等逃逸。

## 切换方式

```bash
# apps/server/.env
LATEX_COMPILER_URL=http://127.0.0.1:8788
```

设置后 `CompileService` 会自动改用远端引擎，前端与编排层无需任何改动。
