/**
 * Physical key to US-layout character. Readers send HID usages for a US keyboard, so mapping
 * `event.code` recovers what they meant whatever layout the iPad has set (AC 2.4).
 */

const LETTER = /^Key([A-Z])$/;
const DIGIT = /^(?:Digit|Numpad)([0-9])$/;

const SHIFTED_DIGIT = ')!@#$%^&*(';

/** code -> [plain, shifted] */
const PUNCT: Record<string, readonly [string, string]> = {
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Backquote: ['`', '~'],
  Space: [' ', ' '],
  NumpadDecimal: ['.', '.'],
  NumpadSubtract: ['-', '-'],
  NumpadAdd: ['+', '+'],
  NumpadMultiply: ['*', '*'],
  NumpadDivide: ['/', '/'],
};

/** The character a physical key types on a US layout, or null when it is not a character key. */
export function charOf(code: string, shift: boolean): string | null {
  const letter = LETTER.exec(code);
  if (letter) {
    const ch = letter[1] as string;
    return shift ? ch : ch.toLowerCase();
  }
  const digit = DIGIT.exec(code);
  if (digit) {
    const n = Number(digit[1]);
    return shift && code.startsWith('Digit') ? (SHIFTED_DIGIT[n] as string) : String(n);
  }
  const punct = PUNCT[code];
  return punct ? (shift ? punct[1] : punct[0]) : null;
}

/** For virtual HID stacks that leave `event.code` empty: only a single character counts. */
export function fromKey(key: string): string | null {
  return [...key].length === 1 ? key : null;
}

/** The alphabet of scan codes. Anything else through the `key` fallback suggests another layout. */
export const isAllowedChar = (ch: string): boolean => /^[A-Za-z0-9\-_.:/]$/.test(ch);
