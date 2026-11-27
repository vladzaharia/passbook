import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const wb = join(import.meta.dirname, '..');
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.(tsx?|css)$/.test(e.name) && !/\.test\./.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe('the docs site stylesheets stay out of the Workbench', () => {
  it('no tool imports the compiled operation kit or the docs tray styles: their unscoped .hidden hid the sidebar', () => {
    const offenders = sources(wb).filter((f) =>
      /operations-kit\.css|dev-operations\.css|operations-kit-layer/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
