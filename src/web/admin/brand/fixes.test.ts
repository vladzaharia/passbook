import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetupCheck } from '@/shared/contracts/pass-setup.ts';
import { newOrgFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { runFix } from './fixes.ts';

const view = viewOf(newOrgFacts());
const check = (fix: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({
    code: 'X',
    level: 'warn',
    area: 'brand',
    message: 'm',
    fix,
    ...over,
  }) as unknown as SetupCheck;

function ctx() {
  return { view, draft: {}, edit: vi.fn(), openTemplate: vi.fn() };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('runFix', () => {
  it('opens the file picker of the missing logo', () => {
    document.body.innerHTML = '<div data-asset-slot="logo"><input type="file" /></div>';
    const input = document.querySelector<HTMLInputElement>('input')!;
    const click = vi.spyOn(input, 'click');
    const tile = document.querySelector<HTMLElement>('[data-asset-slot]')!;
    tile.scrollIntoView = vi.fn();
    runFix(check({ action: 'upload_logo' }), ctx());
    expect(click).toHaveBeenCalled();
  });

  it('presses the first logo colour, else focuses the colour field', () => {
    document.body.innerHTML =
      '<div id="brand"><fieldset><button aria-pressed="false"></button></fieldset></div>';
    const chip = document.querySelector<HTMLButtonElement>('button')!;
    const click = vi.spyOn(chip, 'click');
    runFix(check({ action: 'use_logo_colors' }), ctx());
    expect(click).toHaveBeenCalled();
    document.body.innerHTML = '<div id="brand"><input placeholder="#000000" /></div>';
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.scrollIntoView = vi.fn();
    const focus = vi.spyOn(input, 'focus');
    runFix(check({ action: 'use_logo_colors' }), ctx());
    expect(focus).toHaveBeenCalled();
  });

  it('focuses a colour or support field', () => {
    document.body.innerHTML =
      '<div id="brand"><div data-field><input /></div></div><input data-focus="support" />';
    for (const el of document.querySelectorAll<HTMLElement>('input')) el.scrollIntoView = vi.fn();
    const colour = vi.spyOn(document.querySelector<HTMLElement>('[data-field] input')!, 'focus');
    runFix(check({ action: 'edit_colors' }), ctx());
    expect(colour).toHaveBeenCalled();
    const support = vi.spyOn(document.querySelector<HTMLElement>('[data-focus]')!, 'focus');
    runFix(check({ action: 'edit_support' }), ctx());
    expect(support).toHaveBeenCalled();
  });

  it('edits the draft for contrast, accent and an allowed channel', () => {
    const c = ctx();
    runFix(check({ action: 'fix_contrast' }), c);
    runFix(check({ action: 'fix_accent' }), c);
    runFix(check({ action: 'allow_channel', target: 'google' }), c);
    runFix(check({ action: 'allow_channel' }), c);
    expect(c.edit).toHaveBeenCalledTimes(3);
    expect(c.edit).toHaveBeenLastCalledWith({ channels: { google: 'allowed' } });
  });

  it('opens the first template to review', () => {
    const c = ctx();
    runFix(check({ action: 'review_template' }, { templateIds: ['t1', 't2'] }), c);
    runFix(check({ action: 'review_template', target: 't3' }), c);
    runFix(check({ action: 'review_template' }), c);
    expect(c.openTemplate.mock.calls).toEqual([['t1'], ['t3']]);
  });

  it('opens a channel row, collapsed or not', () => {
    document.body.innerHTML =
      '<div data-channel="google"><button aria-expanded="false"></button></div><div data-channel="apple"><button aria-expanded="true"></button></div>';
    for (const b of document.querySelectorAll<HTMLElement>('button')) b.scrollIntoView = vi.fn();
    const google = document.querySelector<HTMLButtonElement>('[data-channel="google"] button')!;
    const click = vi.spyOn(google, 'click');
    runFix(check({ action: 'setup_wallet_account' }, { channel: 'google' }), ctx());
    expect(click).toHaveBeenCalled();
    const apple = document.querySelector<HTMLButtonElement>('[data-channel="apple"] button')!;
    const open = vi.spyOn(apple, 'click');
    runFix(check({ action: 'something_else' }), ctx());
    expect(open).not.toHaveBeenCalled();
  });
});
