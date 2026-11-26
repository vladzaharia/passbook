import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import { ActivityTray } from './activity-tray.tsx';

const state = vi.hoisted(() => ({ authed: undefined as unknown }));
vi.mock('../../lib/session.ts', () => ({ useSession: () => ({ authed: state.authed }) }));
vi.mock('./activity-tray-body.tsx', () => ({ default: () => <p>tray body</p> }));

beforeEach(() => {
  state.authed = undefined;
});

describe('ActivityTray', () => {
  it('draws nothing, and loads nothing, for a signed-out visitor', () => {
    const { container } = render(<ActivityTray />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mounts the shared tray for a signed-in person', async () => {
    state.authed = { user: { id: 'u' } };
    render(<ActivityTray />);
    expect(await screen.findByText('tray body')).toBeInTheDocument();
  });
});
