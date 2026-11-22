import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTilt, type TiltStage } from './tilt.ts';

function setup(media: { fine?: boolean; coarse?: boolean; reduced?: boolean }) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduce')
      ? !!media.reduced
      : q.includes('hover')
        ? !!media.fine
        : !!media.coarse,
  }));
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn();
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const handlers = new Map<string, (e: never) => void>();
  const props: Record<string, string> = {};
  const stage: TiltStage = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    style: {
      setProperty: (n, v) => {
        props[n] = v;
      },
    },
    dataset: {},
    addEventListener: (t, fn) => void handlers.set(t, fn),
    removeEventListener: (t) => void handlers.delete(t),
  };
  const fire = (type: string, e: object = {}) => handlers.get(type)?.(e as never);
  return { stage, handlers, props, fire };
}

afterEach(() => vi.unstubAllGlobals());

describe('bindTilt', () => {
  it('does nothing under reduced motion or without a pointer', () => {
    const a = setup({ fine: true, reduced: true });
    bindTilt(a.stage)();
    expect(a.handlers.size).toBe(0);
    const b = setup({});
    bindTilt(b.stage)();
    expect(b.handlers.size).toBe(0);
  });

  it('follows a fine pointer, clamped, and resets on leave', () => {
    const t = setup({ fine: true });
    const unbind = bindTilt(t.stage);
    t.fire('pointerenter');
    expect(t.stage.dataset.tracking).toBe('');
    t.fire('pointermove', { clientX: 100, clientY: 0 });
    expect(t.props['--px']).toBe('0.500');
    expect(t.props['--py']).toBe('-0.500');
    t.fire('pointerleave');
    expect(t.props['--px']).toBe('0');
    expect('tracking' in t.stage.dataset).toBe(false);
    unbind();
    expect(t.handlers.size).toBe(0);
  });

  it('tilts a touch while pressed and hands a vertical move to scrolling', () => {
    const t = setup({ coarse: true });
    bindTilt(t.stage);
    t.fire('pointerdown', { pointerType: 'mouse', clientX: 0, clientY: 0 });
    expect(t.stage.dataset.press).toBeUndefined();
    t.fire('pointerdown', { pointerType: 'touch', clientX: 50, clientY: 50 });
    expect(t.stage.dataset.press).toBe('');
    t.fire('pointermove', { pointerType: 'touch', clientX: 60, clientY: 52 });
    expect(t.props['--px']).toBe('0.100');
    t.fire('pointermove', { pointerType: 'touch', clientX: 60, clientY: 70 });
    expect(t.props['--px']).toBe('0');
    expect(t.stage.dataset.press).toBeUndefined();
    t.fire('pointermove', { pointerType: 'touch', clientX: 10, clientY: 10 });
    expect(t.props['--px']).toBe('0');
  });
});
