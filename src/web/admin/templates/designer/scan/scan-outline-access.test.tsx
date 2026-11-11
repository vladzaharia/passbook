import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixture, setup } from './scan-outline-test-fixtures.ts';

describe('scan screen outline access preset', () => {
  it('does not map private or barcode-bound inputs into Access, or render their sample values', async () => {
    const user = userEvent.setup();
    const doc = fixture();
    doc.manifest.inputs = {
      type: 'object',
      properties: {
        lounge: { type: 'boolean', 'x-label': 'Lounge' },
        safeLounge: { type: 'boolean', 'x-label': 'Safe lounge' },
        emailAccess: { type: 'boolean', 'x-scan': 'door' },
        privateAccess: { type: 'boolean', 'x-scan': 'desk' },
      },
    };
    doc.manifest.bindings = [{ to: { barcode: 0, prop: 'message' }, value: '{{lounge}}' }];
    doc.manifest.sample = {
      lounge: true,
      safeLounge: true,
      emailAccess: true,
      privateAccess: true,
      email: 'hidden@example.com',
      code: 'super-secret-code',
    };
    const view = setup(doc, null);
    await user.click(screen.getByRole('radio', { name: /Access/ }));
    await user.click(screen.getByRole('button', { name: 'Add Access' }));
    const panel = view.latest()?.panels?.at(-1);
    expect(panel?.rows[0]).toMatchObject({
      type: 'list',
      items: [{ when: { path: 'inputs.safeLounge', eq: true } }],
    });
    expect(view.container).not.toHaveTextContent('hidden@example.com');
    expect(view.container).not.toHaveTextContent('super-secret-code');
    expect(view.container).not.toHaveTextContent('M-1');
  });
});
