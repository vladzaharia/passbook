import { readFileSync, writeFileSync } from 'node:fs';
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from 'jsonc-parser';

/** wrangler.jsonc has comments and trailing commas; never JSON.parse it. */
export function parseJsonc<T = unknown>(text: string, file = 'jsonc'): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new Error(`${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
}

export function readJsonc<T = unknown>(path: string): T {
  return parseJsonc<T>(readFileSync(path, 'utf8'), path);
}

/** Sets a value at a path, preserving comments and formatting. */
export function setJsonc(text: string, path: (string | number)[], value: unknown): string {
  return applyEdits(
    text,
    modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  );
}

export function writeJsoncValue(file: string, path: (string | number)[], value: unknown): void {
  writeFileSync(file, setJsonc(readFileSync(file, 'utf8'), path, value));
}
