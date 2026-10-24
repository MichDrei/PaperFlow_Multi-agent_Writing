# 演示动图

README 里的动图都放这个目录，**保持体积小**（单张 < 5 MB），否则 GitHub 页面加载会很慢。

## 建议拍的 5 个镜头

| 文件名 | 内容 | 时长 |
|---|---|---|
| `01-write-compile.gif` | 左边打字 → 右边 PDF 实时更新 → 点 PDF 跳回源码 | 8~10s |
| `02-multi-agent.gif` | `@deepseek @kimi` 两个模型同时回答、交叉评审 | 10~15s |
| `03-annotation.gif` | 划一段 → 加批注 → @成员 → 点批注跳转 | 8~10s |
| `04-collab.gif` | 两个窗口同时编辑：彩色光标 + 姓名 + 群聊公聊 | 10~15s |
| `05-invite.gif` | 生成邀请链接 → 对方申请 → 发起方审批 → 项目变协作 | 10s |

## 怎么录

**Linux（WSL 需要 Windows 端的录屏工具）**
```bash
# 推荐 peek（简单）或 ffmpeg + x11grab
sudo apt install peek
```

**Windows**：PowerToys 的 Screen Recorder，或 ShareX（可直接导出 GIF/MP4）

**macOS**：Kap

## 转成合适大小

```bash
# 15fps、宽 1200、去掉音频——README 里够清楚，体积也小
ffmpeg -i raw.mp4 -vf "fps=15,scale=1200:-1:flags=lanczos" -loop 0 docs/demo/01-write-compile.gif
```

## 在 README 里引用

```md
![写入与实时编译](docs/demo/01-write-compile.gif)
```

> 如果以后想放视频，GitHub 支持直接拖拽 `.mp4` 到 Issue/README 的编辑框，
> 会得到一个 `user-images.githubusercontent.com` 的链接，但那样文件不在仓库里，不推荐。
