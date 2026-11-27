import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CONNECTOR } from '../passes/test-fixtures.ts';
import { WizardAside } from './wizard-review.tsx';

const webhook = { ...CONNECTOR, type: 'webhook-push', displayName: 'Webhook push' } as never;
const glyph = (c: HTMLElement) => c.querySelector('svg')?.getAttribute('class') ?? '';

describe('WizardAside', () => {
  it("shows the sender's tile glyph, not the webhook one", () => {
    const sender = { id: 'stripe-subscriptions', label: 'Stripe subscriptions' };
    const { container } = render(
      <WizardAside connector={webhook} sender={sender as never} sample={[]} step={0} />,
    );
    expect(glyph(container)).toContain('lucide-repeat');
  });

  it('keeps the connector glyph without a sender', () => {
    const { container } = render(<WizardAside connector={webhook} sample={[]} step={0} />);
    expect(glyph(container)).toContain('lucide-webhook');
  });
});
