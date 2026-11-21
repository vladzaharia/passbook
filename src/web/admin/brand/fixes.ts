import type { PassSetup, SetupCheck } from '@/shared/contracts/pass-setup.ts';
import type { Draft } from './draft.ts';
import { shownValues } from './draft.ts';
import { fixAccent, fixPassColors } from './palette.ts';

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);

function reveal(el: HTMLElement | null) {
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el?.focus({ preventScroll: true });
}

/** Opens a channel row by its toggle, so its Apple ID or account part shows. */
function openChannel(channel: string) {
  const toggle = $(`[data-channel="${channel}"] button[aria-expanded]`);
  if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
  reveal(toggle);
}

export interface FixContext {
  view: PassSetup;
  draft: Draft;
  edit: (patch: Partial<Draft>) => void;
  /** Opens a template in the console. */
  openTemplate: (id: string) => void;
}

/**
 * Runs a check's fix where the page already is: a file picker, a palette, a field, a switch, or
 * the row that holds the control. The server names the action; this maps it to a control.
 */
export function runFix(check: SetupCheck, { view, draft, edit, openTemplate }: FixContext) {
  const v = shownValues(view, draft);
  switch (check.fix.action) {
    case 'upload_logo':
    case 'upload_icon': {
      const slot = check.fix.action === 'upload_logo' ? 'logo' : 'icon';
      const tile = $(`[data-asset-slot="${slot}"]`);
      tile?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      tile?.querySelector<HTMLInputElement>('input[type="file"]')?.click();
      return;
    }
    case 'use_logo_colors': {
      const chip = $('#brand fieldset button[aria-pressed]');
      if (chip) chip.click();
      else reveal($('#brand input[placeholder]'));
      return;
    }
    case 'edit_colors':
      reveal($('#brand [data-field] input:not([type="color"]):not([type="file"])'));
      return;
    case 'fix_contrast':
      edit(fixPassColors(v.background, v.foreground, v.label));
      return;
    case 'fix_accent':
      edit({ accent: fixAccent(v.accent || '#0f766e') });
      return;
    case 'edit_support':
      reveal($('[data-focus="support"]'));
      return;
    case 'allow_channel':
      if (check.fix.target)
        edit({ channels: { ...draft.channels, [check.fix.target]: 'allowed' } });
      return;
    case 'review_template': {
      const id = check.templateIds?.[0] ?? check.fix.target;
      if (id) openTemplate(id);
      return;
    }
    case 'setup_wallet_account':
      openChannel(check.fix.target ?? check.channel ?? 'google');
      return;
    default:
      openChannel('apple');
  }
}
