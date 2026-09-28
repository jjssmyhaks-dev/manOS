'use client';

import { memo, useMemo } from 'react';

/**
 * Vercel AI Elements — Response
 * https://ai-sdk.dev/elements/components/response
 *
 * Renders assistant markdown (GFM tables, lists, headings) with a light
 * default stylesheet. In this build markdown plugins are intentionally tiny
 * (no external markdown CSS dependency).
 */

function parseInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) nodes.push(<strong key={m.index} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) nodes.push(<code key={m.index} className="rounded bg-muted px-1 py-0.5 text-[13px]">{t.slice(1, -1)}</code>);
    else nodes.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function extractTable(lines: string[], start: number): { rows: string[][]; end: number } {
  const rows: string[][] = [];
  let i = start;
  while (i < lines.length && lines[i]!.includes('|')) {
    const cells = lines[i]!.split('|').slice(1, -1).map((c) => c.trim());
    if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
    i++;
  }
  return { rows, end: i - 1 };
}

function Markdown({ children }: { children: string }) {
  const lines = useMemo(() => children.replace(/\r/g, '').split('\n'), [children]);

  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim().startsWith('|') && line.includes('|', 1)) {
      const { rows, end } = extractTable(lines, i);
      if (rows.length) {
        const [head, ...body] = rows;
        blocks.push(
          <div key={key++} className="my-2 overflow-x-auto scrollbar-thin">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b bg-muted/50">
                  {(head ?? []).map((c, ci) => <th key={ci} className="px-2 py-1 font-semibold">{parseInline(c)}</th>)}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} className="border-b last:border-0">
                    {row.map((c, ci) => <td key={ci} className="px-2 py-1">{parseInline(c)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      i = end + 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = parseInline(heading[2]!);
      blocks.push(
        level === 1 ? <h1 key={key++} className="mb-1 mt-2 text-lg font-bold">{text}</h1>
        : level === 2 ? <h2 key={key++} className="mb-1 mt-2 text-base font-semibold">{text}</h2>
        : <h3 key={key++} className="mb-1 mt-2 text-sm font-semibold">{text}</h3>
      );
      i++;
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*•]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} className="my-1 list-disc space-y-0.5 pl-5">
          {items.map((it, ii) => <li key={ii}>{parseInline(it)}</li>)}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-5">
          {items.map((it, ii) => <li key={ii}>{parseInline(it)}</li>)}
        </ol>
      );
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    // paragraph (merge soft-wrapped lines)
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,4})\s|^\s*[-*•]\s|^\s*\d+\.\s|^\|/.test(lines[i] ?? '')) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={key++} className="whitespace-pre-wrap">{parseInline(para.join('\n'))}</p>);
  }

  return <div className="space-y-1">{blocks}</div>;
}

export const Response = memo(({ children }: { children: string }) => {
  return <div className="text-sm leading-relaxed"><Markdown>{children}</Markdown></div>;
});
Response.displayName = 'Response';

export const ResponseUser = memo(({ children }: { children: string }) => (
  <div className="whitespace-pre-wrap text-sm">{children}</div>
));
ResponseUser.displayName = 'ResponseUser';
