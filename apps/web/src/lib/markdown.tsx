/**
 * 极简 Markdown 渲染器（零依赖）。
 *
 * 模型输出是 Markdown + LaTeX 混合文本，这里只处理聊天场景真正用到的子集：
 * 代码块、列表、引用、标题、粗体、行内代码、斜体。
 * 不引入 marked/react-markdown 是为了：可控（不会被模型输出注入 HTML）、体积小。
 */

import type { ReactNode } from 'react';
import { normalizeEol } from '@paperflow/core';

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'h'; level: number; text: string };

function parseBlocks(source: string): Block[] {
  // 模型回复里也可能带 CRLF；标题正则用 `$` 锚定行尾，不归一化会漏识别
  const lines = normalizeEol(source).split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // 跳过结束围栏
      blocks.push({ kind: 'code', lang, lines: body });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^\s*([-*]|\d+[.)])\s+/.test(lines[i] ?? '') &&
      !/^\s*>/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').trimStart().startsWith('```') &&
      !/^#{1,6}\s+/.test(lines[i] ?? '')
    ) {
      para.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

/** 行内标记：`code`、**bold**、*italic*。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g).filter((p) => p !== '');
  return parts.map((part, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <span key={key}>{part}</span>;
  });
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className ?? 'pf-prose'}>
      {blocks.map((block, idx) => {
        const key = `b-${idx}`;
        switch (block.kind) {
          case 'code':
            return (
              <pre key={key}>
                <code>{block.lines.join('\n')}</code>
              </pre>
            );
          case 'h': {
            const Tag = (block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3';
            return (
              <Tag key={key} className="mt-2 mb-1 text-[12.5px] font-semibold text-ink-100">
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'ul':
            return (
              <ul key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} className="pf-prose-ol">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`} className="ml-4 list-decimal">
                    {renderInline(item, `${key}-${i}`)}
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote
                key={key}
                className="my-2 border-l-2 border-ink-600 pl-2.5 text-ink-300 italic"
              >
                {renderInline(block.lines.join(' '), key)}
              </blockquote>
            );
          default:
            return <p key={key}>{renderInline(block.lines.join('\n'), key)}</p>;
        }
      })}
    </div>
  );
}
