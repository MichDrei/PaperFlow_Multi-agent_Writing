/**
 * 上下文序列化：把群聊线程 + 文档 + 共享知识压成每个模型都能消化的一份 prompt。
 *
 * 这里做三件关键的事：
 * 1. 注入术语表（保证多模型用词一致）；
 * 2. 注入检索片段（保证论断有据可依，而不是靠模型记忆）；
 * 3. 按 token 预算裁剪历史（长会话不能无限增长）。
 */

import type { ChatMessage, PaperFile, SharedContext } from '@paperflow/core';
import { formatRetrieved, terminologyPromptBlock, type RetrievedChunk } from '@paperflow/context';
import type { LlmMessage } from '@paperflow/llm';
import { contextBudgetChars, paperBudgetChars } from '@paperflow/core';
import { AUTHOR_OUTPUT_CONTRACT, systemPromptFor } from './roles.js';
import type { AgentRole } from '@paperflow/core';

export interface SerializeInput {
  role: AgentRole;
  /** 目标模型的上下文窗口（token）。用于决定资料能发多少——不再用固定 2000 字截断。 */
  modelContextWindow?: number;
  /** 目标模型是否支持图像输入。只有 true 才会附带 PDF 页面图像。 */
  supportsVision?: boolean;
  /** 指令正文（**必须已去掉 @提及**，否则模型会去"扮演"被点名的那个人）。 */
  instruction: string;
  /** 本模型的自我身份，用于注入"你是谁、不要扮演别人"的群聊规则。 */
  selfModel?: { id: string; label: string };
  /** 本轮同时被点名的其他模型，仅用于说明"各答各的"。 */
  peerTargets?: string[];
  selection?: { text: string; fileId: string; startLine: number; endLine: number };
  activeFile?: PaperFile;
  /** 项目主文档（编译入口）。论文正文优先用它，缺省才用 activeFile。 */
  mainFile?: PaperFile;
  /** 编译产物的 PDF 全文（服务端从 PDF 提取）。 */
  compiledText?: string;
  sharedContext: SharedContext;
  retrieved: RetrievedChunk[];
  history: ChatMessage[];
  /** 历史消息最多占用多少字符（粗略预算，避免超长会话挤爆上下文）。 */
  historyBudgetChars?: number;
  /** 交叉评审时，另一个模型刚给出的答案。 */
  peerAnswer?: { modelId: string; text: string };
  /** 单次请求最多附带几张页面图像（图像 token 很贵，必须限流）。 */
  maxImages?: number;
  /** 用户显式引用的历史回答：必须针对它发言，而不是泛泛而谈。 */
  quoted?: { modelId: string; text: string }[];
}

export function serializeMessages(input: SerializeInput): LlmMessage[] {
  const blocks: string[] = [];

  const termBlock = terminologyPromptBlock(
    input.sharedContext.terminology,
    input.selection?.text ?? input.instruction,
  );
  if (termBlock) blocks.push(termBlock);

  const retrievedBlock = formatRetrieved(input.retrieved);
  if (retrievedBlock) blocks.push(retrievedBlock);

  // 参考资料：**尽可能发送全文**，而不是固定截断。
  //
  // 演进过程（值得记下来）：
  //   v1 只给标题清单 → 模型只能反问"你要我讲哪一篇？"
  //   v2 固定给 2000 字节选 → 4 万字的论文，模型明说"内容不全"，用户很不满
  //   v3（现在）按**模型的上下文窗口**分配预算：能全发就全发，发不下才截断并明确告知模型
  //
  // 预算取上下文窗口的一半（其余留给系统提示、历史、论文正文与输出），
  // 中文约 1.5 字符/token、英文约 4 字符/token，这里按 2.5 字符/token 保守估算。
  // 论文正文优先占用预算：它才是被编辑的对象，模型必须看得到。
  // 参考资料拿剩下的部分。
  const contextWindow = input.modelContextWindow ?? 64_000;
  const budgetChars = contextBudgetChars(contextWindow);
  let paperChars = 0;
  // 论文正文用**主文档**（mainFile），没有才退回活动文件
  const paperFile = input.mainFile ?? input.activeFile;
  if (paperFile) {
    const paper = paperFile.content ?? '';
    const outline = [...paper.matchAll(/\\(section|subsection)\{([^}]*)\}/g)]
      .map((m) => `${m[1] === 'section' ? '#' : '##'} ${m[2]}`)
      .join('\n');
    // 正文不超过总预算的一定比例，避免一篇超长论文把参考资料挤光
    const paperLimit = paperBudgetChars(contextWindow);
    const included = paper.length <= paperLimit ? paper : paper.slice(0, paperLimit);
    paperChars = included.length;
    blocks.push(
      [
        `【论文源码】文件：${paperFile.path}（共 ${paper.length} 字${
          included.length < paper.length ? `，本次提供前 ${included.length} 字` : '，已全文提供'
        }）`,
        outline ? `章节结构：\n${outline}` : '',
        included,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  // 编译产物的正文：这是"读者看到的文章"，与源码互补（源码里的宏、注释读者看不到）。
  // 有它 agent 才能回答"文章里到底写了什么"这类问题。
  if (input.compiledText && input.compiledText.trim().length > 200) {
    const text = input.compiledText.trim();
    const limit = Math.min(text.length, Math.floor(contextBudgetChars(contextWindow) * 0.5));
    blocks.push(
      [
        `【论文正文（编译产物提取）】共 ${text.length} 字${
          limit < text.length ? `，本次提供前 ${limit} 字` : '，已全文提供'
        }`,
        text.slice(0, limit),
      ].join('\n'),
    );
  }

  const references = input.sharedContext.references ?? [];
  if (references.length > 0) {
    const remaining = Math.max(Math.floor(budgetChars) - paperChars, 8_000);
    const MAX_PREVIEWED = 5;
    const previewed = references.slice(0, MAX_PREVIEWED);
    const perReference = Math.floor(remaining / previewed.length);

    const sections = previewed.map((r) => {
      const full = r.text ?? '';
      if (full.length <= perReference) {
        return `——《${r.title}》（${r.kind}${r.source ? `，来源：${r.source}` : ''}，共 ${r.charCount} 字）\n【全文】\n${full}`;
      }
      return `——《${r.title}》（${r.kind}${r.source ? `，来源：${r.source}` : ''}，共 ${r.charCount} 字）\n【因长度限制，本次只提供前 ${perReference} 字，其余部分会按相关性检索补充】\n${full.slice(0, perReference)}`;
    });

    const allFull = previewed.every((r) => (r.text ?? '').length <= perReference);
    blocks.push(
      [
        `【参考资料】（共 ${references.length} 份${allFull ? '，以下均为全文' : '，部分因长度限制为节选'}）`,
        ...sections,
        references.length > previewed.length
          ? `（另有 ${references.length - previewed.length} 份资料未展开：${references
              .slice(MAX_PREVIEWED)
              .map((r) => `《${r.title}》`)
              .join('、')}）`
          : '',
        '回答时请优先依据这些材料，并用《标题》标注来源；只使用其中确实出现过的信息。',
        allFull
          ? '以上资料已提供完整内容，请直接基于全文回答，不要声称"内容不全"或要求用户补充。'
          : '对于节选的资料，如果你判断需要未提供的那部分，请明确说明你需要哪一段，而不是笼统地说"内容不全"。',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (input.selection) {
    blocks.push(
      [
        '【当前编辑上下文】',
        `文件：${input.selection.fileId}`,
        `行范围：${input.selection.startLine}–${input.selection.endLine}`,
        '【待处理文本】',
        input.selection.text,
      ].join('\n'),
    );
  }

  // 用户显式引用：把那条回答完整摆到模型面前，并要求点名回应
  if (input.quoted && input.quoted.length > 0) {
    blocks.push(
      [
        '【用户要求你针对以下回答发言】',
        ...input.quoted.map((q) => `——来自 ${q.modelId} 的回答：\n${q.text}`),
        '请**直接针对上述回答**给出你的判断：哪些是对的、哪些有问题、你会怎么改。',
        '不要泛泛而谈，也不要声称看不到对方的回答——它就在上面。',
      ].join('\n'),
    );
  }

  // 交叉评审：把另一位模型的方案交给本轮模型批判性审阅
  if (input.peerAnswer) {
    blocks.push(
      [
        `【另一位模型（${input.peerAnswer.modelId}）刚刚给出的方案】`,
        input.peerAnswer.text,
        '',
        '请对其进行**批判性审阅**：指出其中的事实错误、术语不一致或可编译性问题；如果它是对的，也要明确说"无需修改"。',
      ].join('\n'),
    );
  }

  // 群聊规则：这是"Qwen 自称 DeepSeek"那个 bug 的根治手段。
  // 历史消息用 `[模型id] 正文` 标注发言人，模型很容易模仿这个前缀，
  // 也容易把用户指令里的 @某某 理解成"让我扮演他"。
  if (input.selfModel) {
    blocks.push(
      [
        '【群聊规则（必须遵守）】',
        `- 本会话是一个多模型协作群聊。你的身份是「${input.selfModel.label}」（模型 id: ${input.selfModel.id}），你只能以这个身份发言。`,
        '- 历史消息开头的 `[模型id]` 是**系统添加的发言人标签**，用于区分是谁说的；你自己的回复**不要**加这种前缀。',
        '- 绝不要扮演、模仿或代替其他模型发言，也不要声称自己是别的模型。',
        input.peerTargets && input.peerTargets.length > 1
          ? `- 本轮同时被点名的模型还有：${input.peerTargets.filter((t) => t !== input.selfModel!.id).join('、')}。各答各的，不要替他们回答。`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (paperFile) {
    blocks.push(
      '【关于论文源码】上面的【论文源码】就是这篇论文的**主文档**（编译入口，及其章节结构）。' +
        '回答与论文有关的问题时请直接引用它的内容；不要说"我看不到 .tex 文件"或要求用户粘贴。' +
        '如果你需要文件里没有出现的部分，请指出具体缺少哪一节。',
    );
  }

  if (input.role === 'author') blocks.push(AUTHOR_OUTPUT_CONTRACT);

  if (input.peerAnswer) {
    blocks.push(
      [
        `【另一位模型（${input.peerAnswer.modelId}）刚刚给出的方案】`,
        input.peerAnswer.text,
        '',
        '请对其进行**批判性审阅**：指出其中的事实错误、术语不一致或可编译性问题；如果它是对的，也要明确说"无需修改"。',
      ].join('\n'),
    );
  }

  const messages: LlmMessage[] = [{ role: 'system', content: systemPromptFor(input.role, blocks) }];

  const history = trimHistory(input.history, input.historyBudgetChars ?? 6000);
  for (const message of history) {
    if (message.author.kind === 'user') {
      /*
       * 多人房间里必须带上发言人：否则 agent 只看到一串"用户说…"，
       * 根本分不清是张振源还是王五（实测它会回答"群里没有王五这个人"）。
       */
      const name = message.author.name;
      messages.push({ role: 'user', content: name ? `${name}：${message.text}` : message.text });
    } else if (message.author.kind === 'model') {
      /*
       * 关键：只有**自己**说过的话才是 assistant。
       *
       * 之前所有模型消息都用 assistant，模型会把别的模型的发言当成人格分裂的"自己"——
       * 实测小米 MiMo 看到历史里的 `[deepseek-flash] …` 就回答"我按群规以 deepseek-flash 身份"。
       * 别人的话改成 user 角色并标注发言人，模型才会理解为"这是另一个模型说的"。
       */
      const selfId = input.selfModel?.id;
      if (!selfId || message.author.modelId === selfId) {
        messages.push({ role: 'assistant', content: message.text });
      } else {
        messages.push({ role: 'user', content: `【${message.author.modelId} 的发言】${message.text}` });
      }
    }
  }

  // 视觉模型才附带页面图像。放在**最后一条 user 消息**里：
  // DeepSeek 明确要求图片只能在 user 消息中，system/assistant 里的图片会 400。
  const visionImages =
    input.supportsVision
      ? (input.sharedContext.references ?? [])
          .flatMap((r) => r.pageImages ?? [])
          .slice(0, input.maxImages ?? 8)
      : [];

  if (visionImages.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: buildInstruction(input) },
        ...visionImages.map((dataUrl) => {
          const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
          return {
            type: 'image' as const,
            mimeType: match?.[1] ?? 'image/png',
            dataBase64: match?.[2] ?? dataUrl,
          };
        }),
      ],
    });
  } else {
    messages.push({ role: 'user', content: buildInstruction(input) });
  }
  return messages;
}

function buildInstruction(input: SerializeInput): string {
  const parts = [input.instruction.trim() || '请审阅上面的文本并给出你的意见。'];
  if (input.selection) {
    parts.push('（改写目标：上面【待处理文本】中的内容，输出必须是可直接替换该区间的完整 LaTeX。）');
  }
  return parts.join('\n');
}

/** 只保留最近的若干条消息，且总字符数受预算约束。 */
export function trimHistory(history: ChatMessage[], budgetChars: number): ChatMessage[] {
  const usable = history.filter((m) => m.author.kind !== 'system' && m.text.trim().length > 0);
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const message = usable[i]!;
    const cost = message.text.length;
    if (used + cost > budgetChars && out.length > 0) break;
    out.unshift(message);
    used += cost;
  }
  return out;
}
