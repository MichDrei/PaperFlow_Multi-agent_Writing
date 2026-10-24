/**
 * Mock 提供方：没有任何 API Key 时，让整条 SSE 链路依然可端到端跑通。
 *
 * 它不会假装自己是真实模型——输出里会明确声明这是本地回退。但当系统提示要求
 * "撰写者输出格式"时，它会用确定性的文本变换给出一个**真实可应用**的 LaTeX 替换块，
 * 从而让「模型输出 → EditProposal → diff → 应用」这条链路在零密钥环境下也能被验证。
 */

import {
  countWords,
  polish,
  rewrapParagraphs,
  tighten,
  truncate,
  type ModelId,
  type ProviderId,
} from '@paperflow/core';
import { messageImages, messageText, type LlmChunk, type LlmProvider, type LlmRequest } from '../types.js';

const SELECTION_RE = /【待处理文本】\n([\s\S]*?)(?=\n\n【|$)/;
const AUTHOR_CONTRACT_MARK = '【输出格式（必须严格遵守）】';

export class MockProvider implements LlmProvider {
  readonly id: ProviderId = 'mock';

  readonly label = 'Local Mock';

  private readonly models_: ModelId[];

  constructor(models: ModelId[]) {
    this.models_ = models;
  }

  isConfigured(): boolean {
    return true;
  }

  models(): ModelId[] {
    return this.models_;
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmChunk> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => messageText(m))
      .join('\n\n');
    const lastUser = messageText([...req.messages].reverse().find((m) => m.role === 'user') ?? { role: 'user', content: '' });
    const imageCount = req.messages.reduce((sum, m) => sum + messageImages(m).length, 0);
    if (imageCount > 0) {
      // 本地回退也能体现"收到了图片"，方便验证视觉链路
      const note = `\n- 收到图片：${imageCount} 张（本地回退模式不解析图像内容）`;
      yield { type: 'text', text: note };
    }
    const selection = SELECTION_RE.exec(system)?.[1]?.trim();
    const isAuthor = system.includes(AUTHOR_CONTRACT_MARK);
    const isPeerReview = system.includes('批判性审阅');

    const text = isAuthor && selection
      ? this.authorReply(selection)
      : this.proseReply({ model: req.model, system, lastUser, selection, isPeerReview });

    // 分片输出，模拟真实流式节奏，便于验证前端增量渲染。
    for (let i = 0; i < text.length; i += 6) {
      if (req.signal?.aborted) return;
      yield { type: 'text', text: text.slice(i, i + 6) };
      await new Promise((r) => setTimeout(r, 10));
    }
    yield { type: 'usage', usage: { promptTokens: 0, completionTokens: 0 } };
  }

  /** 撰写者：产出一个可解析成 EditProposal 的 ```latex 围栏。 */
  private authorReply(selection: string): string {
    // 先合并段内硬换行（LaTeX 中不影响排版，但能让 diff 可读），再压缩冗余表达。
    const tightened = rewrapParagraphs(tighten(selection));
    const polished = rewrapParagraphs(polish(selection));
    const replacement = tightened.length <= polished.length ? tightened : polished;

    if (replacement.trim() === selection.trim()) {
      return [
        '我检查了这段文本，没有发现值得删除的冗余表达或明显的语气问题。',
        '',
        '（本地回退模式：不会为了"显得有用"而强行改动。配置 API Key 后可获得真实模型的改写方案。）',
      ].join('\n');
    }

    const onlyRewrap = replacement.replace(/\s+/g, ' ').trim() === selection.replace(/\s+/g, ' ').trim();
    const commentary = onlyRewrap
      ? `合并了段内硬换行（${selection.split('\n').length} 行 → ${replacement.split('\n').length} 行）。LaTeX 中源码换行不影响排版，合并后 diff 更易读。`
      : `删去了填充词与冗余从句，事实与数值全部保留（${countWords(selection)} → ${countWords(replacement)} 词）。`;

    return [
      commentary,
      '',
      '```latex',
      replacement,
      '```',
      '',
      '> 本地回退模式产出的确定性改写；配置 API Key 后由真实模型生成。',
    ].join('\n');
  }

  /** 其余角色：给出与上下文相关的可读结论，不伪造数据。 */
  private proseReply(input: {
    model: ModelId;
    system: string;
    lastUser: string;
    selection?: string;
    isPeerReview: boolean;
  }): string {
    const { model, system, lastUser, selection, isPeerReview } = input;
    const termCount = (system.match(/^- .+→.+（禁用/gm) ?? []).length;
    const retrievedCount = (system.match(/— \((paper|citation|terminology|figure)/g) ?? []).length;

    if (isPeerReview) {
      return [
        '**交叉评审意见**（本地回退模式）',
        '',
        '- 我收到了上一位模型的完整方案。由于当前没有真实模型可用，我不会假装读过它的语义细节。',
        '- 可以确定的检查项：术语一致性由共享术语表强制约束，diff 由服务端基于真实文档重新计算，因此"提议是否可应用"这一点是可信的。',
        '- 建议：在接受任何改写前，先确认它没有删除带数值的句子。',
      ].join('\n');
    }

    const lines = [
      `**本地回退回复**（模型 \`${model}\` 尚未配置 API Key）`,
      '',
      '我已收到完整上下文：角色提示、共享知识与检索片段。当前运行在无密钥的本地回退模式，因此不会伪造改写结果。',
      '',
      `- 注入术语条目：${termCount} 条`,
      `- 注入检索片段：${retrievedCount} 条`,
      `- 系统提示长度：${system.length} 字符`,
      selection ? `- 附带选区：${truncate(selection, 80)}` : '- 本轮未附带编辑器选区',
      `- 用户指令：${truncate(lastUser, 100)}`,
      '',
      '> 在 `apps/server/.env` 中配置任一厂商的 API Key 后重启服务，本回复将由真实模型生成。',
    ];
    return lines.join('\n');
  }
}
