/** A UPI payment QR on screen (prompt 43), drawn as vectors so it stays sharp at any size. */
import { qrMatrix } from '@gst/print';
import { useMemo } from 'react';

export function UpiQr({ link, size = 220, label }: { link: string; size?: number; label: string }) {
  const m = useMemo(() => qrMatrix(link, 'M'), [link]);
  const cell = size / (m.size + 8);
  const path = useMemo(() => {
    const parts: string[] = [];
    for (let y = 0; y < m.size; y++)
      for (let x = 0; x < m.size; x++)
        if (m.dark[y * m.size + x])
          parts.push(`M${(x + 4) * cell} ${(y + 4) * cell}h${cell}v${cell}h-${cell}z`);
    return parts.join('');
  }, [m, cell]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      data-testid="upi-qr"
      className="rounded-md bg-white"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
