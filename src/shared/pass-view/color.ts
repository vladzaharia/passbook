export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Wallet documents `rgb(r, g, b)`; hex is accepted because generators emit it. */
export function parseColor(input: unknown): Rgb | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input.trim();
  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(
      s,
    );
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    return r > 255 || g > 255 || b > 255 ? undefined : { r, g, b };
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const raw = hex[1] as string;
    const h = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    };
  }
  return undefined;
}

export const css = ({ r, g, b }: Rgb) => `rgb(${r}, ${g}, ${b})`;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return { r: m(a.r, b.r), g: m(a.g, b.g), b: m(a.b, b.b) };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export interface ColorInput {
  backgroundColor?: unknown;
  foregroundColor?: unknown;
  labelColor?: unknown;
  stripColor?: unknown;
  footerBackgroundColor?: unknown;
}

export function resolveColors(pass: ColorInput) {
  const bg = parseColor(pass.backgroundColor) ?? WHITE;
  const dark = luminance(bg) < 0.4;
  let fg = parseColor(pass.foregroundColor) ?? (dark ? WHITE : BLACK);
  // An unreadable pair is a pass bug; Wallet would still draw it, we keep it legible.
  if (contrast(fg, bg) < 3) fg = dark ? WHITE : BLACK;
  const labelIn = parseColor(pass.labelColor);
  const label = labelIn && contrast(labelIn, bg) >= 2 ? labelIn : mix(fg, bg, 0.35);
  const strip = parseColor(pass.stripColor);
  const footer = parseColor(pass.footerBackgroundColor);
  return {
    background: css(bg),
    foreground: css(fg),
    label: css(label),
    ...(strip ? { strip: css(strip) } : {}),
    ...(footer ? { footerBackground: css(footer) } : {}),
    dark,
  };
}
