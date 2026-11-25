import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '@/web/lib/format.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { calls, renderTags } from '../../tags/test-fixtures.tsx';
import { TemplateChannelsPanel } from './channels-panel.tsx';

const on = { on: true, source: 'template' };
const effective = {
  mobile: on,
  apple: on,
  google: { on: false, source: 'template', reason: 'no_design' },
  samsung: { on: false, source: 'template', reason: 'no_design' },
  paper: { on: false, source: 'template', reason: 'template_off' },
  nfc: on,
};
const defaults = {
  mobile: 'on',
  apple: 'on',
  google: 'on',
  samsung: 'on',
  paper: 'off',
  nfc: 'on',
};
const chain = (stop?: { level: string; state: string; reason?: string }) =>
  ['passbook', 'plan', 'org', 'template'].map((level) => ({
    level,
    state: 'ok',
    canChange: level === 'template',
    ...(stop?.level === level ? stop : {}),
  }));
const levels = Object.fromEntries(Object.keys(effective).map((c) => [c, chain()]));
const noOverrides = Object.fromEntries(Object.keys(effective).map((c) => [c, 0]));
/** What every GET adds: the chain of each channel and the passes with their own choice. */
const extras = { levels, overrides: noOverrides, overridePasses: 0 };
const impact = (passes: number, cleared = 0) => [
  { channel: 'apple', passes, rotated: 0, clearedOverrides: cleared },
];
const win = (over: Record<string, unknown> = {}) => ({
  kind: 'event',
  id: 'e1',
  name: 'Gala',
  opensAt: 1_800_000_000_000,
  closesAt: 1_800_003_600_000,
  open: false,
  scheduled: true,
  ...over,
});
const handlers = (
  passes: number,
  cleared = 0,
  extra: {
    supported?: boolean;
    windows?: unknown[];
    runs?: unknown[];
    blocked?: unknown;
    allOff?: boolean;
    delayReplace?: number;
  } = {},
) => ({
  '/api/v1/templates/t1/channels/runs': () => json(extra.runs ?? []),
  '/api/v1/templates/t1/channels': async (_u: URL, init?: RequestInit) => {
    if (init?.method === 'PUT' && JSON.parse(String(init.body)).replaceCodes && extra.delayReplace)
      await new Promise((r) => setTimeout(r, extra.delayReplace));
    return init?.method === 'PUT'
      ? json({
          channels: null,
          revision: 1,
          effective,
          defaults,
          ...extras,
          impact: [
            {
              channel: 'apple',
              passes,
              rotated: JSON.parse(String(init.body)).replaceCodes ? passes - 2 : 0,
              clearedOverrides: cleared,
            },
          ],
          workflowInstanceId: null,
          replaceSupported: extra.supported ?? false,
          windows: extra.windows ?? [],
          blocked: extra.blocked ?? null,
          allOff: extra.allOff ?? false,
        })
      : json({ channels: null, revision: 0, effective, defaults, ...extras });
  },
});
const group = (name: string) => screen.getByRole('radiogroup', { name });
const choose = (name: string, state: string) =>
  userEvent.click(within(group(name)).getByRole('radio', { name: state }));
const bodies = (m: ReturnType<typeof renderTags>['fetchMock']) =>
  calls(m, 'PUT', '/channels').map(([, init]) => JSON.parse(String(init?.body)));

afterEach(() => vi.restoreAllMocks());

describe('Template channels', () => {
  it('disables a channel the template cannot offer and says why', async () => {
    renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      handlers(0),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    expect(screen.getAllByText('Not available')).toHaveLength(2);
    expect(screen.getAllByLabelText(/No design in this template/)).toHaveLength(2);
    expect(screen.queryByRole('radiogroup', { name: 'Google Wallet' })).toBeNull();
    expect(within(group('Paper')).getByRole('radio', { name: 'Off' })).toBeEnabled();
  });

  it('lists no channel PassBook or the plan stops, and no PassBook or Plan chip', async () => {
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />, {
      '/api/v1/templates/t1/channels': () =>
        json({
          channels: null,
          revision: 0,
          defaults,
          effective: {
            ...effective,
            google: { on: false, source: 'platform', reason: 'not_released' },
            paper: { on: false, source: 'platform', reason: 'not_included' },
          },
          overrides: noOverrides,
          overridePasses: 0,
          levels: {
            ...levels,
            google: chain({ level: 'passbook', state: 'locked', reason: 'not_released' }),
            paper: chain({ level: 'plan', state: 'locked', reason: 'not_included' }),
          },
        }),
    });
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    expect(screen.queryByText('Google Wallet')).toBeNull();
    expect(screen.queryByText('Paper')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Paper' })).toBeNull();
    expect(screen.queryByText('PassBook')).toBeNull();
    expect(screen.queryByText('Plan')).toBeNull();
    expect(screen.getAllByText('Organization').length).toBeGreaterThan(0);
  });

  it('says an org block leaves copies alone, a platform switch does not claim it', async () => {
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />, {
      '/api/v1/templates/t1/channels': () =>
        json({
          channels: null,
          revision: 0,
          defaults,
          ...extras,
          effective: {
            ...effective,
            apple: { on: false, source: 'org', reason: 'blocked' },
            paper: { on: false, source: 'platform', reason: 'printing_off' },
          },
        }),
    });
    expect(
      await screen.findByLabelText(
        'Disabled. Off for this organization. Copies stay as they are. Change it in Organization settings.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Disabled. Off for the platform. Change it in Platform settings.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Not available')).toHaveLength(2);
    expect(screen.getAllByLabelText(/No design in this template/)).toHaveLength(2);
  });

  it('shows the effect before saving, then saves with the revision', async () => {
    const { fetchMock } = renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      handlers(412),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    await choose('Apple Wallet', 'Off');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Turns off Apple Wallet for 412 passes.');
    expect(dialog).toHaveTextContent('Copies keep working until New code.');
    expect(bodies(fetchMock)).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies(fetchMock)).toHaveLength(2));
    expect(bodies(fetchMock)[0]).toMatchObject({ dryRun: true, orgId: 'o1' });
    expect(bodies(fetchMock)[1]).toEqual({
      channels: { apple: 'off' },
      revision: 0,
      expectedCleared: 0,
      orgId: 'o1',
    });
  });

  it('names the overrides a Never clears', async () => {
    renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      handlers(0, 37),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    await choose('Apple Wallet', 'Never');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Clears 37 pass overrides.');
  });

  it('is read-only without templates:publish', async () => {
    renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish={false} canEdit />,
      handlers(0),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    expect(within(group('Apple Wallet')).getByRole('radio', { name: 'Off' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('re-runs the dry run and shows the new numbers when the cleared count drifted', async () => {
    let dryCleared = 3;
    let puts = 0;
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />, {
      '/api/v1/templates/t1/channels': (_u: URL, init?: RequestInit) => {
        if (init?.method !== 'PUT')
          return json({ channels: null, revision: 0, effective, defaults, ...extras });
        const body = JSON.parse(String(init.body));
        if (body.dryRun)
          return json({
            channels: null,
            revision: 0,
            effective,
            defaults,
            ...extras,
            impact: impact(0, dryCleared),
            workflowInstanceId: null,
            replaceSupported: false,
            windows: [],
            blocked: null,
            allOff: false,
          });
        puts += 1;
        dryCleared = 5;
        return new Response(
          JSON.stringify({
            type: 'urn:wallet:problem:conflict',
            title: 'Conflict',
            status: 409,
            code: 'TEMPLATE_CHANNELS_IMPACT_CHANGED',
            detail: 'This now clears 5 pass overrides, not 3. Review and save again.',
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        );
      },
    });
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    await choose('Apple Wallet', 'Never');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Clears 3 pass overrides.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(dialog).toHaveTextContent('Clears 5 pass overrides.'));
    expect(puts).toBe(1);
  });

  const openReplace = async (extra: Parameters<typeof handlers>[2]) => {
    const view = renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      handlers(412, 0, extra),
    );
    await screen.findByRole('radiogroup', { name: 'Apple Wallet' });
    await choose('Apple Wallet', 'Off');
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    return { ...view, dialog: await screen.findByRole('dialog') };
  };

  it('offers new codes with the per-channel count, then saves with replaceCodes', async () => {
    const { fetchMock, dialog } = await openReplace({ supported: true });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Also issue new codes' }));
    await waitFor(() =>
      expect(dialog).toHaveTextContent(
        'Turns off Apple Wallet for 410 passes and issues new codes.',
      ),
    );
    expect(dialog).toHaveTextContent('Holders get a new code. Printed tickets keep working.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies(fetchMock)).toHaveLength(3));
    expect(bodies(fetchMock)[1]).toMatchObject({ dryRun: true, replaceCodes: true });
    expect(bodies(fetchMock)[2]).toMatchObject({ replaceCodes: true, expectedCleared: 0 });
  });

  it('says why codes cannot be replaced when the barcode is not the scan code', async () => {
    const { dialog } = await openReplace({ supported: false });
    expect(dialog).toHaveTextContent(
      "This template's barcode is not its scan code, so codes can't be replaced.",
    );
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('refuses inside an open window and warns about one opening soon', async () => {
    const { dialog } = await openReplace({
      supported: true,
      blocked: { name: 'Gala', closesAt: 1_800_003_600_000 },
      windows: [win({ id: 'e2', name: 'Expo', open: false })],
    });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Also issue new codes' }));
    await waitFor(() => expect(dialog).toHaveTextContent("Codes can't change while Gala is open."));
    expect(dialog).toHaveTextContent('Expo opens');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the state of recent runs and why codes were not replaced', async () => {
    const run = (id: string, state: string, errorCode: string | null = null) => ({
      id,
      state,
      dueAt: 1_800_000_000_000,
      startedAt: null,
      finishedAt: null,
      counts: { changed: 7, rotated: 7 },
      errorCode,
      waiting: null as { name: string; until: number | null } | null,
    });
    renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      handlers(0, 0, {
        runs: [
          { ...run('r1', 'running'), waiting: { name: 'Gala', until: 1_800_003_600_000 } },
          run('r2', 'done', 'REPLACE_PRINCIPAL_REVOKED'),
          run('r3', 'failed'),
        ],
      }),
    );
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(
      screen.getByText(`Waiting for Gala to end, ${formatDateTime(1_800_003_600_000)}`),
    ).toBeInTheDocument();
    expect(screen.getAllByText('7 passes changed · 7 new codes')).toHaveLength(3);
    expect(
      screen.getByText('Codes were not replaced: you no longer can publish.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders the server answer only: allOff disables the box, no client rule', async () => {
    const { dialog } = await openReplace({ supported: true, allOff: true });
    expect(within(dialog).getByRole('checkbox', { name: 'Also issue new codes' })).toBeDisabled();
    expect(dialog).toHaveTextContent('Keep one digital channel on to replace codes.');
  });

  it('holds the box while its dry run loads, so a late answer cannot land', async () => {
    const { dialog } = await openReplace({ supported: true, delayReplace: 150 });
    const box = within(dialog).getByRole('checkbox', { name: 'Also issue new codes' });
    await userEvent.click(box);
    expect(box).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await waitFor(() => expect(box).toBeEnabled());
    expect(dialog).toHaveTextContent('issues new codes');
  });

  it('shows the chain of each channel, ringing the level that stops it', async () => {
    renderTags(<TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />, {
      '/api/v1/templates/t1/channels/runs': () => json([]),
      '/api/v1/templates/t1/channels': () =>
        json({
          channels: null,
          revision: 0,
          effective: { ...effective, apple: { on: false, source: 'org', reason: 'blocked' } },
          defaults,
          levels: { ...levels, apple: chain({ level: 'org', state: 'off', reason: 'blocked' }) },
          overrides: noOverrides,
          overridePasses: 0,
        }),
    });
    await screen.findByRole('radiogroup', { name: 'Mobile' });
    // Apple is blocked by the org: no control, and its chain rings Organization.
    const apple = screen
      .getAllByRole('list', { name: 'Chain' })
      .find((l) => l.querySelector('[data-stop]'));
    expect(apple?.querySelector('[data-stop]')).toHaveAttribute('data-level', 'org');
    expect(within(apple as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByRole('list', { name: 'Chain' })).toHaveLength(6);
  });

  it('says when no pass has its own choice', async () => {
    renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      handlers(0),
    );
    expect(await screen.findByText('No pass has its own choice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset/ })).toBeNull();
  });

  it('resets the passes with their own choice on the server, a page at a time', async () => {
    let pages = 0;
    const { fetchMock } = renderTags(
      <TemplateChannelsPanel templateId="t1" orgId="o1" canPublish canEdit />,
      {
        '/api/v1/templates/t1/channels/runs': () => json([]),
        '/api/v1/templates/t1/channels/reset-passes': () => {
          pages += 1;
          return json({
            overrides: { ...noOverrides, apple: 3 },
            passes: 3,
            done: pages === 1 ? 2 : 1,
            skipped: 0,
            remaining: pages === 1 ? 1 : 0,
          });
        },
        '/api/v1/templates/t1/channels': () =>
          json({
            channels: null,
            revision: 0,
            effective,
            defaults,
            levels,
            overrides: { ...noOverrides, apple: 3 },
            overridePasses: 3,
          }),
      },
    );
    expect(await screen.findByText('3 passes have their own choice')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset 3 passes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Apple Wallet: 3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/reset-passes')).toHaveLength(2));
    expect(JSON.parse(String(calls(fetchMock, 'POST', '/reset-passes')[0]?.[1]?.body))).toEqual({
      orgId: 'o1',
    });
    expect(calls(fetchMock, 'POST', '/bulk/channels')).toHaveLength(0);
  });
});
