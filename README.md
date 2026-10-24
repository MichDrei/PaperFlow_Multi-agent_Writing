# PaperFlow

**多 LLM 协作的科研论文写作平台** —— 把 Overleaf（LaTeX 编辑 + PDF 编译预览）、Cursor（选区改写 + diff 应用）和"多模型群聊协作"合成一个工作台。

多个厂商的模型（Claude / GPT / Gemini / DeepSeek / Kimi / Qwen / 本地 Ollama）被拉进**同一个会话线程**：你选中一段 LaTeX，@ 其中几个模型，它们各自以不同角色（撰写者 / 审稿人 / 方法学家 / 编辑）并行产出意见和改写方案；改写必须经过你的逐块裁决（diff）才会写回论文。

> 当前进度：目录骨架 ✅ · UI 雏形 ✅（已浏览器实测）· 多 Agent 编排 ✅（已端到端实测）· 真实 TeX 编译 ⏳

---

## 1. 快速开始

```bash
# 依赖安装（Node >= 20）
npm install

npm run dev              # web:5273 + server:8787   ← 推荐
npm run dev:web          # 只跑前端（后端不在时自动退回浏览器内 Mock）
npm run dev:server       # 只跑编排服务
```

**零配置即可连通**：前端在开发模式下通过 Vite 的 `/api` 代理访问编排服务（同源，因此不存在 CORS），
启动时自动探测后端并如实显示当前状态。只有一个例外需要显式配置：后端跑在**别的机器或端口**时，
在 `apps/web/.env.local` 里写 `VITE_API_BASE=http://host:port`。

界面顶部会如实显示当前是哪一种模式，三种状态对应三种回答来源：

| 模式徽标 | 触发条件 | 谁在回答 |
| --- | --- | --- |
| `浏览器内 Mock` | 探测不到后端（例如只跑了 `dev:web`） | 浏览器内本地引擎：审稿意见来自对选中文本的真实静态分析，改写来自确定性文本变换 |
| `后端已连 · 无 Key` | 后端在线，但没有任何厂商 Key | 服务端本地回退引擎（走完整 SSE 链路与编排逻辑） |
| `真实模型 · deepseek/qwen` | 至少一个厂商 Key 可用 | 真实厂商模型，多模型并发流式输出 |

> 只跑前端时，控制台会出现一两条 `/api` 资源加载失败日志——那是自动探测后端失败的预期结果，
> 不是应用错误（`ALLOW_BACKEND_PROBE_FAILURE=1 npm run verify:ui` 会把它单独归类）。

### 接入真实模型

```bash
cp apps/server/.env.example apps/server/.env
# 填入任意一个或多个 Key：
#   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / DEEPSEEK_API_KEY
#   MOONSHOT_API_KEY / QWEN_API_KEY / OPENROUTER_API_KEY / OLLAMA_BASE_URL

cat > apps/web/.env.local <<'EOF'
VITE_API_BASE=http://127.0.0.1:8787
EOF

npm run dev
```

API Key 只存在于服务端进程，**永不下发到浏览器**。新增一个厂商 = 在 `packages/llm/src/registry.ts` 加一行。

### 只加 DeepSeek + Qwen 的最小配置

```bash
cp apps/server/.env.example apps/server/.env

# 直接追加到文件末尾——不要在示例行上改（那些行以 # 开头，是注释，
# 填在注释里的 Key 不会报错，只会静默降级到本地回退）
cat >> apps/server/.env <<'EOF'
DEEPSEEK_API_KEY=sk-你的deepseek-key
QWEN_API_KEY=sk-你的百炼-key
EOF

npm run check:models   # ← 自检：打印读到的配置文件、指出被注释的 Key 行号、真实请求验证
npm run dev            # 前端无需任何配置
# ⚠️ 如果后端在填 Key 之前就已经在跑，必须重启它才会读到新 Key（否则界面里回的是"本地回退回复"）
```

自检输出示例（它同时也是一份排错报告）：

```
读取的配置文件：
  ✓ /home/.../apps/server/.env
⚠️  这些行填了真实密钥，但**行首有 # 被注释掉了**，等于没配：
    .../apps/server/.env:25   DEEPSEEK_API_KEY
    → 删掉行首的 # 即可生效。
```

> `.env` 会被 `tsx watch --include .env` 监听，改完 Key **保存即自动重启**服务端。
> 但要注意：**如果服务端在你填 Key 之前就已经启动**，它会一直用启动时读到的配置——
> 即使自检已经通过，界面里仍会回「本地回退回复（模型 X 尚未配置 API Key）」。
> 这时重启一次即可（或随便保存一个 `apps/server/src` 下的文件触发重载）。

**怎么一眼确认后端到底有没有读到 Key**：

| 位置 | 看到什么 | 含义 |
| --- | --- | --- |
| 终端（服务端启动日志） | `已读取配置文件：…/apps/server/.env` | 读到了哪个文件 |
| 终端（服务端启动日志） | `已配置真实厂商：DeepSeek, Qwen` | 真的生效了 |
| 界面顶栏徽标 | `真实模型 · deepseek/qwen` | 前端也已连上真实模型 |
| 界面顶栏徽标 | `后端已连 · 无 Key` | 后端在线但没读到 Key → 重启后端 |
| 模型回复内容 | 以「本地回退回复…」开头 | 该模型没配置，回复由本地引擎生成 |

**端口冲突提醒**：`npm run dev` 会同时占用 5273 与 8787。如果这两个端口已被之前的进程占着，
新进程会报 `EADDRINUSE` 并且**旧进程继续提供旧配置**——看起来就像"改了配置没生效"。先停掉旧的：

```bash
pkill -f "tsx watch" ; pkill -f "vite --port 5273"
npm run dev
```

`npm run check:models` 成功时输出形如：

```
✓ DeepSeek           已配置 · 2 个模型
    ✓ deepseek-chat                812ms  "OK"
✓ Qwen (DashScope)   已配置 · 2 个模型
    ✓ qwen-plus                    641ms  "OK"
```

| 厂商 | 必填 | 默认接入地址 | 默认模型 |
| --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` | `deepseek-chat`、`deepseek-reasoner`、`deepseek-flash`(视觉) |
| Qwen（百炼） | `QWEN_API_KEY`（等价 `DASHSCOPE_API_KEY`） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`、`qwen-max`、`qwen-vl-max`(视觉) |
| Kimi（Moonshot） | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` | `kimi-k2.6`(视觉)、`kimi-k3`(1M 上下文·旗舰) |

加了 Kimi 就多一个 `@kimi-k3`：100 万 token 上下文 + 原生视觉，可以直接看 PDF 页面图
（在 `@` 菜单里带「可看图」标记）。

> **模型的"生命周期"是真的**：`kimi-k2` 系列 2026-05-25 下线、`moonshot-v1` 系列 2026-08-31 下线。
> 平台把默认模型名写死在代码里，所以厂商一改名字，默认值就会过期。三条防线：
>
> 1. `npm run check:models` —— 真的打一次请求，把"模型不存在""参数不被接受""限流"分开报出来；
> 2. `npm run check:models -- --discover` —— 直接问厂商 `GET /models`，列出**你这个账号**真实可用的模型
>    （文档上写着可用、账号里却没有权限是常态，实测撞到过 `Not found the model kimi-k3 or Permission denied`）；
> 3. 所有厂商都支持 `<PROVIDER>_MODELS` 覆盖，不需要改代码。
>
> 注意 `/models` **通常不列别名**（DeepSeek 不列 `deepseek-chat`，但它能正常调用），
> 所以它只用来"发现新名字"，确认某个名字能不能用仍然要靠 `check:models` 实测。
>
> 另外厂商的**限流差异很大**：Kimi 新账号实测只有 3 请求/分钟，放进 `@all` 会立刻 429——
> 这类模型适合单独 @ 使用。

**三个容易踩的坑**（都已写进 `.env.example`）：

1. **模型名一律可用 `<厂商>_MODELS` 覆盖**，例如 `QWEN_MODELS=qwen3.8-max`。这是最要紧的一条——厂商改模型名、或账号只开通了部分模型时，写错名字会**静默降级到本地回退**，UI 上看起来"配好了"却拿不到真模型回复。覆盖后的模型会同步出现在前端阵容里。
2. **百炼的 Key 与地域绑定**：北京的 Key 调新加坡端点会返回 401 `invalid_api_key`，这不代表 Key 无效。用 `QWEN_BASE_URL` 指向 Key 所属地域的端点。
3. **百炼兼容模式只有 `messages[0]` 允许 system 角色**——本平台的上下文序列化已符合该约束。

另外 `deepseek-reasoner`（R1）的推理过程走 `delta.reasoning_content`，平台只取最终 `delta.content`，因此 R1 的思维链不会显示在群聊里（这是刻意的：群聊里展示的是结论）。

### 不想花 Key 也想验证接入链路？

仓库自带一个本地假厂商，实现 OpenAI 兼容协议（含 SSE 流式），可当任意厂商的替身：

```bash
node scripts/fake-provider.mjs --port 18899        # 终端 1

DEEPSEEK_API_KEY=fake DEEPSEEK_BASE_URL=http://127.0.0.1:18899/v1 \
QWEN_API_KEY=fake     QWEN_BASE_URL=http://127.0.0.1:18899/v1 \
npm run check:models -- --all                       # 终端 2：应全部 ✓
```

把同样两个环境变量交给 `npm run dev:server`，界面上就会走完整 HTTP 路径——顶栏显示「真实模型 · deepseek/qwen」，
且假厂商返回的 ```latex 围栏能被解析成可应用的 diff。这说明换真 Key 只是换 base URL 的事。

---

## 2. 目录结构

按"业务能力"分包，依赖单向向下（`apps → packages → packages/core`）：

```
dsh-demo/
├── apps/
│   ├── web/            # Vite + React + TS：编辑器 / PDF / 群聊（UI 单体）
│   └── server/         # Fastify BFF：SSE 编排、API Key 保管、会话历史
├── packages/
│   ├── core/           # ★ 领域模型 + 纯算法（diff 引擎、@提及路由、文本变换）
│   ├── llm/            # 多厂商网关（OpenAI 兼容 / Anthropic / Gemini / Mock）
│   ├── agents/         # 多 Agent 编排（路由、角色、上下文序列化、提议解析）
│   ├── context/        # 共享知识（BibTeX、术语表、图表、BM25 检索）
│   ├── latex/          # LaTeX 编译抽象 + MockCompiler（浏览器端真 PDF）
│   └── ui/             # 设计系统（无业务逻辑的展示组件）
├── services/
│   └── latex-compiler/ # P3：Tectonic 编译沙箱（接口已约定，见其 README）
├── docs/ARCHITECTURE.md
├── scripts/            # verify-ui.sh（真实浏览器冒烟测试）
├── tests/              # node:test 单测（19 个）
└── infra/              # docker-compose / Dockerfile
```

完整设计说明、依赖方向、SSE 事件契约与演进路线见 **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**。

---

## 3. 核心交互链路

```
① 编辑器选中一段 LaTeX
      ↓（选区快照写入 store，浮动工具栏出现）
② 点「压缩 / 润色 / 改写 / 扩写 / 评审」或自己 @ 模型
      ↓
③ 编排器解析 @提及 → 分配角色 → 并发扇出
   ├─ 撰写者  → 输出 ```latex 替换块
   ├─ 审稿人  → 具体到句子的意见（含术语冲突、缺引用）
   ├─ 方法学家→ 符号一致性 / 假设是否显式
   └─ 编辑    → 汇总并给出采纳建议
      ↓（SSE 事件流：message.start / delta / proposal / end）
④ 第二轮交叉评审：让 B 批判性审阅 A 的产出
      ↓
⑤ 前端把「原文 vs 替换」算成 DiffHunk，渲染成可逐块裁决的卡片
      ↓
⑥ 你勾选要接受的 hunk → 写回编辑器（版本号校验，过期则拒绝应用）
```

**产品红线**：模型永远不能直接改你的论文。它只能提交 `EditProposal`，第 ⑥ 步是唯一的写入口。

---

## 4. 验证状态

```bash
npm test          # 33 个测试，分三层（见下表）
npm run typecheck # 前后端全量类型检查（strict + noUncheckedIndexedAccess）
npm run build     # 生产构建
npm run verify:ui # 真实 Chromium 端到端冒烟测试（见下）
```

| 测试文件 | 覆盖 | 数量 |
| --- | --- | --- |
| `tests/core.test.ts` | diff 引擎（含部分接受 / 增删行 / 重新折行）、@提及路由、BibTeX 括号配对、术语一致性、BM25、提议解析与回声过滤、MockCompiler | 19 |
| `tests/providers.test.ts` | **多厂商网关协议**：用本地 HTTP server 复刻 OpenAI / Anthropic / Gemini 的流式响应，校验 URL/头/body、跨 chunk 半行 JSON 拼接、用量解析、错误映射、未配置降级 | 7 |
| `tests/server.test.ts` | **服务端 HTTP 契约**：临时端口真实启动 Fastify，走 fetch 验证 SSE 事件序列与 CORS 头、diff 产出、无变化不产出 diff、400 校验、编译缓存与锚点、会话历史 | 7 |

> `tests/providers.test.ts` 是"接上真 Key 就能用"这句话唯一的证据来源——本地没有也不该有真实 Key，
> 因此用精确复刻的厂商协议来兜住适配器。`tests/server.test.ts` 挡住的正是开发中踩过的两个坑：
> hijack 之后 CORS 头丢失、以及 `/api/compile` 漏返回 anchors（导致后端编译模式下点击定位无效）。

`npm run verify:ui` 会在真实浏览器里跑完整链路并在 `artifacts/` 留下截图：
选中段落 → 浮动工具栏 → 群聊并发流式 → diff 卡片 → 应用回编辑器 → @提及补全 → 共享知识面板。

已实测通过（11/11 步，控制台零错误）：

- 浏览器内 Mock 模式：`VERIFY_TAG=mock bash scripts/verify-ui.sh http://127.0.0.1:5273`
- 真实后端 SSE 模式：`VERIFY_TAG=live bash scripts/verify-ui.sh http://127.0.0.1:5274`

> 首次运行 `verify:ui` 需要下载 Chromium：`npx playwright install chromium`。
> 无图形环境的容器里还需要 `libnspr4 / libnss3 / libasound2` 与中文字体——
> `scripts/verify-ui.sh` 会自动从 `.playwright/sysroot` 加载（见脚本内注释的获取方式）。

---

## 5. 已知限制（原型阶段的诚实清单）

| 限制 | 现状 | 计划 |
| --- | --- | --- |
| **LaTeX 编译** | ✅ 已接入 **Tectonic**（真 TeX 排版，基于 XeLaTeX，中英文同一引擎）。未安装二进制时回退到 `MockCompiler` 近似排版 | 远端 TeX Live 服务（支持 pdflatex/lualatex） |
| **源码 ↔ PDF 定位** | ⚠️ 真引擎下暂无锚点（需解析 SyncTeX），"改动后自动跳页高亮"只在近似排版时可用 | 解析 `tectonic --synctex` 输出 |
| **持久化** | 服务端会话历史在内存；刷新页面即重置 | P5 接 SQLite/Postgres，`SessionStore` 接口已预留 |
| **协同编辑** | 无 CRDT，单人对单文档 | P5 接 Yjs |
| **多项目** | ✅ 已支持并列多项目（新建 / 导入 zip / 重命名 / 删除 / 切换），隔离文件、编译、共享知识与对话历史 | 项目级协作者与权限 |
| **本地回退质量** | 无 Key 时的改写是确定性文本变换（删填充词 + 合并段内硬换行），不做语义改写；**不会伪造不存在的结论** | 配 Key 即由真实模型接管 |
| **检索** | BM25 关键词检索 | P4 混合检索（向量 + 重排） |
| **Vite 长时间运行** | 大量改动后偶发 `Invalid hook call`，属 monorepo 依赖预打包缓存问题 | 重启 `dev:web` 即可；已记录 |

---

## 6. 在 WSL2 + VS Code 下开发

项目必须放在 **WSL 的 Linux 文件系统里**（本仓库在 `/dev/sdd`，即 WSL2 的 ext4 虚拟盘），
不要在 `/mnt/c/...` 下开发：跨文件系统会让 Vite / tsx 的文件监听变慢甚至漏事件，热更新会失灵。

### 推荐方式：VS Code 的 WSL 远程（唯一正确的做法）

```bash
# 在 WSL 终端里（不是 PowerShell）
cd ~/paperflow
code .
```

Windows 侧 VS Code 会连上 WSL、装好 `~/.vscode-server`，左下角显示 **WSL: Ubuntu**。
此后：编辑、Git、终端、扩展全部在 Linux 侧运行，inotify 事件可靠，HMR 与 `tsx watch` 正常工作。

首次打开时 VS Code 会提示安装 `.vscode/extensions.json` 里推荐的扩展（其中 WSL 扩展是必需的）。

### 不推荐方式：`\\wsl.localhost\Ubuntu\home\...`

用 UNC 路径从 Windows 侧直接打开也能编辑，但：
- 文件读写走 9p 网络协议，`npm install` / 构建会明显变慢；
- **Windows 侧的 VS Code 改文件时，WSL 内的 inotify 不一定收到事件** → Vite HMR 卡住、`tsx watch` 不重启；
- 更容易出现行尾（CRLF）与权限位（755）漂移。

代价是每次都要手动重启服务。用 WSL 远程则没有这些问题。

### 行尾已经被强制统一为 LF

`.gitattributes`（git 落盘）+ `.editorconfig` / `.vscode/settings.json`（编辑器写入）三层保证源码始终是 LF。
这不是洁癖：解析管线里有若干以 `$` 锚定行尾的正则（例如剥离 LaTeX 注释），
JS 里不带 `m` 标志的 `$` 只匹配输入末尾，CRLF 会让这类正则**静默失效**——
曾经就因此把注释里的花括号判成"括号未闭合"。`tests/eol.test.ts` 现在把这条钉死了。

### 常用操作

| 操作 | 位置 |
| --- | --- |
| 开终端 | VS Code 里 `` Ctrl+` ``（已在 WSL 侧，直接 `npm run dev`） |
| 跑测试 | 终端 `npm test`，或调试面板 |
| 看端口 | VS Code「端口」面板会列出 5273 / 8787，可一键在 Windows 浏览器打开 |
| 浏览器访问 | Windows 浏览器直接开 `http://127.0.0.1:5273`（WSL2 会转发 localhost） |

---

## 7. 演进路线

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 目录骨架、领域契约、架构文档 | ✅ |
| P1 | UI 雏形（三栏布局 / Monaco / PDF / 群聊 / diff） | ✅ |
| P2 | 多 Agent 编排（多厂商网关 / @路由 / 角色 / 交叉评审 / SSE） | ✅ |
| P3 | 真实 LaTeX 编译 + SyncTeX 双向定位 | ⏳ |
| P4 | 共享知识底座（混合检索、术语一致性自动校验、引用审计） | 部分（BM25 + 术语 + 引用审计已可用） |
| P5 | 持久化、多项目、多人实时协作（CRDT）、导出 | ⏳ |

---

## 8. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动 web(5273) + server(8787) |
| `npm run dev:web` / `npm run dev:server` | 单独启动 |
| `npm test` | 四层测试（算法 / 厂商协议 / 服务端契约 / 行尾鲁棒性） |
| `npm run check:models` | 厂商连通性自检（真实请求，逐模型报告）；`-- --all` 测全部模型 |
| `node scripts/fake-provider.mjs` | 本地假厂商（OpenAI 兼容），零成本验证真实接入链路 |
| `node scripts/probe-chat.mjs [url] [消息]` | 真实浏览器里发一条消息并打印回复，用于排查"发了但没回复" |

### 让模型读到"完整"论文 & 直接看 PDF

**资料长度**：不再固定截断。每份资料能发多少由**目标模型的上下文窗口**决定
（预算 = 窗口 × 50% × 2.5 字符/token，其余留给系统提示、历史、论文与输出）。
能全发就全发，并在提示词里明确告诉模型"以下均为全文"，避免它推说"内容不全"；
发不下才截断，且要求模型说明"我需要哪一段"而不是笼统抱怨。
实测：39,302 字的资料，关键信息埋在 **99% 位置**，`deepseek-chat`（64K 窗口）能准确答出。

**直接看图（不用 OCR）**：上传 PDF 时会在浏览器端额外把前 8 页渲染成 JPEG
（`MAX_RENDERED_PAGES`，图像 token 很贵，必须限流），随资料一起保存。
**只有声明了 `vision` 能力的模型会收到这些页面图像**，纯文本模型只拿到提取的文字——
发错会被上游拒绝，所以发送前会按模型能力过滤。

| 厂商 | PDF 直接输入 | 图片输入 | 说明 |
| --- | --- | --- | --- |
| DeepSeek | ❌ | ✅ 仅 `deepseek-flash` | 图片只能放在 user 消息里（system/assistant 里的图片会 400） |
| Qwen | ❌ | ✅ `qwen-vl-*` | 兼容模式走 `image_url` |
| Gemini | ✅ 原生 | ✅ | 也支持 `inlineData` 传页面图像 |
| Claude | ✅ 原生 | ✅ | `image` block / `document` block |

`@` 菜单里带「**可看图**」标记的模型才能读页面图像；资料列表也会提示该 @ 谁。
本项目统一采用"PDF → 页面图像"这一条路径，因为四家都支持图片，而只有两家支持原生 PDF。

### 界面要点

**编辑器标签栏**（VS Code 式）：只显示**你打开过的文件**，每个标签带关闭按钮，
标签多了横向滚动而不是换行挤压，最右侧有「全部关闭」。
主文档标签带一个「主」标记。

> 早先的实现在顶栏直接把**项目里的每个文件**渲染成标签：ICRA 项目有 22 个文件（15 张图），
> 顶栏瞬间被铺满而且关不掉。现在的模型是显式的"已打开文件列表"，
> 切项目时只保留主文档一个标签。

**工作区布局**（顶栏右侧切换，图标与布局一一对应）：

| 选项 | 图标 | 布局 |
| --- | --- | --- |
| 仅编辑器 | FileCode2 | 只显示编辑器 |
| 上下分栏 | Rows3 | 编辑器在上，PDF 在下 |
| 左右分栏 | Columns3 | 编辑器在左，PDF 在右（同 Overleaf） |
| 仅 PDF | FileText | 只显示 PDF |

> 之前只有"编辑器 / split / 仅 PDF"三项，而"仅 PDF"用的是 Columns3（竖排列）图标，
> 看起来就像"竖排/横排按钮反了"。现在两种分栏方向都真正实现了。

**PDF 阅读方式（与 Overleaf 对齐）**：

| 交互 | 行为 |
| --- | --- |
| **滚轮上下滚动** | 所有页在同一个滚动容器里纵向排列，滚动时页码自动跟随 |
| 翻页按钮 | 语义是"平滑滚到该页"，不是切换单页 |
| **在 PDF 里选中文字 → 双击** | 编辑器**跳到那个词并选中它**（单词级：`行:列`），同时高亮该词 |
| 懒渲染 | 只渲染"当前页 ±1"，其余先占位——带十几张大图的论文一次全渲染会很慢 |

定位的实现方式：**不用 SyncTeX，而是文本匹配**（`findTextInSource`）。
PDF 里的正文文字与 `.tex` 源码通常逐字对应，所以直接找就够了，而且能顺手处理几种现实差异：

- PDF 提取的文字里行内换行变成空格、还可能有多余空白 → 两边都做空白归一化，匹配时空白用 `\s+`；
- TeX 会把 `--`/`---` 排成 en/em dash、把引号排成弯引号 → 反向映射回 ASCII；
- 一句话中间夹了公式或 `\cite{}` 导致整句匹配不上 → **逐步截短前缀**（最多退到前 3 个词），
  至少跳到这句话的开头，而不是"什么都没找到"；
- 找不到时界面会**明说**"在源码里没找到这段文字"，不静默失败。

想按 `\input` 拆分的项目也能用：先查主文档，再查其它 `.tex`。

> ### SyncTeX（实验特性，默认关闭）
>
> `tectonic --synctex` 的产出已经接入：服务端解析成索引按项目缓存，
> 提供 `POST /api/projects/:id/locate {page,x,y,pageHeight}`，
> 前端双击时会把点击位置换算成 PDF 坐标（bp，原点左下）发过去。
> 打开方式：`VITE_SYNCTEX=1 npm run dev:web`。
>
> **为什么默认关闭**：当前的记录选择规则（"包含该点的最内层框"）在有浮动图的版面上
> 会命中 figure 的框，给出错误的行号——实测点标题区返回 figure 内部的行号。
> 往返自洽测试是 86.2% 同行 / 89.9% 差 1 行以内，但这掩盖不了实况的错误：
> **判定标准必须是"实况坐标扫描 vs 已知 landmark 行号"**（`\maketitle`=30、
> `\end{abstract}`=36、`\caption`=50），而不是只看自己和自己一致。
>
> 下一步修法：实现真正的 **box 栈遍历**（`[`/`(` 压栈、`]`/`)` 出栈，取包含该点的栈顶），
> 而不是"文件顺序最后出现"这个近似。

**取词完全由自己完成，不依赖浏览器选区**。这是排查出来的关键：

- **不是 OCR 问题**——Tectonic 输出的 PDF 内嵌字体与字符编码，文字是精确的；
- 真正的原因是 **pdf.js 文本层的 span 粒度是混的、而且会重叠**：同一行既有整行 span
  （含整行文字），又有逐词 span。浏览器按 DOM 文本节点选词时就可能落到相邻/重叠的
  另一个 span 上（实测：双击 `wrench` 却取到 `the`）。
- 所以现在按坐标自己取词：找**包含点击点的最小 span**（最具体那层）→ 按横向比例
  映射到字符 → 扩展到词边界；再从同一行的其它 span 收集**左右上下文**。

**同一个词出现多次时靠上下文消歧**：把 PDF 里紧邻的左右文字和源码候选处的前后文比对
（`contextScore`），比"按页码比例猜"可靠得多。实测在同一份文档上双击 8 个词，
抽样核对的 4 次全部命中正确的行（`Abstract`→34、`heuristics`→35、`geometry`→41）。

**精度是到"词"的，不是到"行"**：匹配命中后会把字符偏移换算成 `(行, 列)`
（`positionAtOffset`），编辑器据此 `setSelection` 选中那个词并居中显示——
这样"PDF 里选的词"和"代码里的词"一眼能对上。若只给行号，用户会觉得"跳得不准"。

**同一个词出现多次怎么办**：只取第一处会让人感觉跳错了地方。所以双击时会带上
"点击处占全文的比例"，在**所有出现位置**里挑最接近的一处（`findTextInSource` 的 `ratio` 选项）。
实测 `normalized` 出现两次时，点末尾命中最后一次、点开头命中第一次。

> **一个必须写清楚的契约**：`highlightRange` 的单位是**行号（1 起，闭区间）**，不是字符偏移。
> 这里踩过坑——定位时把字符偏移（≈1500）写了进去，而 Monaco 的 `startLineNumber` 与
> PDF 锚点的 `anchor.line` 都按行号解释，于是"第 1500 行"超出了文件行数：
> **状态栏显示的行号是对的，视图却跳到了文件末尾**。现在字段名就叫 `startLine` / `endLine`，
> 类型层面就能挡住这类误用。

**PDF 工具栏是响应式的**（用 Tailwind v4 的容器查询 `@container`）：

| 面板宽度 | 表现 |
| --- | --- |
| ≥ 300px | 完整：页码 + 缩放 + 引擎下拉 + 编译 |
| 190–300px | 收起缩放控件（需要时再拉宽面板） |
| < 190px | 只留页码 |
| 任意宽度 | **永不截断**：内容放不下就整组换到下一行（`flex-wrap` + 分组 `shrink-0`） |

> 这里踩过一个典型的响应式坑：工具栏原来是单行不换行的 `flex h-9`，
> 而右侧内容（页码+缩放+四段引擎选择+重新编译+主文档提示）需要约 760px。
> 切到左右分栏后面板只有 336px，于是**溢出 424px**、"重新编译"被截成"重新"。
> 修法是三件事：允许换行、把每组拆成可独立断行的兄弟节点、把宽控件（四段引擎选择）
> 换成紧凑下拉框。实测 1120/1280/1400px 三种宽度下均无溢出。
>
> 另外"主文档提示"从工具栏移到了独立的一条琥珀色提示行——
> 它是信息而不是操作，挤在工具栏里只会让窄面板更窄；只在"正在编辑的文件不是主文档"时出现。

**引擎徽标显示服务端真实引擎**：早先显示的是客户端传输层包装器的名字（`http`），
现在由服务端在编译响应里回传真实引擎（`tectonic` / `mock`）。

## 重启电脑后怎么继续

### 0. 打开 WSL

Windows 终端里执行 `wsl`（或 `wsl -d Ubuntu`）；也可以在 Win+R 里输入 `wsl`。
验证：`pwd` 应能进到 `~/paperflow`。

### 1. 终端 A —— 启动 DSH（和我们对话的这个界面）

```bash
cd ~/paperflow
npx @deepseek-ai/dsh@0.1.5-rc.2 web     # 等价于 --profile web
```

然后打开 <http://127.0.0.1:3080>，在会话列表里选回原来的对话即可。

> **会话是持久化的**：按工作区存档在 `~/.dsh/sessions/--home-fire-projects-dsh-demo--/`
> （每个会话是一个 `session.v3.jsonl.zstd`），所以重启不会丢对话历史。
> `dsh` 没有全局安装，用 npx 跑；包已在 npx 缓存里，不会重新下载。

### 2. 终端 B —— 启动 PaperFlow 应用

```bash
cd ~/paperflow
npm run dev
```

打开 <http://127.0.0.1:5273>。

> ⚠️ **两个地址是不同的东西**：
> `3080` = DSH 界面（你和 AI 协作的地方）；`5273` = 你正在开发的 PaperFlow 应用。

### 3. VS Code（可选）

在项目目录里执行 `code .`（WSL 扩展已装好），`.vscode/` 里的设置会生效。

---

## 导入自己的大项目（毕设那种几百 MB 的）

### 为什么直接上传 zip 会失败

一个真实毕设项目的构成（实测 815 MB）：

| 内容 | 大小 | 该不该进项目 |
| --- | --- | --- |
| `images/*.mp4` 演示视频 | 196 MB | ❌ LaTeX 无法嵌入视频 |
| `sztuthesis_main.pdf` 编译产物 | 153 MB | ❌ 会被自动重新生成 |
| 高分辨率插图 png | ~270 MB | ✅ 要 |
| 中文字体 ttf | 52 MB | ✅ 要（模板靠它编译） |
| `.aux/.log/.xdv/.synctex.gz` | ~2 MB | ❌ 中间文件 |

上传接口有 256 MB 的 body 上限，815 MB 的包会被 **413** 直接拒绝——
这就是"导入失败"的原因。**不要为了绕开它去裁剪 zip**，用下面的方式。

### 正确做法：从磁盘路径导入（不经过上传）

服务端和你的项目在同一台机器上（WSL 里 `/mnt/f/...` 就是 Windows 的 F 盘），
所以直接让它读盘，没有大小上限、也不占内存：

1. 点左上角的项目切换器 → 底部输入框
2. 粘贴路径，例如
   ```
   /mnt/f/LaTeX_Paper_Folder/SZTU_Thesis_LaTeX_Template
   ```
3. 点「从磁盘导入」（**目录或 .zip 都行**）

导入时会**自动跳过**编译产物、中间文件和视频（并在通知里报出跳过了多少个），
主文档自动识别（认 `\documentclass` + `\begin{document}`，不是按文件名排序）。

### 中文毕设模板常缺字体

这类模板通常写死 Windows 字体：

```latex
\setmainfont{Times New Roman}
\setsansfont{Arial}
\setmonofont{Courier New}
```

WSL 默认没有这些字体，编译会报
`! Package fontspec Error: The font "Times New Roman" cannot be found.`

一条命令装好（只从你自己的 Windows 目录复制到 Tectonic 的用户字体目录，不需要 sudo）：

```bash
bash scripts/install-windows-fonts.sh
```

装完 Tectonic 就会自动用上（`XDG_DATA_HOME` 指向 `.tectonic/home/.local/share`）。

### 大 PDF 不再走 JSON

编译产物可能几百 MB，早先把它 base64 塞进 JSON 会超过 V8 字符串上限，
接口直接 500 `Invalid string length`。现在 PDF **落盘**，响应只给 URL
（`GET /api/projects/:id/pdf`），前端交给 pdf.js 直接取。

## 团队模式（多用户协作）

面向"课题组内部私有部署"，鉴权刻意做得很轻：**邀请链接 → 申请 → 发起方审批**，没有邮箱和密码。

### 启动

```bash
AUTH_MODE=team PROJECTS_ROOT=/data npm run dev
```

- `AUTH_MODE=team`：除健康检查与鉴权接口外，所有 `/api` 都要带会话；不设置则保持原来的单机模式
- `PROJECTS_ROOT`：项目与团队数据的落盘位置（容器里挂卷，默认是仓库下的 `.paperflow`）

首次启动（还没有 owner）会生成一条**认领链接**，打印在控制台并写入 `<PROJECTS_ROOT>/team/OWNER-LINK.txt`：

```
/join/xxxxx            → 用浏览器打开 http://<你的地址>/join/xxxxx
```

填名字后即成为发起方。之后：

1. 点右上角「团队」→「生成邀请链接」（自动复制）
2. 把链接发给组员
3. 组员打开后填名字 → 出现在你的「待审批」里（面板每 4 秒自动刷新）
4. 点「同意」→ 对方页面**自动进入工作区**，无需刷新

### 设计要点

- 会话：HttpOnly Cookie（`pf_session`，30 天），服务端存 `team/team.json`
- 角色：目前实现 `owner / editor / commenter / viewer` 四种，审批时可指定
- 一次性链接：owner 认领链接 `maxUses = 1`，用过即失效
- 越权防护在**服务端**：伪造 cookie、非 owner 审批、撤销后的邀请都会被拒（有 16 条 e2e 覆盖）

> ⚠️ 当前是 P0：**还没有实时协同编辑**。多人同时改同一个文件仍会互相覆盖，
> 多光标 / 划词批注 / 历史版本在下一阶段（Yjs + CRDT）。

### 相关测试

```bash
node --import tsx tests/auth-e2e.mts        # 16 条：认领/邀请/审批/越权
node --import tsx tests/team-ui.e2e.mts     # 17 条：需要先起一个 Vite 到 5289（代理到 8801）
```

## 项目状态：什么保留、什么要重建

**一条命令**：

```bash
cd ~/paperflow
npm run dev          # 同时起 web(5273) 与 api(8787)
```

然后打开 <http://127.0.0.1:5273> —— 项目会自动载入并**自动编译一次**，不需要手动恢复任何东西。

> 如果提示端口被占用（上次的进程没退干净）：`pkill -f "tsx watch"; pkill -f "vite --port"` 再启动。

### 什么会自动保留（在磁盘上）

| 内容 | 位置 |
| --- | --- |
| **项目文件**（ICRA / RAL / IROS …） | `.paperflow/projects/<id>/` —— 真实文件，TeX 引擎直接读它 |
| 项目列表与主文档设置 | `.paperflow/projects.json` + 各项目内的 `.paperflow-root` |
| **对话记录** | `.paperflow/sessions.json` |
| **共享知识**（文献 / 术语 / 参考资料） | `.paperflow/context.json` |
| **API Key** | `apps/server/.env` |
| TeX 引擎与宏包 | `.tectonic/`（约 59 MB，缓存命中时**离线也能编译**） |

> **要备份就备份 `.paperflow/`**——你的论文、对话、资料全在里面。
> 它已被 `.gitignore` 排除（不会误传到 git），所以**换机器时要手动拷**。

### 什么需要重新生成（只在内存里）

| 内容 | 影响 | 怎么恢复 |
| --- | --- | --- |
| 编译缓存、**编译产物的 PDF 全文** | agent 的【论文正文（编译产物提取）】块 | 打开页面会自动编译一次，即恢复 |
| **SyncTeX 索引** | `VITE_SYNCTEX=1` 时的精确坐标定位 | 同上（编译时重新解析） |
| 浏览器里的 PDF blob | 预览 | 同上 |

也就是说：**打开页面那次自动编译，就把重启丢掉的东西全补回来了**，你不用做额外操作。

### 多项目并列（ICRA / RAL / IROS …）

顶部左侧的项目切换器管理多个**完全独立**的论文项目。隔离边界：

| 维度 | 隔离方式 |
| --- | --- |
| 文件 | 各自落在 `.paperflow/projects/<id>/`，互不可见 |
| 编译 | 编译请求带项目 id（`POST /api/projects/:id/compile`），只读该项目的文件 |
| 共享知识 | 文献 / 术语 / 参考资料按项目 id 分开存（`?project=<id>`） |
| 对话历史 | 线程 id 就是项目 id，换项目就是另一条独立会话 |

**上传上限与传输方式**：zip 与图片走**原始字节**上传（`Content-Type: application/zip` /
`application/octet-stream`），不做 base64。这不是优化而是必需——base64 会让体积膨胀 33%，
真实 Overleaf 项目（带图）很容易因此撞上 HTTP body 上限：

| 项 | 值 |
| --- | --- |
| 单次上传上限 | **256 MB**（`MAX_UPLOAD_BYTES`，可改） |
| 单个文件上限 | 64 MB |
| 单个项目上限 | 200 MB |
| 传输方式 | 原始字节（zip/图片）；文本仍走 JSON 便于校验 |

> 早先的实现把 zip base64 塞进 JSON，而 `bodyLimit` 只有 8MB：一个 12MB 的 zip 编码后是
> 16MB，请求被直接掐断（broken pipe），界面只能笼统显示"上传失败"。
> 现在错误信息会说明**文件多大、超过什么上限**。

新建项目有两种方式：

- **新建空项目** —— 用演示论文做种子，可以立刻编译出东西；
- **导入 zip 为新项目** —— 这就是"把一个 Overleaf 打包的 IROS 论文拖进来，项目管理里就多一个并列项目"。

> **新项目的共享知识从空开始**：早先的实现让每个新项目都继承演示论文的文献库，
> 于是一个全新的论文项目里冒出一堆不相干的参考文献——现在只有种子项目带演示数据。

### 主文档（编译入口）怎么定

对应 Overleaf 的 "Set as main document"。优先级：

1. **你手动指定的**（文件树里 `.tex` 行的 ⭐）——存在项目内的 `.paperflow-root`；
2. **智能推断**：优先含 `\documentclass` + `\begin{document}` 的完整文档，
   再优先名字像主文档的（main / root / paper / manuscript），再优先顶层路径。

> **为什么不能"按字母序取第一个 .tex"**：实测踩过——用户的 ICRA 包里同时有 `main.tex`
> 与 `root.tex`，字母序选中了 `main.tex`，编译报 `ieeeconf.cls not found`，
> 而用户完全不知道自己"编译错了文件"。

界面在 PDF 工具栏显示**当前主文档**；当你正在编辑的 `.tex` 不是主文档时，会高亮并出现
「改为编译当前文件」按钮——避免"我在看 A、编译的却是 B"这种最难排查的情况。

### 在子目录里添加文件 / 上传

对应 Overleaf 里"往 figures/ 里单独加图"：

- **点一下文件夹行** → 把它设为「新建/上传的目标目录」（顶部会出现提示条，可一键取消）；
- 文件夹行悬停 → **新建文件到这里** / **上传到这里** / 删除；
- **把文件拖到文件夹行上** → 直接上传到该文件夹里（拖到别处则进项目根）。

### 编辑器里的悬浮预览（对齐 Overleaf）

把鼠标停在编辑器里的这几类内容上会弹出预览：

| 光标位置 | 悬浮内容 | 状态 |
| --- | --- | --- |
| `\cite{key}` | .bib 里该条目的**标题 / 作者 / 期刊 / 年份** | ✅ 实测 |
| `\includegraphics{figures/x.png}` | 项目里那张图的**缩略图**（PDF 图渲染第一页） | ✅ 实测 |
| **跨行公式环境**（`equation`/`align`/`gather`…） | 整条公式，KaTeX 排版（分数线、上下限、花体、粗体向量都对） | ✅ 实测截图确认 |
| 公式里的普通位置（`$…$`、`\(…\)`、`\[…\]`、`$$…$$`） | 整条公式 | ✅ 面板内 KaTeX 排版 |
| **表格**（`tabular`） | 三线表渲染成真正的行列 + caption 作标题 + **单元格内的公式也渲染**（`$\lambda = 0.95$` → λ = 0.95、`$1 \times 10^{-3}$` → 1 × 10⁻³） | ✅ 实测截图确认 |
| `\ref{sec:…}` / `\ref{fig:…}` / `\ref{tab:…}` | 解析到 `\label{}`，显示「小节/图/表：标题（第 N 行）」 | ✅ 实测 |
| `\ref{}` 的**跳转** | Ctrl/⌘+点击（或 F12）跳到 `\label{}` 所在行 | ✅ 已注册 definition provider |
| 带参数/上下标的符号（`\bar{a}_t^{\,k}`、`\mathbf{d}`） | 该符号（**参数与上下标一起渲染**） | ✅ 单测覆盖 |
| 光标正落在符号命令上（`\alpha_T`） | 该符号 + 它的源码 | ✅ 实测（截图确认渲染成 ⋅ 这类真实数学符号） |

**实现方式：自己的 React 悬浮面板，而不是 Monaco 的 hover provider。**

第一版用的是 Monaco 的 `registerHoverProvider`，结果两个功能都坏了，原因是 Monaco 的悬浮内容
必须走它的 markdown 渲染器：

- **公式**：KaTeX 产出的 HTML/CSS 会被过滤掉（即使设了 `isTrusted: true` + `supportHtml: true`，
  悬浮框里也没有 `.katex` 元素），分数、根号、上下标的位置全丢，只剩扁平文字 —— 用户看到的就是"公式渲染错误"；
- **图片**：markdown 的 `![](data:…)` 语法**根本不被解析**，Monaco 把它原样当文字输出
  （dump 出来就是 `<p>![alt](data:image/png;base64,…)</p>`），于是所有图片的悬浮栏长得一模一样。

面板 DOM 由我们自己控制，KaTeX 能真正排版、图片能直接 `src`、PDF 图还能当场渲染第一页。
实测：图片显示为 3888×1819 的缩略图，符号渲染成真实数学字形（截图确认）。

实现要点：

- **公式与符号用 KaTeX 真渲染**，不是显示源码——作者关心的是"排出来什么样"；
- **`\(…\)` 必须支持**：模型生成的 LaTeX 里大量使用这种行内公式写法；
- **优先级是有意的**：先判带参数的命令（cite/ref/includegraphics）→ 再判"光标是否正落在符号命令上"
  → 最后才判数学环境。所以点在 `\alpha_T` 上是**预览这个符号**，点在公式的其它位置才是**整条公式**；
- **BibTeX 解析要按花括号计数**：标题里常有 `{IEEE}`、`\emph{...}`，用正则会截断；
- 图片按需从服务端取（项目清单里只有元信息），PDF 图用 pdf.js 渲染第一页。

> **跨行结构必须整块取出**：论文里的公式都写成
> `\begin{equation} … \label{eq:x} … \end{equation}`，单看光标所在那一行既没有 `$` 也没有 `\(`，
> 会被误判成普通符号。所以用**环境栈**从文件头扫到光标，取栈顶（`detectBlockAt`）。
> 另外 `\label{}` 必须在渲染前剥掉——KaTeX 遇到未知命令会直接报错，整条公式就渲染不出来。
>
> **表格单元格必须渲染公式**：论文表格里大量出现 `$\rho_s$ (rad/s)`、`$\lambda = 0.95$`、
> `\uparrow` 这类写法，早先把命令直接剥掉，单元格里就只剩残缺文字（用户看到的"表格里符号渲染错误"）。
> 现在按 `$…$` 切开、公式走 KaTeX、文字部分的常见符号映射成 Unicode（↑ ↓ ≤ ≥ × ± ✓）。
>
> **两个反复踩到的坑，都写进了测试**：
> 1. **正则过度转义**：`/\\(begin|end)\\{/` 在 JS 里要求文本长成 `\begin\{`，
>    于是永远匹配不上。表现是"识别函数对最小样本也返回 undefined"。
> 2. **表格按 `\\` 切分会把 `\toprule` 粘到下一行**：改成按行累积解析后才正确。

### 图片与 PDF 的查看

编辑器是 Monaco（纯文本控件），所以二进制文件按类型分流到查看器：

| 类型 | 表现 |
| --- | --- |
| `.png` / `.jpg` / `.gif` / `.webp` / `.svg` | 直接显示图片（内容按需从服务端拉取，进页面时不会把所有图片塞进内存） |
| `.pdf` | pdf.js 渲染，带分页与缩放（共用编译产物预览的 CMap 配置，中文 PDF 才不会整页空白） |
| `.eps` / 字体 | 如实说明"编译时会用上，但无法预览"，而不是给一张白纸 |

状态栏对二进制文件显示大小而不是 token 估算——把 5MB 图片的 base64 当文本估算会得到
十几万 token 这种毫无意义的数字。

### 项目管理（Overleaf 式文件树）

项目**不是内存里的演示数据**，而是磁盘上 `.paperflow/projects/<id>/` 里的一组真实文件——
TeX 引擎本来就在文件系统上工作，`\input`、`.cls`、`.bib`、`\includegraphics` 都需要真实文件才能解析。

| 操作 | 入口 | 说明 |
| --- | --- | --- |
| 新建文件 / 文件夹 | 文件树顶部按钮 | 路径可含目录（`sections/related.tex`），一次性建多层 |
| 重命名 / 删除 | 每行悬停出现的按钮 | 目录连同内容一起操作 |
| **拖动上传** | 把文件拖到文件树面板 | 支持多选；`.zip` 会被当作**整个项目导入** |
| 导入项目 | 拖入 zip 或用上传按钮选 zip | 等价于 Overleaf 的 Upload Project |
| 下载项目 | 文件树顶部 ⬇ | 导出 zip，等价于 Download → Source |
| 设为主文档 | `.tex` 行的 ⭐ | 编译入口，等价于 "Set as main document" |

**导入 zip 时处理的真实世界细节**（都在测试里钉住了）：

- **剥掉公共顶层目录**：Overleaf 导出常是 `my-paper-1.2/root.tex`。不剥的话主文件会变成
  `my-paper-1.2/root.tex`，`\input{sections/intro}` 立刻找不到文件；
- **必须先过滤垃圾再判断公共前缀**：macOS 打包会塞 `__MACOSX/`，只要它参与判断，
  "公共前缀"就不成立，结果所有文件都多套一层目录；
- **二进制资源按 base64 原样落盘**（图片、`.pdf`、字体），当文本写会损坏；
- **路径穿越防护**：`../` 之类一律拒绝——这是唯一能把文件写出项目目录的地方。

**编辑自动保存**：编辑器改动 800ms 防抖写回服务端，因此刷新页面不丢内容。

**编译时提交整个项目**：`POST /api/compile` 会读取项目里所有文件一起交给编译器，
所以自定义 `.cls`、`\input` 的子文件、`.bib`、图片都能正确解析。
实测：把一个含 `myjournal.cls` + 两个 `\input` 子文件 + TikZ 图 PDF + `ref.bib` 的
Overleaf 式压缩包导入后直接编译成功，双栏排版、表格、公式、中英混排摘要、
参考文献全部正确。

### 为什么页数和 Overleaf 不一样？（字体与中文排版）

从 Overleaf（pdfLaTeX）搬过来的论文，页数常常对不上。本地引擎是 XeTeX，有两个**独立**原因，
都会被静默处理、很难自己发现。项目里现在**自动检测并修复**，并在编译日志里说明改了什么：

**原因一：Type1 字体在 XeTeX 下不存在，静默回退成 Computer Modern**

老牌会议类文件（`ieeeconf`、`IEEEtran`…）写着「IEEE uses Times」，实现是
`\renewcommand{\rmdefault}{ptm}`。这类字体只有 OT1/T1 定义，**XeTeX 下没有 `TUptm.fd`**：

```
LaTeX Font Warning: Font shape `TU/ptm/m/n' undefined
LaTeX Font Warning: Font shape `TU/ptm/bx/n' undefined
LaTeX Font Warning: Font shape `TU/ptm/m/it' undefined
```

每一款字形都找不到 → 整体回退成 **Computer Modern**（比 Times 宽）→ 行数与页数都变。

→ **修复**：自动换成**度量兼容**的 TeX Gyre 字体（Termes=Times、Heros=Helvetica、Cursor=Courier）。
字体来自 Tectonic 自带的 TeX Gyre 系列，行宽与原排版一致。

**原因二：`ctex` 会全局改变行距与缩进**

项目原来在检测到中文时自动加载 `\usepackage[UTF8]{ctex}`。ctex 做的是"完整中文排版"，
会调整全局行距、首行缩进与中西文间距——对一篇只有零星中文的**英文**论文，代价是**页数多 3 页**。

→ **修复**：改用 `xeCJK`（只接管中日韩字符，拉丁文排版完全不受影响），
中文字体用 Tectonic 自带的 Fandol。需要完整中文排版时，作者可自行加载 ctex 并接受页数变化。

**受控实测**（用户真实的 ICRA 论文，Overleaf 上 8 页）：

| 变体 | 页数 |
| --- | --- |
| 只注入 `ctex` | 11 |
| `ctex` + 字体兼容层 | 10 |
| **`xeCJK` + 字体兼容层** | **8** ✅ 与 Overleaf 一致 |
| 只加字体兼容层 | 8 |

> 诊断这两件事的关键是**读 `.log` 文件**：`LaTeX Font Warning` 只写进日志，
> Tectonic 的终端输出里没有。因此编译时必须带 `--keep-logs`（默认会跳过中间文件）。

### 编译引擎与中英文排版

**P3 已完成**：编译走真正的 TeX 引擎，不再是近似排版。

| 引擎 | 状态 | 说明 |
| --- | --- | --- |
| `auto`（默认） | ✅ | 含中日韩字符且文档未加载 CJK 宏包时，自动加入 `\usepackage[UTF8]{ctex}` 并写进编译日志 |
| `xelatex` | ✅ | 本地 Tectonic 基于 XeTeX：**原生 UTF-8 + 系统字体，中英文同一个引擎** |
| `pdflatex` / `lualatex` | ⚠️ | 本地引擎不支持；显式选择时会**明确拒绝并提示**配置 `LATEX_COMPILER_URL` 指向远端 TeX Live，而不是静默用错引擎 |

界面在 PDF 工具栏提供引擎选择（相当于 Overleaf 左上角的下拉框），并显示**实际使用的引擎徽标**：
`tectonic` = 真排版，`近似排版` = 回退到浏览器内 MockCompiler。

安装引擎（一次性，约 14MB 静态二进制，首次编译自动拉取宏包与中文字体）：

```bash
mkdir -p .tectonic/bin && cd .tectonic/bin
curl -sSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz" | tar xz
# 也可用 TECTONIC_BIN=/path/to/tectonic 指定
```

> ⚠️ **中文还有一个隐藏前提**：pdf.js 预览中日韩文字依赖**预定义 CMap**（如 Adobe-GB1）。
> 缺了它的表现极具误导性——英文 PDF 完全正常、中文 PDF **整片空白**（复制也拿不到字）。
> `scripts/setup-pdfjs-assets.mjs` 会把 CMap 与标准字体同步到 `public/pdfjs/`，
> 由 `postinstall` / `predev` / `prebuild` 自动触发。

### 长篇论文（20 页 journal 量级）的上下文成本

以一篇 20 页 IEEE 双栏论文（10 图 / 10 表 / 80 公式 / 70 条文献）为例，用项目里的真实代码实测：

| 文件 | 字符 | 词 | ≈tokens |
| --- | --- | --- | --- |
| `main.tex` | 126,651 | 14,619 | 31,663 |
| `sections/appendix.tex` | 14,846 | 1,700 | 3,712 |
| `refs.bib` | 21,368 | 2,310 | 5,342 |
| **项目合计** | **162,865** | **18,627** | **40,716** |

注意：**每轮并不是把整个项目都发出去**。实际注入的是
「活动 `.tex` 全文 + 检索到的片段 + 术语表 + 规则」：

| 模型 | 窗口 | 每轮注入 | 结果 |
| --- | --- | --- | --- |
| `deepseek-chat` | 64K | ≈15,845 tokens | ⚠ **截断**（只发得下约 44% 正文） |
| `qwen-max` | 128K | ≈29,843 tokens | ⚠ 轻微截断 |
| `kimi-k3` | 1M | ≈33,503 tokens | ✓ 全文 |

- `refs.bib` **不进上下文**（只在检索命中时按片段注入），所以省下约 5.3K tokens；
- 图片默认**不进上下文**：`.tex` 里只有 `\includegraphics{fig1.pdf}` 这一行。若开启视觉
  （把图当图像发），每张约 1000 tokens（各家上限基本都在 1K 上下），10 张 ≈ 10K tokens；
- 界面状态栏实时显示 `上下文 ≈X tokens`，超出最小窗口模型预算时会标 ⚠。

**成本公式**：`每轮花费 = 注入 tokens / 1e6 × 单价`，且 **@ 几个模型就乘几份**。
所以 `@all`（4 个模型）在长篇论文下每轮约 13 万 tokens 输入——这是长篇写作最需要注意的一点。

**给长篇写作的建议**：

1. **按节写作，而不是整篇常驻**：选中一节让模型改（`【待处理文本】` 路径只发选段 + 全文做背景），
   或先切到某个 `\input` 的子文件再问，注入量立刻降一个数量级；
2. **用大窗口模型做"整篇一致性检查"**（`kimi-k3` 1M 窗口能一次容纳约 125 万字符），
   日常小改动用小窗口模型省钱；
3. **别常开 `@all`**：一轮 4 份全文上下文，成本是单模型的 4 倍；
4. 参考资料与论文正文**共享同一份预算**（论文优先占 70%），加了长资料会挤压论文正文——长篇项目里建议按需增删资料。

### Token 花销

| 内容 | 估算 |
| --- | --- |
| 英文 | 约 4 字符 = 1 token |
| 中文 | 约 1.5 字符 = 1 token |
| demo 论文（4371 字符 / 567 词） | 约 1.1K tokens |
| 典型 8 页论文（约 4 万字符） | 约 10K tokens |
| 中文论文（2 万字） | 约 13K tokens |
| 40K 字符的资料（PDF 提取文本） | 约 10K tokens |

一轮对话的组成（论文 4371 字符时的实测）：**约 1.57K tokens**，其中论文正文占 69%。
预算规则是"上下文窗口的 50% × 2.5 字符/token"，论文最多占该预算的 70%，参考资料拿剩下的。
所以：`deepseek-chat`（64K 窗口）能一次容纳约 8 万字；`kimi-k3`（1M 窗口）能容纳约 125 万字——
**常见论文（3–5 万字）在任何模型上都是全文发送，不会被截断。**

### agent 读到的是"哪一篇文章"

这是踩过的坑，值得单独说明：

| 块 | 取自 | 为什么 |
| --- | --- | --- |
| 【论文源码】 | **项目主文档**（编译入口 `rootPath`） | 用户问"解析一下项目里的文章"时要给整篇论文，而不是恰好开着的那个标签页 |
| 【论文正文（编译产物提取）】 | 最近一次编译的 **PDF 全文** | 源码里有宏、注释、被注释掉的段落；PDF 才是**读者看到的正文** |
| 【待处理文本】 | 编辑器里的选区 | 改写用它，与上面两块互不影响 |

**两个具体的错误**（都已修复并有测试）：

1. 前端只发"当前打开的文件" → 用户项目里残留的 `main.tex`（我演示论文的种子）被当成了论文正文，
   模型回答的是"Speculative Decoding"而不是用户的 HandAdapt。
   现在前端显式发送 `mainFile`（主文档内容），改写仍作用在活动文件上。
2. 服务端 `contexts.document(projectId)` 对**任何未知项目**都回退到演示论文 ——
   于是即便前端给了正确的主文档，也被服务端内存里的演示文档覆盖。
   现在只有**种子项目**才回退到演示数据。

**PDF 全文怎么来的**：编译成功后，服务端用 pdf.js 逐页提取文本、按项目缓存，
聊天时作为【论文正文（编译产物提取）】注入（占上下文预算的 50%，超长会截断并注明）。
所以"让 agent 读到编译好的 PDF"是自动的——编译一次就生效，不需要手动上传。

### 模型能读到什么（上下文构成）

每一轮对话发给模型的系统提示里包含下面这些块，**顺序即优先级**：

| 块 | 内容 | 预算 |
| --- | --- | --- |
| 【论文源码】 | **正在编辑的 .tex 全文** + 章节结构导航 | 占 50% 上下文预算的 70% |
| 【参考资料】 | 用户上传的资料正文（PDF 还会有页面图像，仅视觉模型可见） | 剩余预算 |
| 【待处理文本】 | 编辑器里选中的那一段 | — |
| 【术语表】 | 共享术语与禁用写法 | — |
| 【检索片段】 | BM25 从论文与资料里挑出的相关段落 | topK=6 |
| 【群聊规则】 | 自己的身份、不要扮演其他模型、历史里的 `[模型id]` 是发言人标签 | — |

> **为什么"论文源码"要单独强调**：早先的实现在没有选中文本时**只发送章节标题**
> （`# Introduction`、`## Method`…），正文一个字都没有。于是用户问"你能读到我的 .tex 吗"，
> 模型诚实回答"读不到"——而它确实没拿到。现在正文会按上面的预算整篇注入，
> 并在提示里明确告诉模型"这就是用户的 .tex，不要说看不到"。

### 模型之间怎么"互相看见"

三种机制，覆盖三种真实用法：

| 用法 | 机制 | 你需要做什么 |
| --- | --- | --- |
| **分两轮**：先 @ds，再 @qwen 评价它 | 服务端会话历史会作为 `[模型id] 正文` 回放给后续每一轮 | 直接问，不用复制粘贴 |
| **一条消息里**：`@ds 说明X，@qwen 评价 ds 的说法` | 检测到评审意图（评价/验证/对比/批判…）→ **自动串行**：ds 先答，qwen 拿到 ds 的回答后再发言 | 直接问 |
| **明确指向某条回答** | 点消息上的「**引用**」按钮 → 挂到输入框 → 作为 `quotedMessageId` 完整注入 | 点一下按钮 |

两个相关细节：

- **混合指令会按 @提及拆开**：`@ds 说明X，@qwen 评价 ds 的说法` 里，
  ds 只收到"说明X"、qwen 只收到"评价…"。否则 ds 会读到"请评价 ds 的说法"而困惑
  （实测它真的回复过"我本身就是 deepseek-chat，本轮我尚未发表任何说法"）。
- **会话会落盘**到 `.paperflow/sessions.json`（连同 `.paperflow/context.json`）。
  这一点很重要：多模型协作的全部价值建立在"记得别人说过什么"之上，
  而之前会话只在内存里，后端每次重启都会**静默清空**——表现为"模型互相看不见"，
  真正的原因却是对话被抹掉了。点「清空会话」会同时清服务端，避免界面空了而模型还记得。

### 检索是"中文友好"的

`packages/context/src/retriever.ts` 对英文按词、对中日韩按**相邻二元组（bigram）**切分。
这不是优化而是必需：中文没有空格，若整段当作一个 token，`"关键结论"` 这个查询
永远匹配不上 `"关键结论是……"` 这段正文——表现就是"我加了中文资料，但模型完全用不上"。
只用 bigram、不保留单字，是因为单字噪音太大（`关` 在 `关键` 与 `相关` 里都出现，
会把毫不相关的查询也召回）。`tests/core.test.ts` 里两条用例分别钉住了"能召回"与"不误召回"。

### 只显示"真正能回答"的模型

`@` 菜单与右侧阵容里**只会出现你配置了 Key 的模型**——没配置的模型点它只会拿到本地回退回复，
出现在候选里纯属噪音。规则（实现见 `apps/web/src/lib/modelSelection.ts`）：

| 状态 | `@` 菜单 / 阵容显示什么 |
| --- | --- |
| 已连后端 | 只显示 `available = true` 的模型（即厂商 Key 可用） |
| 浏览器内 mock（无后端） | 显示全部（本地引擎可代答任意模型，否则界面会变空） |
| 后端探测中 | 暂不过滤（避免闪一下空阵容） |
| 显式配置的后端连不上 | 如实显示为空，并提示去配 Key |

**加了新 Key 之后**：`apps/server/.env` 的改动会被 `tsx watch` 监听并自动重启后端；
切回浏览器窗口（或点阵容右上角的 ⟳）就会重新探测，新模型自动出现在 `@` 菜单里。
阵容也会自动跟随：**你没手动调过阵容时**，它会用新检测到的可用模型重新填充；
你手动选过之后就不再自动覆盖，只剔除已不可用的。

未配置的模型不会消失，它们在「模型与后端设置」面板的**未配置**分区里，
并标注了需要哪个环境变量（例如 `QWEN_API_KEY`）。

### 添加参考资料到对话里

左侧活动栏 →「共享知识」→「**资料**」页签 →「添加参考资料」。三种入口：

| 入口 | 用途 | 说明 |
| --- | --- | --- |
| **粘贴文本** | 摘录一段话、贴网页正文 | 填标题 + 内容即可 |
| **上传 PDF** | 把整篇论文喂给模型 | 用 pdf.js 在**浏览器端**提取正文，不上传二进制；扫描版 PDF 会提示需要 OCR |
| **上传 .bib** | 批量导入文献条目 | 服务端解析成结构化条目，进「文献」页，可用于生成 `\cite{}` |
| 也支持 `.txt` / `.md` / `.tex` | 纯文本材料 | 直接读取为资料 |

添加后会发生什么：

1. 文本落库到服务端（`POST /api/context/references`）；
2. 每一轮对话开始时，`packages/context` 的 BM25 检索会从**所有资料**里挑出与提问最相关的片段；
3. 这些片段 + 资料清单（标题列表）一起注入模型上下文，系统提示要求模型**只使用其中确实出现过的信息**并标注《标题》；
4. 资料面板里可以点「让模型基于它回答」直接生成一句引用该资料的提问。

> 资料与文献**会落盘**到仓库根目录的 `.paperflow/context.json`（已加入 `.gitignore`），
> 因此 `tsx watch` 因源码改动重启、或你手动重启后端，**都不会丢**。
> 写入是原子的（先写 `.tmp` 再 rename）；文件损坏时会回退到种子数据而不是拒绝启动。
> 想清空全部共享知识，直接删掉这个文件即可。

**模型是怎么用这些资料的**：除了按相关性检索正文片段，还会把每份资料的**正文节选**
一并放进提示词。这一步是必需的——BM25 是词面匹配，你用中文问"介绍一下这篇论文"时，
与英文论文正文没有任何词面重叠，只靠检索会让模型只看到标题列表，于是只能反问
"你要我讲哪一篇？"。一份资料时给 2000 字节选，多份时每份 600 字以便模型辨认。

### @ 提及的规则（避免"我 @ 了它却不回复"）

- `@模型id`（如 `@qwen-max`、`@deepseek-reasoner`）→ **只有它回答**，即使它不在右侧房间阵容里也能直接点名。
- `@家族名`（如 `@qwen`）→ 命中该家族的第一个可用模型。
- `@all` → 房间内所有模型各答一次（会并发消耗多次调用）。
- 不写 `@` → 默认由房间阵容全体回答。
- **`@` 的名字后端认不出时，本轮不会调用任何模型**，而是直接在会话里列出候选与可用模型清单
  （避免"写错一个字 → 4 个模型各答一遍"这种既费钱又迷惑的结果）。
| `npm run typecheck` | 全量类型检查 |
| `npm run build` | 构建前端产物 |
| `npm run verify:ui` | 浏览器端到端冒烟测试 |
| `npm run clean` | 清理 node_modules / dist / artifacts |
