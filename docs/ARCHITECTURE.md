# PaperFlow 架构与目录规划

> 多 LLM 协作的科研论文写作平台 = Overleaf（LaTeX 编辑 + PDF 编译预览）+ Cursor（选区改写 + diff 应用）+ 多智能体群聊（多厂商模型同处一个会话线程协作）。

本文档定义项目的**模块化目录层次**、各模块职责边界、依赖方向与演进路线。目录按"可独立演进/可独立部署/可独立测试"三个标准切分。

---

## 1. 设计原则

| 原则 | 落地方式 |
| --- | --- |
| **按业务能力分包，不按技术分层** | `packages/agents`（编排）、`packages/llm`（模型接入）、`packages/context`（共享知识）、`packages/latex`（编译）各自是一个业务能力，而不是 `controllers/services/models` 这种技术分层。 |
| **依赖单向向下** | `apps → packages → packages/core`。`core` 是最底层的纯类型与领域契约，零运行时依赖、零 IO；任何包都不得反向依赖 `apps`。 |
| **契约先行** | 所有跨模块数据结构定义在 `packages/core`（PaperDocument、Selection、ChatMessage、EditProposal…），前后端共用同一套 TypeScript 类型，避免接口漂移。 |
| **IO 与逻辑分离** | 模型调用、文件读写、编译执行都在包内以"适配器接口 + 具体实现"的形式提供（如 `LatexCompiler` 接口 → `MockCompiler` / `HttpCompiler`）。换实现不改调用方。 |
| **可独立部署** | `apps/server` 是无状态 BFF，`services/latex-compiler` 是独立容器，二者可各自水平扩容；重编译不阻塞聊天服务。 |
| **可降级运行** | 未配置任何 API Key 时，UI 走内置 mock 数据 + 浏览器端模拟编译，产品雏形照样可演示。 |

---

## 2. 目录总览

```
dsh-demo/
├── apps/                          # 可运行的应用（部署单元）
│   ├── web/                       # 前端单体：编辑器 + PDF + 群聊
│   └── server/                    # BFF / 编排服务（Node + Fastify）
│
├── packages/                      # 可复用的领域模块（库单元）
│   ├── core/                      # 【最底层】领域模型与类型契约
│   ├── llm/                       # 多厂商 LLM 网关（OpenAI/Anthropic/Gemini/…）
│   ├── agents/                    # 多智能体编排（路由、角色、上下文序列化）
│   ├── context/                   # 共享知识上下文（bib / 术语 / 图表 / 检索）
│   ├── latex/                     # LaTeX 编译与 SyncTeX 客户端
│   └── ui/                        # 设计系统与通用组件
│
├── services/                      # 独立进程 / 容器化服务
│   └── latex-compiler/            # TeX Live 编译沙箱（HTTP + Docker）
│
├── docs/                          # 架构、协议、路线图
├── infra/                         # Docker Compose、CI、部署清单
├── scripts/                       # 脚手架 / 代码生成 / 运维脚本
└── .github/workflows/             # CI 流水线
```

### 2.1 `apps/` — 应用层

```
apps/web/                          # Vite + React + TypeScript（SPA，便于后续打包 Electron/Tauri）
├── index.html
├── vite.config.ts
├── .env.example                   # VITE_API_BASE / VITE_COMPILER_URL
└── src/
    ├── main.tsx                   # 挂载入口（同时初始化 Monaco）
    ├── App.tsx                    # 顶层布局编排（三栏骨架 + 全局快捷键）
    ├── components/                # 布局级组件：TopBar / StatusBar
    ├── features/                  # ★ 按功能切分，一个功能一个文件夹
    │   ├── editor/LatexEditor.tsx # 左：Monaco + 选区快照 + 浮动 AI 工具栏
    │   ├── pdf/PdfPreview.tsx     # 左下：pdf.js 渲染 + 锚点高亮 + 诊断面板
    │   ├── explorer/              # 最左：活动栏 + 文件树 / 大纲 / 共享知识 / 模型设置
    │   └── chat/                  # 右：群聊面板（ChatPanel / MessageBubble /
    │                              #     Composer / DiffCard / ModelRoster）
    ├── stores/                    # Zustand 切片
    │   ├── workspaceStore.ts      # 文档、选区、编译产物、共享知识
    │   ├── chatStore.ts           # 会话、消息归并、提议生命周期、后端探测
    │   ├── composerStore.ts       # 输入框草稿与 @提及追加
    │   └── editorStore.ts         # 光标 / 选区度量（高频，独立以免拖累文档状态）
    ├── transport/                 # ★ 与后端的唯一接口
    │   ├── types.ts               # ChatTransport 接口
    │   ├── mockTransport.ts       # 浏览器内多模型模拟（无 Key 也能演示全链路）
    │   ├── httpTransport.ts       # 连接 apps/server 的 SSE
    │   └── index.ts               # createTransport()：按环境变量二选一
    ├── lib/                       # 前端工具：monaco 配置、LaTeX 词法、轻量 Markdown、
    │                              # 大纲解析、意图推断、文本工具转出
    └── styles/index.css           # Tailwind v4 入口与主题变量
```

```
apps/server/                       # Node 22 + Fastify + tsx
└── src/
    ├── index.ts                   # 启动、插件注册、优雅退出
    ├── env.ts                     # 环境变量与配置校验（zod）
    ├── http/
    │   ├── routes/                # chat.ts（SSE）/ compile.ts / meta.ts（models、sessions）
    │   ├── sse.ts                 # SSE 编码与心跳（含"不要用 writeHead 覆盖已设置的头"的坑）
    │   └── schemas.ts             # zod 请求体校验
    ├── services/                  # 编排用例（调用 packages/*）
    │   ├── chatService.ts         # 一次群聊回合：转发事件 + 落库会话历史
    │   └── compileService.ts      # 编译用例（内容哈希缓存）
    └── storage/memory.ts          # 内存持久层（SessionStore / ContextStore 两个窄接口）
```

### 2.2 `packages/` — 领域模块层

```
packages/core/src/                  # 纯类型 + 纯算法，零 IO、零运行时依赖
├── model.ts                       # ModelDescriptor、ProviderId、AgentRole、Usage
├── document.ts                    # PaperDocument、PaperFile、Citation、术语、图表
├── chat.ts                        # Thread、ChatMessage、Mention、Turn
├── edit.ts                        # Selection、EditProposal、DiffHunk、ApplyResult
├── diff.ts                        # ★ LCS 行级 diff + hunk 分组 + 按选择应用
├── mentions.ts                    # ★ @提及解析（前后端共用同一份权威实现）
├── text.ts                        # 纯文本变换（压缩/润色/重新折行/审稿式静态分析）
├── catalog.ts                     # 默认模型目录与角色提示词
├── protocol.ts                    # SSE 事件联合类型 + 请求体（唯一传输契约）
└── index.ts

packages/llm/src/
├── types.ts                       # LlmRequest / LlmChunk / LlmProvider 统一抽象
├── registry.ts                    # 环境变量 → 提供方装配；模型 id → 提供方路由；未配置则降级
├── providers/
│   ├── openai.ts                  # OpenAI 兼容协议（覆盖 OpenAI/DeepSeek/Kimi/Qwen/OpenRouter/Ollama）
│   ├── anthropic.ts               # Messages API
│   ├── google.ts                  # Generative Language API
│   └── mock.ts                    # 无 Key 时的本地回退（仍走完整 SSE 链路）
├── stream.ts                      # SSE / NDJSON 解析（跨 chunk 半行、CRLF、注释帧）
└── index.ts

packages/agents/src/
├── orchestrator.ts                # ★ async generator 事件流：并发扇出 + 交叉评审 + 提议产出
├── router.ts                      # 回合策略：并发上限、角色分配、是否交叉评审
├── roles.ts                       # 角色系统提示 + 撰写者的输出格式合约
├── serializer.ts                  # 群聊上下文 → 各模型 prompt（术语 + 检索 + 历史预算）
├── proposal.ts                    # 模型输出 → EditProposal（围栏抽取 + 回声过滤）
└── index.ts

packages/context/src/
├── bibliography.ts                # BibTeX 括号配对解析、引用审计（缺失/未引用）
├── terminology.ts                 # 术语一致性词典（统一译法 + 禁用写法 + 提示词注入）
├── retriever.ts                   # BM25 检索（向量检索的接口位置已预留）
├── demoProject.ts                 # 演示项目固件（论文 / 文献 / 术语 / 图表）
└── index.ts

packages/latex/src/
├── compiler.ts                    # LatexCompiler 接口 + SourceAnchor（SyncTeX 简化形态）
├── mockCompiler.ts                # ★ 浏览器端真 PDF 排版 + 源码行锚点 + 结构化诊断
├── httpCompiler.ts                # 调用 services/latex-compiler（接口与 Mock 完全一致）
└── index.ts

packages/ui/src/                   # 无业务逻辑的展示组件
├── Button.tsx                     # Button / IconButton / Spinner
├── primitives.tsx                 # Avatar / Pill / Panel / Segmented / EmptyState / Kbd
└── index.ts
```

### 2.3 `services/` 与 `infra/`

```
services/latex-compiler/           # P3：独立服务（Tectonic / TeX Live）
└── README.md                      # 接口契约已锁定：POST /compile → PDF + anchors + log

infra/
└── docker-compose.yml             # web + server（+ latex-compiler，profile: latex）
```

---

## 3. 依赖方向（硬约束）

```
        apps/web ──────────┐
                           ├──► packages/ui
        apps/server ───────┤
                           ├──► packages/agents ──► packages/llm ──┐
                           ├──► packages/context ───────────────────┼──► packages/core
                           └──► packages/latex ─────────────────────┘
```

- `packages/core` 不依赖任何其他包。
- `packages/llm` 只做"把统一请求翻译成各家 HTTP 调用"，不含业务策略。
- 业务策略（谁该发言、如何裁剪上下文）只在 `packages/agents`。
- `apps/web` 不直接调用厂商 API：一律经 `apps/server`，API Key 永不进浏览器。

---

## 4. 关键技术选型

| 层次 | 选型 | 理由 |
| --- | --- | --- |
| 前端框架 | Vite + React 18 + TypeScript | 纯桌面型编辑器应用，无需 SSR；构建快，后续可直接包 Electron/Tauri。 |
| 编辑器 | Monaco Editor | VS Code 同源，装饰器/多光标/悬浮工具栏 API 完整，适合实现"选中→改写"。 |
| PDF | pdf.js（pdfjs-dist） | 纯前端渲染，配合 SyncTeX 做双向定位。 |
| 分栏 | react-resizable-panels | 可拖拽三栏，布局持久化。 |
| 状态 | Zustand | 轻量、无 Provider 嵌套，适合高频编辑器状态。 |
| 样式 | Tailwind CSS v4 | 快速搭建深色 IDE 风格。 |
| 服务端 | Node 22 + Fastify | 原生 fetch/stream，SSE 流式转发简单，与前端共享 TS 类型。 |
| 多厂商接入 | 自研薄网关（`packages/llm`） | 只依赖 fetch，零 SDK 锁定；OpenAI 兼容协议可覆盖 DeepSeek/Kimi/Qwen/Ollama，另有 Anthropic/Gemini 适配。 |
| 编译 | Tectonic（容器）| 单二进制、按需拉取宏包、无需完整 TeX Live；开发期用浏览器端 MockCompiler 兜底。 |
| 实时 | SSE（HTTP/1.1 长连接）| 单向流足够；比 WebSocket 更易穿透代理与调试。 |

---

## 5. 多 Agent 交互协议（核心）

一次"群聊回合"的生命周期：

1. **用户输入**：`@claude 把 Methods 第二段改写得更紧凑，@gpt-4o 审一下逻辑` + 可选 `Selection`（编辑器选区）。
2. **路由**（`agents/router.ts`）：解析 @提及 → 得到 `{targets, instruction, selection, threadRefs}`。未指定则用会话默认阵容。
3. **并发扇出**：对每个目标模型并发调用 `llm.stream()`，各自带**角色化系统提示**与**上下文包**（选区全文、相邻段落、相关文献、术语表）。
4. **流式回流**：通过 SSE 事件 `message.delta` 增量写入群聊；用户可实时看到多个模型同时"打字"。
5. **结构化提议**：模型被要求以 `EditProposal`（`fileId + range + replacement + rationale`）形式输出改写结果；后端解析并计算 `DiffHunk[]`。
6. **互相点评**：`orchestrator` 可发起第二轮，把 A 的提议作为 B 的输入（"请批判性审阅这份改写"），形成交叉评审。
7. **人工裁决**：前端 diff 卡片提供按 hunk 的接受/拒绝，应用到编辑器后回写文档版本号。

SSE 事件契约（`packages/core/src/protocol`）：

```ts
type StreamEvent =
  | { type: 'turn.start';    turnId: string; targets: ModelId[] }
  | { type: 'message.start'; messageId: string; modelId: ModelId; role: AgentRole }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.tool';  messageId: string; tool: string; args: unknown }
  | { type: 'proposal';      messageId: string; proposal: EditProposal; hunks: DiffHunk[] }
  | { type: 'message.end';   messageId: string; usage: Usage }
  | { type: 'turn.end';      turnId: string }
  | { type: 'error';         messageId?: string; code: string; message: string }
```

---

## 6. 演进路线

| 阶段 | 目标 | 交付物 | 状态 |
| --- | --- | --- | --- |
| **P0 骨架** | 目录与契约落定 | 本文档、workspaces、`packages/core`、`packages/ui` | ✅ |
| **P1 UI 雏形** | 可交互的界面 | 三栏布局、Monaco、PDF 预览、群聊面板、@提及、diff 卡片 | ✅ 浏览器实测 11/11 |
| **P2 多 Agent** | 真实模型接入与编排 | `packages/llm`、`packages/agents`、`apps/server` SSE、前端接线 | ✅ 端到端实测 11/11 |
| **P3 编译闭环** | 真实 LaTeX 编译 | `services/latex-compiler`、SyncTeX 双向定位、错误定位到行 | ⏳ 接口已锁定 |
| **P4 知识底座** | 文献/术语/图表检索 | BibTeX 解析、混合检索、上下文自动装配 | 部分：BM25 + 术语 + 引用审计已可用 |
| **P5 协作与持久化** | 多人实时协作 | CRDT（Yjs）、项目持久化、版本历史、导出 | ⏳ |

### 验证方式（可复现）

```bash
npm test                # 33 个测试（node:test）：算法 19 + 厂商协议 7 + 服务端契约 7
npm run typecheck       # 严格模式全量类型检查
npm run verify:ui       # 真实 Chromium：编辑 → 选区 → 群聊 → diff → 应用
```

测试分层与"为什么这么分"：

| 层 | 文件 | 挡住的失败 |
| --- | --- | --- |
| 纯算法 | `tests/core.test.ts` | diff 应用错位、@路由歧义、BibTeX 丢字段、回声被当成改动 |
| 厂商协议 | `tests/providers.test.ts` | 请求 URL/头/body 写错、跨 chunk 半行 JSON 丢字、上游错误未结构化 |
| 服务端契约 | `tests/server.test.ts` | CORS 头被 hijack 吃掉、SSE 事件序列缺失、anchors 漏传、缓存失效 |
| 端到端 UI | `scripts/verify-ui.mjs` | 渲染/交互回归（真实 Chromium，两种运行模式各 11 步） |

服务端可通过 `buildServer()`（`apps/server/src/app.ts`）在临时端口装配，因此契约测试能走完整 HTTP 栈；
`apps/server/src/index.ts` 只负责监听与优雅退出。

两次实测均通过且控制台零错误：
`VERIFY_TAG=mock`（浏览器内 Mock 模式）与 `VERIFY_TAG=live`（真实 Fastify + SSE 后端）。
截图落在 `artifacts/`。

---

## 7. 命名与代码规范

- 目录：`kebab-case`；React 组件文件：`PascalCase.tsx`；其余 `camelCase.ts`。
- 跨包引用一律走包名（`@paperflow/core`），禁止 `../../packages/...` 相对穿越。
- 每个包有单一出口 `src/index.ts`，外部只能从出口导入。
- 新增厂商适配器 = 在 `packages/llm/src/providers/` 加一个文件并在 `registry.ts` 注册，不改任何调用方。
