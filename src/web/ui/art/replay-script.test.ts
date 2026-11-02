import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The auth and error pages' copy of useScene's click (public/buddy-replay.js), run as the page would.
const SCRIPT = readFileSync(join(process.cwd(), 'public/buddy-replay.js'), 'utf8');

function page(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (q: string) => ({ matches: reduce && q.includes('reduce'), media: q }) as MediaQueryList,
  );
  document.body.innerHTML =
    '<a href="#away"><div class="scene" aria-hidden="true"><span data-replay="" data-scene="hello"><svg data-art="wallet"><g data-part="w"><rect class="o" /></g></svg></span></div></a>';
  const parent = vi.fn();
  document.querySelector('a')?.addEventListener('click', parent);
  new Function(SCRIPT)();
  const host = document.querySelector('[data-replay]') as HTMLElement;
  const click = () => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.querySelector('rect')?.dispatchEvent(e);
    return e;
  };
  return { host, parent, click };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('buddy-replay.js', () => {
  it('restarts the scene on a click and keeps the click from the page', () => {
    const { host, parent, click } = page(false);
    expect(click().defaultPrevented).toBe(true);
    expect(host).toHaveAttribute('data-run');
    const flush = vi.spyOn(host, 'getBoundingClientRect');
    click();
    expect(flush).toHaveBeenCalledOnce();
    expect(host).toHaveAttribute('data-run');
    expect(parent).not.toHaveBeenCalled();
    expect(window.location.hash).not.toBe('#away');
  });

  it('does nothing under reduced motion, and still keeps the click', () => {
    const { host, parent, click } = page(true);
    expect(click().defaultPrevented).toBe(true);
    expect(host).not.toHaveAttribute('data-run');
    expect(parent).not.toHaveBeenCalled();
  });

  it('is a plain deferred script: no globals, no inline handlers, no network', () => {
    expect(SCRIPT.trim()).toMatch(/^\/\/[\s\S]*\(\(\) => \{[\s\S]*\}\)\(\);$/);
    expect(SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|innerHTML|eval\(/);
  });
});
