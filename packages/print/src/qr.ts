/** QR codes as a grid of dark squares, so they draw as vectors in the preview and the PDF (never a bitmap). */
import QRCode from 'qrcode';

export interface QrMatrix {
  size: number;
  /** Row-major; true is a dark module. */
  dark: boolean[];
}

export function qrMatrix(data: string, level: 'L' | 'M' | 'Q' = 'M'): QrMatrix {
  const q = QRCode.create(data, { errorCorrectionLevel: level });
  const size = q.modules.size;
  const dark: boolean[] = [];
  for (let i = 0; i < size * size; i++) dark.push(q.modules.data[i] === 1);
  return { size, dark };
}
