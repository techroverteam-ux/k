/** QR code drawn with react-native-svg (no native module). Used for the company's UPI ID on Pay fees. */
import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
// The core encoder only (pure JS, no canvas / fs), so it bundles cleanly in React Native.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCore: { create(text: string, opts?: { errorCorrectionLevel?: string }): { modules: { size: number; data: Uint8Array } } } = require('qrcode/lib/core/qrcode');

export function QR({ value, size = 200 }: { value: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const m = QRCore.create(value, { errorCorrectionLevel: 'M' }).modules;
    let d = '';
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.data[y * m.size + x]) d += `M${x + 2} ${y + 2}h1v1h-1z`;
    return { path: d, n: m.size + 4 };
  }, [value]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} accessibilityLabel="UPI QR code">
      <Rect width={n} height={n} fill="#fff" />
      <Path d={path} fill="#000" />
    </Svg>
  );
}

/** Standard UPI payment link (NPCI): any UPI app can open or scan it. */
export const upiLink = (upiId: string, name: string, note = 'Course fee') =>
  `upi://pay?pa=${encodeURIComponent(upiId).replace(/%40/g, '@')}&pn=${encodeURIComponent(name)}&cu=INR&tn=${encodeURIComponent(note)}`;
