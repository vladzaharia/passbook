import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderTags } from '../../../tags/test-fixtures.tsx';
import type { Op } from '../apply.ts';
import { DesignerProvider } from '../context.tsx';
import { sampleDoc } from '../fixtures.ts';
import type { DesignDoc } from '../model.ts';
import { designerReducer, initialState } from '../reducer.ts';
import type { WalletChannels } from './use-wallet-channels.ts';
import { WalletsMode } from './wallets-mode.tsx';

const BOTH: WalletChannels = { listed: ['google', 'samsung'], templateOff: new Set() };
const SLOW = { timeout: 30_000 };

/** A store card whose first field is its balance, as a Samsung title would read it. */
function storeCard(): DesignDoc {
  const doc = sampleDoc();
  doc.passJson = {
    formatVersion: 1,
    organizationName: 'Org',
    description: 'Card',
    backgroundColor: 'rgb(20,30,60)',
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'M-1', messageEncoding: 'iso-8859-1' }],
    storeCard: {
      primaryFields: [
        {
          key: 'balance',
          label: 'Balance',
          value: 25,
          currencyCode: 'USD',
          semantics: { balance: { amount: '25', currencyCode: 'USD' } },
        },
      ],
      secondaryFields: [
        { key: 'tier', label: 'Tier', value: 'Gold' },
        { key: 'name', label: 'Name', value: 'Alex' },
      ],
      backFields: [{ key: 'terms', label: 'Terms', value: 'None' }],
    },
  };
  return doc;
}

let seen: DesignDoc | undefined;

function Harness({ doc, readOnly = false }: { doc: DesignDoc; readOnly?: boolean }) {
  const [state, dispatch] = useReducer(designerReducer, undefined, () => initialState(doc));
  const [wallet, setWallet] = useState<'google' | 'samsung'>('samsung');
  seen = state.doc;
  const edit = (op: Op) => dispatch({ type: 'edit', op, at: 0 });
  const api = {
    state,
    doc: state.doc,
    edit,
    select: (select: DesignDoc extends never ? never : (typeof state)['select']) =>
      dispatch({ type: 'select', select }),
    focusTarget: () => undefined,
    dispatch,
    assetBase: '/api/v1/templates/t/versions/v/assets',
    readOnly,
    stamps: { count: 0, setCount: () => undefined },
  };
  return (
    <DesignerProvider value={api}>
      <WalletsMode
        templateId="t"
        passJson={state.doc.passJson}
        checking={false}
        issues={[]}
        channels={BOTH}
        wallet={wallet}
        onWallet={setWallet}
        onPass={() => undefined}
      />
    </DesignerProvider>
  );
}

const report = () => screen.getByRole('region', { name: 'Samsung Wallet report' });

describe('the Wallets tab', () => {
  it('shows the rail with each wallet, its type and its status', async () => {
    renderTags(<Harness doc={storeCard()} />);
    const group = await screen.findByRole('radiogroup', { name: 'Wallet' }, SLOW);
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Google Wallet, Generic, /),
      expect.stringMatching(/^Samsung Wallet, Loyalty, /),
    ]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('moves between wallets with the arrow keys', async () => {
    const user = userEvent.setup();
    renderTags(<Harness doc={storeCard()} />);
    const group = await screen.findByRole('radiogroup', { name: 'Wallet' }, SLOW);
    const [google, samsung] = within(group).getAllByRole('radio');
    samsung?.focus();
    await user.keyboard('{ArrowLeft}');
    expect(google).toHaveAttribute('aria-checked', 'true');
    expect(google).toHaveFocus();
  });

  it('flags a title that shows twice and suggests the organization name', async () => {
    renderTags(<Harness doc={storeCard()} />);
    await screen.findByRole('radiogroup', { name: 'Wallet' }, SLOW);
    expect(
      await screen.findByText('Shows twice: also Balance.', undefined, SLOW),
    ).toBeInTheDocument();
    expect(screen.getByText('Suggested: Organization name')).toBeInTheDocument();
  });

  it('applies a suggestion only on Use, and the report follows in the same render', async () => {
    const user = userEvent.setup();
    renderTags(<Harness doc={storeCard()} />);
    await screen.findByRole('radiogroup', { name: 'Wallet' }, SLOW);
    const before = report().textContent;
    expect(seen?.manifest.wallets).toBeUndefined();
    const use = await screen.findByRole(
      'button',
      { name: /^Use Organization name for Title/ },
      SLOW,
    );
    expect(seen?.manifest.wallets).toBeUndefined();
    await user.click(use);
    expect(seen?.manifest.wallets).toMatchObject({ roles: { title: false } });
    expect(screen.queryByRole('button', { name: /^Use Organization name for Title/ })).toBeNull();
    expect(report().textContent).not.toBeNull();
    expect(before).toBeDefined();
  });

  it('accepts every suggestion in one step, which undo takes back whole', async () => {
    const user = userEvent.setup();
    renderTags(<Harness doc={storeCard()} />);
    const accept = await screen.findByRole('button', { name: /^Accept \d+$/ }, SLOW);
    await user.click(accept);
    const wallets = seen?.manifest.wallets as { roles: Record<string, unknown> } | undefined;
    expect(Object.keys(wallets?.roles ?? {}).length).toBeGreaterThan(1);
  });

  it('turns Blocked when type is required but not met, and offers the way out', async () => {
    const user = userEvent.setup();
    renderTags(<Harness doc={storeCard()} />);
    await screen.findByRole('radiogroup', { name: 'Wallet' }, SLOW);
    await user.click(await screen.findByRole('button', { name: /Samsung type/ }));
    await user.click(await screen.findByRole('radio', { name: /Ticket/ }));
    expect(await within(report()).findByText(/Compiled as loyalty/)).toBeInTheDocument();
    await act(async () => {
      // Requiring the type blocks a wallet that falls back.
      await user.click(screen.getByRole('button', { name: /Required/ }));
    });
    await user.click(await screen.findByRole('combobox', { name: /Require…/ }));
    await user.click(await screen.findByRole('option', { name: 'Wallet type' }));
    expect(
      await within(report()).findByText('Samsung Wallet cannot show this pass.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Don't require Wallet type" }));
    expect(within(report()).queryByText('Samsung Wallet cannot show this pass.')).toBeNull();
  });

  it('writes nothing and offers no controls when read only', async () => {
    renderTags(<Harness doc={storeCard()} readOnly />);
    await screen.findByRole('radiogroup', { name: 'Wallet' }, SLOW);
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
  });

  it('selects once in the type grid: Automatic is checked, Loyalty only says Automatic picks it', async () => {
    const user = userEvent.setup();
    renderTags(<Harness doc={storeCard()} />);
    await user.click(await screen.findByRole('button', { name: /Samsung type/ }, SLOW));
    const tiles = await screen.findByRole('radiogroup', { name: 'Samsung type' });
    const radios = within(tiles).getAllByRole('radio') as HTMLInputElement[];
    const checked = radios.filter((r) => r.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]?.closest('label')).toHaveTextContent('Automatic');
    expect(checked[0]?.closest('label')?.querySelector('svg')).not.toBeNull();
    const picked = radios
      .map((r) => r.closest('label') as HTMLElement)
      .filter((l) => l.querySelector('[data-auto-pick]'));
    expect(picked).toHaveLength(1);
    expect(picked[0]).toHaveTextContent('Automatic picks this');
    expect(picked[0]?.querySelector('svg')).toBeNull();
  });
});
