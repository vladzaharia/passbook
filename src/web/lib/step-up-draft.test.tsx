import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreDraft, saveDraft } from './step-up-draft.ts';

function Form() {
  const [slug, setSlug] = useState('');
  const [secret, setSecret] = useState('');
  return (
    <form>
      <input
        aria-label="Organization slug"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
      />
      <input
        aria-label="Webhook secret"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
    </form>
  );
}

afterEach(() => sessionStorage.clear());

describe('step-up draft', () => {
  it('puts typed fields back into a controlled form once, and never keeps a credential field', async () => {
    const first = render(<Form />);
    const slug = screen.getByLabelText('Organization slug') as HTMLInputElement;
    const secret = screen.getByLabelText('Webhook secret') as HTMLInputElement;
    // Typing, as the browser does it.
    for (const [el, value] of [
      [slug, 'henrys'],
      [secret, 'whsec_1'],
    ] as const) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    saveDraft('/admin/o/o1/settings');
    expect(sessionStorage.getItem('passbook:step-up:/admin/o/o1/settings')).not.toContain('whsec');
    first.unmount();

    render(<Form />);
    restoreDraft('/admin/o/o1/settings');
    await waitFor(() =>
      expect((screen.getByLabelText('Organization slug') as HTMLInputElement).value).toBe('henrys'),
    );
    expect((screen.getByLabelText('Webhook secret') as HTMLInputElement).value).toBe('');
    // Once: the draft is gone.
    expect(sessionStorage.getItem('passbook:step-up:/admin/o/o1/settings')).toBeNull();
  });

  it('keeps nothing for another route', () => {
    render(<Form />);
    restoreDraft('/elsewhere');
    expect((screen.getByLabelText('Organization slug') as HTMLInputElement).value).toBe('');
  });
});
