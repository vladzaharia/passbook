import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/web/workbench/bench/inspector.css`, 'utf8');

describe('the inspector nav buttons', () => {
  it('are at least 36 px (44 on touch), above the 24 px target-size floor', () => {
    expect(css).toMatch(/\.bench-insp-nav \.iconbtn \{[^}]*width: 36px;[^}]*height: 36px;/);
    expect(css).toMatch(
      /pointer: coarse\)[^{]*\{\s*\.bench-insp-nav \.iconbtn \{[^}]*width: 44px;/,
    );
  });
});
