/**
 * 前端本地文本工具的入口。
 *
 * 真正的实现在 @paperflow/core/text（因为服务端的 Mock 提供方也要用同一套逻辑）。
 * 这里只做转出，保持前端既有 import 路径不变。
 */

export {
  countWords,
  estimateTokens,
  expand,
  HEDGE_WORDS,
  polish,
  reviewFindings,
  rewrapParagraphs,
  tighten,
  truncate,
  type ReviewFinding,
} from '@paperflow/core';
