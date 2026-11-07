/**
 * From boxes to text a model can read: words on the same row are joined with spaces (wide gaps become
 * two spaces, which keeps columns apart), rows are ordered top to bottom.
 */
import type { OcrBox, OcrResult } from './types';

export interface TextLine {
  text: string;
  y: number;
  h: number;
  boxes: OcrBox[];
}

export function linesOf(boxes: OcrBox[]): TextLine[] {
  const sorted = [...boxes].filter((b) => b.text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextLine[] = [];
  for (const b of sorted) {
    const cy = b.y + b.h / 2;
    const line = lines.find((l) => cy >= l.y - l.h * 0.2 && cy <= l.y + l.h * 1.2);
    if (line) {
      line.boxes.push(b);
      const top = Math.min(line.y, b.y);
      const bottom = Math.max(line.y + line.h, b.y + b.h);
      line.y = top;
      line.h = bottom - top;
    } else lines.push({ text: '', y: b.y, h: b.h, boxes: [b] });
  }
  for (const l of lines) {
    l.boxes.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = -1;
    for (const b of l.boxes) {
      if (prevEnd >= 0) text += b.x - prevEnd > l.h * 1.5 ? '  ' : ' ';
      text += b.text.trim();
      prevEnd = b.x + b.w;
    }
    l.text = text;
  }
  return lines.sort((a, b) => a.y - b.y);
}

export const layoutText = (r: Pick<OcrResult, 'boxes'>): string =>
  linesOf(r.boxes)
    .map((l) => l.text)
    .join('\n');

/** Average word confidence, weighted by length. */
export function meanConfidence(boxes: OcrBox[]): number {
  let n = 0;
  let sum = 0;
  for (const b of boxes) {
    const w = b.text.trim().length;
    n += w;
    sum += w * b.confidence;
  }
  return n ? sum / n : 0;
}
