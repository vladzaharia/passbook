/**
 * Conservative static check for a JSON Schema `pattern`: no backreferences, no lookaround, and no
 * repeated group that contains alternation or an unbounded repeat. Callers also bound the input
 * length, so remaining polynomial cost stays small.
 */
export const PATTERN_MAX_LENGTH = 200;
export const PATTERN_INPUT_MAX = 512;

interface Frame {
  alt: boolean;
  unbounded: boolean;
}

interface Quantifier {
  repeats: boolean;
  unbounded: boolean;
  end: number;
}

function quantifierAt(p: string, i: number): Quantifier | null {
  const c = p[i];
  if (c === '*' || c === '+') return { repeats: true, unbounded: true, end: i + 1 };
  if (c === '?') return { repeats: false, unbounded: false, end: i + 1 };
  if (c === '{') {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i));
    if (!m) return null;
    const min = Number(m[1]);
    const unbounded = m[2] === ',' && m[3] === '';
    const max = m[2] === ',' ? (m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3])) : min;
    return { repeats: max > 1, unbounded, end: i + m[0].length };
  }
  return null;
}

/** Whether the pattern can match input of any length cheaply, i.e. it needs no input bound. */
export function needsInputBound(pattern: string): boolean {
  return /[*+]|\{\d+,\}/.test(pattern.replace(/\\.|\[(?:\\.|[^\]\\])*\]/g, ''));
}

export function isSafePattern(pattern: string): boolean {
  if (pattern.length > PATTERN_MAX_LENGTH) return false;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return false;
  }
  const stack: Frame[] = [{ alt: false, unbounded: false }];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    const top = stack[stack.length - 1] as Frame;
    if (c === '\\') {
      const next = pattern[i + 1] ?? '';
      if (/[1-9k]/.test(next)) return false;
      i += 2;
    } else if (c === '[') {
      i++;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] !== ':') return false;
        i += 2;
      }
      stack.push({ alt: false, unbounded: false });
      i++;
    } else if (c === '|') {
      top.alt = true;
      i++;
    } else if (c === ')') {
      if (stack.length < 2) return false;
      const group = stack.pop() as Frame;
      const parent = stack[stack.length - 1] as Frame;
      const q = quantifierAt(pattern, i + 1);
      if (q?.repeats && (group.alt || group.unbounded)) return false;
      parent.unbounded ||= group.unbounded || (q?.unbounded ?? false);
      i = q ? q.end : i + 1;
    } else {
      const q = c === '*' || c === '+' || c === '?' || c === '{' ? quantifierAt(pattern, i) : null;
      if (q) {
        top.unbounded ||= q.unbounded;
        i = q.end;
      } else i++;
    }
  }
  return stack.length === 1;
}
