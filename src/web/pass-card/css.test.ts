import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./pass-card.css', import.meta.url), 'utf8');
const rule = (selector: string) =>
  css.match(new RegExp(`${selector.replace(/[[\]"().]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('pass-card.css', () => {
  it('lets the poster front grow so the code is never clipped', () => {
    const front = rule('.pc-root[data-poster][data-face="front"] .pc-card');
    expect(front).toContain('min-height');
    expect(front).toContain('aspect-ratio: auto');
  });

  it('keeps the poster back inside the card', () => {
    expect(rule('.pc-root[data-poster] .pc-back-body')).toContain('margin: 0');
  });

  it('styles disabled actions like links', () => {
    expect(css).toContain('.pc-card .pc-action {');
  });
});
