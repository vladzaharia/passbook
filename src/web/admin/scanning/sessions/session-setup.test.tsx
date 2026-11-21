import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ScanningSessionDetailSchema } from '@/shared/contracts/scanning-sessions.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { person } from '../staff-test-fixtures.ts';
import { eligibleTemplateFixture, NOW } from '../test-fixtures.ts';
import { gym } from '../zones/test-fixtures.ts';
import { managedSession } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const page = (items: unknown[]) => json({ items, nextCursor: null });
const week = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, ['06:00-22:00']]),
);
const event = {
  id: 'e1',
  orgId: 'o1',
  mode: 'live',
  name: 'Gala night',
  templateIds: ['t1'],
  match: null,
  opensAt: NOW + 86_400_000,
  closesAt: NOW + 90_000_000,
  timeZone: 'UTC',
  capacity: 200,
  reentry: true,
  note: null,
  status: 'upcoming',
  arrived: 0,
  expected: 10,
  scanners: 0,
};

/** A counted gym door with one exit-capable device; `over` changes the session. */
function make(over: Record<string, unknown> = {}) {
  const device = managedSession.devices[0];
  return ScanningSessionDetailSchema.parse({
    ...managedSession,
    accepts: { templateIds: ['t1'], eventIds: ['e1'] },
    zoneIds: ['z-gym'],
    hours: { ...week, dates: { '2099-12-25': [] } },
    window: { open: true, by: 'hours', opensAt: null, closesAt: NOW + 3_600_000 },
    devices: [{ ...device, settings: { ...device?.settings, direction: 'both' } }],
    ...over,
  });
}

function setup(initial = make()) {
  let session = initial;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let staff = [person({ id: 'p1', name: 'Sam Ortiz', role: 'manager' })];
  const handlers = {
    '/api/v1/scanning-sessions': () => page([session]),
    '/api/v1/scanning-sessions/session-1': (_u: URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        writes.push({ path: 'session', body });
        const { revision: _r, removeDevices: _d, ...rest } = body;
        session = ScanningSessionDetailSchema.parse({
          ...session,
          ...rest,
          updatedAt: session.updatedAt + 1,
        });
      }
      return json(session);
    },
    '/api/v1/scan-setups': () => page([]),
    '/api/v1/scan-zones': () => page([gym]),
    '/api/v1/scan-events': (_u: URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        writes.push({ path: 'event', body: JSON.parse(String(init.body)) });
        return json({ ...event, id: 'e2', name: 'Late show' }, 201);
      }
      return page([event]);
    },
    '/api/v1/templates/eligible': () => page([eligibleTemplateFixture({ name: 'Monthly' })]),
    '/api/v1/scan-staff': (_u: URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push({ path: 'staff', body });
        staff = [...staff, person({ id: 'p2', name: body.name, role: body.role })];
        return json({ staff: staff[1], pin: '482913' }, 201);
      }
      return page(staff);
    },
  };
  return {
    handlers,
    writes,
    set: (s: typeof session) => {
      session = s;
    },
  };
}

const open = (s: ReturnType<typeof setup>) =>
  renderApp('/admin/scanning/sessions/session-1', {
    session: 'admin',
    memberships: [northwind],
    selectedOrg: 'o1',
    handlers: s.handlers,
  });
const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('session page sections', () => {
  it('shows who gets in, where, when and who scans, in order', async () => {
    await open(setup());
    await screen.findByRole('heading', { name: 'Membership desk', level: 1 });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('region')
          .filter((r) => r.tagName === 'SECTION')
          .map((r) => r.getAttribute('aria-label'))
          .slice(0, 4),
      ).toEqual(['Who gets in', 'Where', 'When', 'Who scans']),
    );
    const who = await section('Who gets in');
    expect(await who.findByText('Monthly')).toBeInTheDocument();
    expect(await who.findByText('Gala night')).toBeInTheDocument();
    expect(who.getByText(/200 max · Re-entry/)).toBeInTheDocument();
    const where = await section('Where');
    expect(await where.findByText('42 of 60 inside')).toBeInTheDocument();
    const when = await section('When');
    expect(when.getByText(/6 AM/)).toBeInTheDocument();
    expect(when.getByText(/Closed .*25/)).toBeInTheDocument();
    expect(await (await section('Who scans')).findByText('Anyone, as Door')).toBeInTheDocument();
  });

  it('adds an event inline, then admits it', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    const who = await section('Who gets in');
    await user.click(await who.findByRole('button', { name: 'Add event' }));
    await user.type(who.getByRole('textbox', { name: /Name/ }), 'Late show');
    await user.type(who.getByLabelText(/Date/), '2099-01-02');
    await user.type(who.getByLabelText(/Opens/), '18:00');
    await user.type(who.getByLabelText(/Closes/), '23:00');
    await user.click(who.getByRole('button', { name: /^(Add|Save)/ }));
    await waitFor(() => expect(s.writes.map((w) => w.path)).toEqual(['event', 'session']));
    expect(s.writes[0]?.body).toMatchObject({ name: 'Late show', templateIds: ['t1'] });
    expect(s.writes[1]?.body).toMatchObject({
      accepts: { templateIds: ['t1'], eventIds: ['e1', 'e2'] },
    });
  });

  it('turns tracking on from Where', async () => {
    const s = setup(make({ settings: { ...managedSession.settings, checkIn: {} } }));
    await open(s);
    const user = userEvent.setup();
    const where = await section('Where');
    await user.click(await where.findByRole('button', { name: 'Edit' }));
    await user.click(where.getByRole('switch', { name: 'Track in and out' }));
    await user.click(where.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(s.writes[0]?.body).toMatchObject({ settings: { checkIn: { mode: 'in_out' } } }),
    );
  });

  it('closes now from When', async () => {
    await open(setup());
    const user = userEvent.setup();
    const when = await section('When');
    await user.click(await when.findByRole('button', { name: 'Close now' }));
    expect(await screen.findByRole('alertdialog', { name: 'Close now?' })).toBeInTheDocument();
  });

  it('adds a person and shows the PIN once, in clear', async () => {
    const s = setup(make({ settings: { ...managedSession.settings, staffSignIn: true } }));
    await open(s);
    const user = userEvent.setup();
    const scans = await section('Who scans');
    expect(await scans.findByText('Sam Ortiz')).toBeInTheDocument();
    await user.click(scans.getByRole('button', { name: 'Add person' }));
    await user.type(scans.getByRole('textbox', { name: 'Name' }), 'Priya Nair');
    await user.click(scans.getByRole('button', { name: 'Add' }));
    expect(await scans.findByText('482 913')).toBeInTheDocument();
    expect(scans.getByText('Shown once')).toBeInTheDocument();
    expect(s.writes[0]).toMatchObject({
      path: 'staff',
      body: { name: 'Priya Nair', role: 'door' },
    });
    await user.click(scans.getByRole('button', { name: 'Done' }));
    expect(scans.queryByText('482 913')).not.toBeInTheDocument();
  });
});

describe('session page header', () => {
  it('ends the session and removes its devices by default', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'End' }));
    const dialog = await screen.findByRole('dialog', { name: 'End session?' });
    expect(within(dialog).getByRole('switch', { name: 'Remove its devices' })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'End session' }));
    await waitFor(() =>
      expect(s.writes[0]?.body).toMatchObject({ status: 'ended', removeDevices: true }),
    );
  });

  it('ends and keeps the devices when the switch is off', async () => {
    const s = setup();
    await open(s);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'End' }));
    const dialog = await screen.findByRole('dialog', { name: 'End session?' });
    await user.click(within(dialog).getByRole('switch', { name: 'Remove its devices' }));
    await user.click(within(dialog).getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(s.writes[0]?.body).toMatchObject({ status: 'ended' }));
    expect(s.writes[0]?.body).not.toHaveProperty('removeDevices');
  });

  it('offers Pair devices, Scan as Admin and More', async () => {
    await open(setup());
    expect(await screen.findByRole('button', { name: 'Pair devices' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Scan as Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add event' })).toBeInTheDocument();
  });
});

describe('session page checks', () => {
  it('brings NO_EXIT back when the exit device is revoked', async () => {
    const s = setup();
    await open(s);
    const checks = await screen.findByRole('heading', { name: 'Checks' });
    expect(checks).toBeInTheDocument();
    expect(await screen.findByText('All good')).toBeInTheDocument();
    // The exit device goes: the next refetch brings the check back.
    const base = ScanningSessionDetailSchema.parse(make());
    s.set({
      ...base,
      devices: base.devices.map((d) => ({ ...d, revoked: true })),
    });
    expect(
      await screen.findByText(/No one can scan out of Gym/, undefined, { timeout: 8000 }),
    ).toBeInTheDocument();
  }, 15_000);

  it('fixes a check with one tap', async () => {
    const s = setup(make({ settings: { ...managedSession.settings, checkIn: {} } }));
    await open(s);
    const user = userEvent.setup();
    expect(await screen.findByText(/doesn't track in and out/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Track in / out' }));
    await waitFor(() =>
      expect(s.writes[0]?.body).toMatchObject({ settings: { checkIn: { mode: 'in_out' } } }),
    );
  });
});
