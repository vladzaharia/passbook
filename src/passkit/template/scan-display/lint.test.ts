import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;
const sources = readdirSync(dir).filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name));

/** The direction is isolated (R1): no React, no worker or web imports, no size, colour or motion. */
describe('scan-display lint', () => {
  it.each(sources)('%s is pure and holds no geometry', (name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from '(react|hono|cloudflare:|@)[^']*'/);
    expect(code).not.toMatch(/from '(\.\.\/)+(worker|web)\//);
    expect(code).not.toMatch(/\b\d+(\.\d+)?(px|rem|em|vh|vw|ms)\b/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
    expect(code).not.toMatch(/\b(animation|transition|duration-\d)/);
  });
});
