import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import { installDomShims } from '../../../lib/test-utils.tsx';
import { sessionFixture } from '../../boot/session.test-support.ts';
import { TopBar } from './top-bar.tsx';

installDomShims();

const counts = { today: 7, event: null, place: null } as unknown as ScanCounts;
const chip = { open: true, text: 'Open', sub: null };

function bar(chips: React.ReactNode) {
  render(
    <TopBar
      session={sessionFixture({})}
      chip={chip}
      counts={counts}
      logoUrl={null}
      modeLabel="Operator"
      chips={chips}
      menu={null}
      testing={null}
      onStaff={() => undefined}
    />,
  );
}

describe('TopBar count', () => {
  it('shows Today once when the device chip already carries it', () => {
    bar(<span>Today 7</span>);
    expect(screen.getAllByText(/Today/)).toHaveLength(1);
    expect(screen.queryByTestId('op-in-now')).toBeNull();
  });

  it('shows the Today count itself when no device chip does', () => {
    bar(null);
    expect(screen.getByTestId('op-in-now')).toHaveTextContent('Today');
  });
});
