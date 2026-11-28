import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../lib/test-utils.tsx';
import { TOPICS } from '../../ui/webhook-setup/test-support.test-support.tsx';
import { ProviderStrip } from './provider-panel.tsx';

const strip = (head?: string) =>
  render(
    <ProviderStrip
      url="https://h.example/hooks"
      topics={TOPICS}
      seen={[]}
      verified={false}
      head={head}
    />,
  );

describe('ProviderStrip', () => {
  it('counts topics while the panel simply waits', () => {
    strip('Listening · nothing yet');
    expect(screen.getByText(/Listening · 0 of \d seen/)).toBeInTheDocument();
  });

  it.each(['Paused listening', "Couldn't check for deliveries", 'Nothing arrived yet'])(
    'says %s, as the panel does',
    (head) => {
      strip(head);
      expect(screen.getByText(head)).toBeInTheDocument();
      expect(screen.queryByText(/0 of \d seen/)).toBeNull();
    },
  );
});
