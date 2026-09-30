/**
 * Minimal dependency-free PDF writer for the activity-log export.
 * Produces a small, valid PDF 1.4 (Helvetica core fonts, WinAnsi-safe text)
 * with automatic pagination — enough for a tabular audit trail, without
 * pulling a PDF library into the bundle. All text is sanitised to ASCII
 * (₹→Rs, dashes/arrows normalised) so no font embedding is needed.
 */

export interface PdfLine {
  text: string;
  bold?: boolean;
  size?: number; // default 9
  gapAfter?: number; // extra points of vertical space after this line
}

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 40;

function ascii(s: string): string {
  return s
    .replace(/[₹]/g, 'Rs ')
    .replace(/[–—]/g, '-')
    .replace(/[→]/g, '->')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/•/g, '*')
    .replace(/…/g, '...')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '?');
}

function esc(s: string): string {
  return ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function buildPdf(title: string, lines: PdfLine[]): Buffer {
  // --- paginate: build content streams per page -----------------------------
  const pages: string[][] = [];
  let current: string[] = [];
  let y = PAGE_H - MARGIN;

  const ensureRoom = (needed: number) => {
    if (y - needed < MARGIN) {
      pages.push(current);
      current = [];
      y = PAGE_H - MARGIN;
    }
  };

  // title banner on the first page
  current.push(`BT /F2 14 Tf ${MARGIN} ${y} Td (${esc(title)}) Tj ET`);
  y -= 22;

  for (const l of lines) {
    const size = l.size ?? 9;
    const lead = size + 3;
    ensureRoom(lead + (l.gapAfter ?? 0));
    const font = l.bold ? '/F2' : '/F1';
    current.push(`BT ${font} ${size} Tf ${MARGIN} ${y} Td (${esc(l.text)}) Tj ET`);
    y -= lead + (l.gapAfter ?? 0);
  }
  pages.push(current);

  // --- assemble the PDF objects ---------------------------------------------
  const objects: string[] = [];
  const pageCount = pages.length;

  // 1: catalog, 2: pages tree, 3..(2+n): page objects, then font F1, font F2, content streams
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pageCount} >>`
  );
  for (let i = 0; i < pageCount; i++) {
    const contentId = 3 + pageCount + 2 + i;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${3 + pageCount} 0 R /F2 ${3 + pageCount + 1} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`
    );
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  for (const stream of pages) {
    const body = stream.join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, 'latin1');
  const count = objects.length + 1;
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
