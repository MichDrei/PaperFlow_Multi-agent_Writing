# PaperFlow

> 把「写论文」从一个人的苦役，变成一个人 + 一群 AI + 几个同行的协作。

PaperFlow 是一个面向**科研论文写作**的编辑器：左侧写 LaTeX、右侧实时看到排好版的 PDF，
中间可以拉一个「多模型群聊」帮你改稿，需要的时候把同组的人拉进来一起改。

- **个人使用**：装在自己电脑上，自带 API Key，数据全在本地，当成写作 + 文献管理工具。
- **团队协作**：发起人建项目、发邀请，成员申请、发起人审批后进入协作：实时协同、文段批注、公共/私人群聊。

---

## 目录

- [核心特性](#核心特性)
- [两种模式](#两种模式)
- [快速开始](#快速开始)
- [团队协作怎么开](#团队协作怎么开)
- [中文论文与字体](#中文论文与字体)
- [架构一览](#架构一览)
- [常见问题](#常见问题)
- [Roadmap](#roadmap)
- [License](#license)
- [演示动图](#演示动图)

---

## 核心特性

### 写作与排版
- **真 LaTeX 编译**：内置 [Tectonic](https://tectonic-typesetting.github.io/)，不需要本地装 TeX Live
- **PDF 实时预览**：编译产物按 URL 提供，大文件也不卡
- **源码 ↔ PDF 双向定位**：点 PDF 跳到对应源码行
- **悬浮预览**：引用、图片、公式、表格在源码里悬停即可看到效果

### 多模型协作
- **群聊式多 Agent**：一个房间里同时有多个模型（DeepSeek / Kimi / Qwen / 其他 OpenAI 兼容模型），可以 `@` 指定谁回答，也可以指定多个模型交叉评审
- **上下文进得去**：当前项目的主文档、编译后的 PDF 文本、你划选的段落、被批注的原文，都会作为上下文交给模型
- **引用任意消息**：点消息上的「引用」，下一个模型能直接读到那条原文

### 多人协作（可选）
- **实时协同**：基于 Yjs 的 CRDT，多光标 + 姓名标签，断线后自动清理
- **文段批注**：在编辑器里划一段加批注，批注锚在文字上（`@` 成员、回复串、点击跳转、仅作者可删）
- **公聊 / 私聊**：公聊全组可见、用服务器配置的模型；私聊只有自己可见、历史只存本地
- **知识库分级**（进行中）：公用资料全组可见，私有资料只有自己可见

### 团队与成本
- **邀请制**：邀请链接 → 申请 → 发起方审批，没有邮箱/密码体系
- **色板去重**：成员颜色自动分配且不撞色
- **成本归属清晰**：公聊烧服务器 Key，私聊可用服务器模型但历史不外泄

---

## 两种模式

| | **个人模式** | **协作模式** |
|---|---|---|
| 触发方式 | 默认（不设 `AUTH_MODE`） | `AUTH_MODE=team` 且项目有人加入 |
| 数据 | 本地 `.paperflow/` | 服务器（团队实例） |
| 登录 | 不需要 | 邀请链接 + 审批 |
| 群聊 | 只有私聊 | 私聊 + 公聊 |
| 模型 | 你自己的 Key | 公聊用服务器 Key；私聊可用服务器模型 |
| 适用 | 自己写论文 | 课题组共同写作 |

**模式按项目区分**：同一个部署里，A 论文可以是单人，B 论文可以拉人协作。
一个项目只有在「邀请被批准、有人真的加入」之后才会切成协作模式。

---

## 快速开始

### 前置条件
- **Node.js 22+**
- 网络（首次需要下载 TeX 引擎和依赖）

### 安装并运行

```bash
git clone https://github.com/MichDrei/PaperFlow_Multi-agent_Writing.git
cd PaperFlow_Multi-agent_Writing

# 1. 配置模型 Key（至少填一个）
cp .env.example apps/server/.env
$EDITOR apps/server/.env

# 2. 安装依赖
npm ci

# 3. 下载 TeX 引擎（仅首次，约 20MB）
bash scripts/fetch-tectonic.sh

# 4. 启动
npm run dev
```

打开 <http://127.0.0.1:5273>，新建或导入（zip / 本地目录）一个 LaTeX 项目即可开始。

### 配置说明（`apps/server/.env`）

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `MOONSHOT_API_KEY` | 模型厂商 Key，填任意一个即可 |
| `PORT` | 服务端口，默认 `5273` |
| `AUTH_MODE` | 不设置 = 个人模式；`team` = 协作模式 |
| `PROJECTS_ROOT` | 数据目录，默认 `<仓库>/.paperflow` |
| `MAX_CONCURRENCY` | 同时在跑的模型数量上限，默认 `4` |

---

## 团队协作怎么开

1. 用协作模式启动：

   ```bash
   AUTH_MODE=team npm run dev
   ```

2. 首次启动会在日志和 `<PROJECTS_ROOT>/team/OWNER-LINK.txt` 里打印**认领链接**。
   打开它 → 认领成为「发起方」。

3. 在项目里点右上角「团队」→ **生成邀请链接** → 发给同事。

4. 同事打开链接申请加入，你在「待审批」里点同意。
   **这一刻**该项目才切成协作模式：公聊解锁、成员状态出现、协同开始同步。

> 想让组里访问，需要一台常开的机器（或 VPS），并用 `HOST=0.0.0.0` 启动，
> 组内通过 `http://<机器IP>:5273` 访问。公网访问请务必加 HTTPS
> （WebSocket 走 `wss`，反向代理要支持 `Upgrade`）。

---

## 中文论文与字体

Tectonic 默认不含中文字体。写中文论文时，把系统字体拷进 Tectonic 的本地字体目录：

```bash
bash scripts/install-windows-fonts.sh   # 从本机 Windows 目录复制（仅本地使用）
```

⚠️ **字体不随仓库分发**：Windows 字体受微软 EULA 限制，不能二次分发。
每个使用者需要在自己的机器上执行一次上面的脚本。

---

## 架构一览

```
apps/
  web/        React 18 + Vite + Tailwind v4 + Zustand
  server/     Fastify 5（HTTP + WebSocket）
packages/
  core/       领域模型与协议
  llm/        各厂商适配（OpenAI 兼容）
  agents/     多 Agent 编排与上下文序列化
  context/    工程上下文（知识库、引用、术语）
  latex/      编译服务封装（Tectonic）
  ui/         共享 UI 组件
```

**关键技术**

| 问题 | 方案 |
|---|---|
| 多人实时编辑 | Yjs CRDT + `y-monaco`，服务端手写 y-websocket 协议 |
| 聊天室广播 | 独立 WebSocket 通道 `/room`，按项目分房间 |
| PDF 生成 | Tectonic（`--keep-logs --synctex`），产物落盘后按 URL 提供 |
| 协同身份 | HttpOnly Cookie 会话，邀请制，无密码 |
| 多人光标 | awareness 协议，颜色从 12 色板按使用次数最少分配 |

---

## 常见问题

**Q：编译报 `File 'xxx.cls' not found`？**
A：确认编译的是**主文档**（项目根目录那份），并且 `xxx.cls` 在项目文件树里。
服务端会把项目里除主文档外的所有文件拷进编译工作目录。

**Q：第一次编译特别慢（1~2 分钟）？**
A：Tectonic 首次要下载/预热宏包和字体，之后有缓存会快很多。大论文（上百张图）本身也要 1 分钟左右。

**Q：端口被占用？**
A：`PORT=5280 npm run dev` 换一个端口，或先停掉占用 `5273` 的进程。

**Q：团队模式登录不了 / 会话丢了？**
A：会话是 HttpOnly Cookie，换浏览器或清过缓存就没了。
让发起方在服务端用一个一次性恢复链接重新签发会话。

**Q：数据存在哪？**
A：默认 `<仓库>/.paperflow/`：`projects/`（论文）、`team/`（成员与会话）、`collab/`（协同快照）、`pdf-cache/`（编译产物）。
**这些不进 Git**（见 `.gitignore`）。

---

## Roadmap

- [ ] 知识库公用/私有分级（进行中）
- [ ] PDF 文本选中 → 源码的精确定位（SyncTeX 框栈 + 地标校验）
- [ ] Zotero 联动（文献条目与 PDF 附件直接入库）
- [ ] 批注 @ 提醒与已读状态
- [ ] 项目级预算与用量台账（按人/按项目计费）

---

## License

[MIT](LICENSE) © PaperFlow contributors

> 注意：仓库不分发 TeX 引擎与 Windows 字体，使用者需自行安装/复制。

---

## 演示动图

README 顶部的演示动图放在 `docs/demo/`，命名与拍摄要点见 [`docs/demo/README.md`](docs/demo/README.md)。
