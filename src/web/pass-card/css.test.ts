import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = ['base', 'poster', 'text']
  .map((layer) => readFileSync(`src/web/pass-card/pass-card-${layer}.css`, 'utf8'))
  .join('\n');
const rule = (selector: string) =>
  css.match(new RegExp(`${selector.replace(/[[\]"().]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('pass-card.css', () => {
  it('lets the poster front grow so the code is never clipped', () => {
    const front = rule('.pc-root[data-poster][data-face="front"] .pc-card');
    expect(front).toContain('min-height');
    expect(front).toContain('aspect-ratio: auto');
  });

  it('gives the poster title its own row and lets labelled fields wrap by word', () => {
    expect(rule('.pc-poster-primary')).toContain('flex-direction: column');
    expect(rule('.pc-title')).toMatch(/overflow-wrap: break-word/);
    expect(rule('.pc-title')).toContain('line-clamp: 3');
    expect(rule('.pc-poster-primary .pc-primary')).toContain('flex-wrap: wrap');
    const field = rule(
      '.pc-root[data-face="front"] .pc-poster-primary .pc-primary .pc-field[data-fk]',
    );
    expect(field).toMatch(/flex: 1 1 calc\(var\(--u\) \* 84\)/);
    expect(field).toContain('min-width: 0');
    const value = rule(
      '.pc-root[data-face="front"] .pc-poster-primary .pc-primary .pc-field[data-fk] > .pc-value',
    );
    expect(value).toContain('white-space: normal');
    expect(value).toContain('line-clamp: 2');
    expect(css).not.toMatch(/\.pc-poster-primary[^{]*\{[^}]*white-space: nowrap/);
  });

  it('keeps the poster back inside the card', () => {
    expect(rule('.pc-root[data-poster] .pc-back-body')).toContain('margin: 0');
  });

  it('styles disabled actions like links', () => {
    expect(css).toContain('.pc-card .pc-action {');
  });
});
