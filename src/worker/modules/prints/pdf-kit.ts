import { setCharacterSpacing } from 'pdf-lib';
import { drawable, runs } from './pdf-fonts.ts';
import { PenBase, PT, type TextStyle } from './pdf-pen.ts';

export { type Box, COLORS, PT, type TextStyle } from './pdf-pen.ts';

/** The drawing pen: shapes and images from `PenBase`, and text laid out in millimetres. */
export class Pen extends PenBase {
  private raw(text: string, st: TextStyle): string {
    return drawable(this.fonts[st.font], st.upper ? text.toUpperCase() : text, this.state);
  }

  /** Width of one line in mm. */
  measure(text: string, st: TextStyle): number {
    const s = this.raw(text, st);
    const face = this.fonts[st.font];
    const wide = runs(face, s).reduce(
      (w, r) => w + r.font.widthOfTextAtSize(r.text, st.size * PT),
      0,
    );
    return wide / PT + (st.ls ?? 0) * st.size * [...s].length;
  }

  lineHeight(st: TextStyle): number {
    return (st.lh ?? 1.3) * st.size;
  }

  /** Draws one line with its line box top at `top`. Returns its width. */
  text(
    text: string,
    x: number,
    top: number,
    st: TextStyle,
    align: 'left' | 'center' | 'right' = 'left',
    boxW = 0,
  ): number {
    const s = this.raw(text, st);
    if (!s) return 0;
    const face = this.fonts[st.font];
    const width = this.measure(text, st);
    const left =
      align === 'left' ? x : align === 'center' ? x + (boxW - width) / 2 : x + boxW - width;
    const lineH = this.lineHeight(st);
    const baseline =
      top + (lineH - (face.ascent + face.descent) * st.size) / 2 + face.ascent * st.size;
    this.save(
      () => {
        let at = left;
        for (const r of runs(face, s)) {
          this.page.drawText(r.text, {
            x: this.px(at),
            y: this.py(baseline),
            size: st.size * PT,
            font: r.font,
            color: this.color(st.color),
          });
          at +=
            r.font.widthOfTextAtSize(r.text, st.size * PT) / PT +
            (st.ls ?? 0) * st.size * [...r.text].length;
        }
      },
      ...(st.ls ? [setCharacterSpacing(st.ls * st.size * PT)] : []),
    );
    return width;
  }

  /** Lines of `text` that fit `w`; a fuller text ends its last line with an ellipsis. */
  wrap(text: string, w: number, st: TextStyle, maxLines = 99): string[] {
    const words = this.raw(text, st).split(' ').filter(Boolean);
    const lines: string[] = [];
    let line = '';
    const fits = (s: string) => this.measure(s, { ...st, upper: false }) <= w + 0.01;
    for (let word of words) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // A word wider than the line is cut at the character that overflows.
      while (!fits(word) && word.length > 1) {
        let n = word.length - 1;
        while (n > 1 && !fits(word.slice(0, n))) n--;
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    if (line) lines.push(line);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1] ?? '';
    while (last.length > 1 && !fits(`${last}…`)) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    return kept;
  }

  /** Draws wrapped text from `top`. Returns the height used. */
  para(
    text: string,
    x: number,
    top: number,
    w: number,
    st: TextStyle,
    options: { maxLines?: number; align?: 'left' | 'center' | 'right' } = {},
  ): number {
    const lines = this.wrap(text, w, st, options.maxLines);
    const lh = this.lineHeight(st);
    for (const [i, l] of lines.entries())
      this.text(l, x, top + i * lh, { ...st, upper: false }, options.align ?? 'left', w);
    return lines.length * lh;
  }

  /** Height `para` would use. */
  paraHeight(text: string, w: number, st: TextStyle, maxLines?: number): number {
    return this.wrap(text, w, st, maxLines).length * this.lineHeight(st);
  }

  /** The baseline of a line of `st` whose line box starts at `top`. */
  baselineOf(st: TextStyle, top: number): number {
    const face = this.fonts[st.font];
    return (
      top +
      (this.lineHeight(st) - (face.ascent + face.descent) * st.size) / 2 +
      face.ascent * st.size
    );
  }

  /** The line-box top that puts a line of `st` on the baseline `baseline`. */
  topFor(st: TextStyle, baseline: number): number {
    const face = this.fonts[st.font];
    return (
      baseline -
      ((this.lineHeight(st) - (face.ascent + face.descent) * st.size) / 2 + face.ascent * st.size)
    );
  }

  /** A label in its own style, then `text` wrapping under it on the same baseline. Returns the height. */
  labelled(
    label: string,
    labelSt: TextStyle,
    text: string,
    st: TextStyle,
    x: number,
    top: number,
    w: number,
    maxLines = 99,
  ): number {
    const gap = this.measure('i', st) + 0.4;
    const lw = this.measure(label, labelSt) + gap;
    const lh = this.lineHeight(st);
    const baseline = this.baselineOf(st, top);
    this.text(label, x, this.topFor(labelSt, baseline), labelSt);
    const first = this.wrap(text, w - lw, st, 1)[0] ?? '';
    const used = first.endsWith('…') ? text.length : first.length;
    const rest = text.slice(used).trim();
    this.text(first, x + lw, top, st);
    if (!rest || maxLines < 2) return lh;
    return lh + this.para(rest, x, top + lh, w, st, { maxLines: maxLines - 1 });
  }
}
