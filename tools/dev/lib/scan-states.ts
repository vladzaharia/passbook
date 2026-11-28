// The states of a paired scanner, in the order they are set up. Each one is a console change
// (role, settings, hours) followed by a reload, so the screen is the one a device would show.
import type { BrowserContext, Page } from '@playwright/test';
import { closedHours, resetPin, type ScanApi, type ScanFixtures } from './scan-api.ts';

export type Run = {
  page: Page;
  context: BrowserContext;
  base: string;
  api: ScanApi;
  fx: ScanFixtures;
  pins: Map<string, string>;
  snap: (name: string, note?: string) => Promise<void>;
};

const session = (r: Run) => `/api/v1/scanning-sessions/${r.fx.sessionId}`;
const device = (r: Run) => `${session(r)}/devices/${r.fx.deviceId}`;
const settings = (r: Run, values: Record<string, unknown>) =>
  r.api.send('PATCH', session(r), { settings: values });
const surface = (r: Run, value: string) => r.api.send('PATCH', device(r), { surface: value });

async function reload(r: Run) {
  await r.page.goto(`${r.base}/scan`, { waitUntil: 'load' });
  await r.page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await r.page.waitForTimeout(600);
}

const start = (r: Run) => r.page.getByRole('button', { name: 'Start scanning' });

/** The start panel, then the live camera screen (the browser has a fake camera). */
async function startAndLive(r: Run, name: string) {
  await reload(r);
  await r.snap(`${name}-start`);
  if (await start(r).isVisible()) {
    await start(r).click();
    await r.page.waitForTimeout(1_200);
  }
  await r.snap(`${name}-live`);
}

async function open(r: Run, label: string | RegExp, name: string, tag: string) {
  const button = r.page.getByRole('button', { name: label }).first();
  if (!(await button.isVisible().catch(() => false))) return r.snap(name, `no "${tag}" control`);
  await button.click();
  await r.page.waitForTimeout(900);
  await r.snap(name);
  await r.page.keyboard.press('Escape');
  await r.page.waitForTimeout(300);
}

export async function tabletStates(r: Run): Promise<void> {
  const { page } = r;
  // Back to a plain door: phone layout, no staff sign-in, always open.
  await settings(r, { roleWithoutSignIn: 'door', staffSignIn: false });
  await r.api.send('PATCH', session(r), { hours: null, status: 'active' });
  await surface(r, 'phone');
  await startAndLive(r, 'device-door');
  await open(r, /^Look up|Find a pass/, 'device-door-lookup', 'Look up');
  await open(r, /More|Menu|Settings|Open menu/, 'device-door-menu', 'menu');

  await surface(r, 'operator');
  await startAndLive(r, 'device-operator');

  await settings(r, { roleWithoutSignIn: 'desk' });
  await surface(r, 'desk');
  await startAndLive(r, 'device-desk');
  await open(r, /Who.s in/, 'device-desk-whos-in', "Who's in");
  await open(r, /^Look up|Find a pass/, 'device-desk-lookup', 'Look up');
  await surface(r, 'phone');
  await startAndLive(r, 'device-desk-phone');

  // Offline: the live screen with the network gone.
  await r.context.setOffline(true);
  await page.waitForTimeout(2_500);
  await r.snap('device-offline-live');
  await r.context.setOffline(false);

  // Hours: closed now, then a manual hold, then paused and ended.
  await r.api.send('PATCH', session(r), { hours: closedHours() });
  await reload(r);
  await r.snap('device-session-closed');
  await r.api.send('PATCH', session(r), { hours: null });
  await r.api.send('PATCH', session(r), { status: 'paused' });
  await reload(r);
  await r.snap('device-session-paused');
  await r.api.send('PATCH', session(r), { status: 'ended' });
  await reload(r);
  await r.snap('device-session-ended');
  await r.api.send('PATCH', session(r), { status: 'active' });

  // The customer screen: idle, then the same device flipped back.
  await surface(r, 'customer');
  await reload(r);
  await r.snap('device-customer-idle');
  await surface(r, 'phone');

  // Staff sign-in: the roster, a wrong PIN, then a manager signed in.
  await settings(r, { staffSignIn: true });
  await reload(r);
  await r.snap('device-staff-signin');
  const person = r.fx.staff.find((s) => s.name === 'Mara Lopez') ?? r.fx.staff[0];
  const pin = person && r.pins.get(person.id);
  if (person && pin) {
    const keyIn = async (digits: string) => {
      for (const d of digits)
        await page.getByTestId('scan-keypad').getByRole('button', { name: d, exact: true }).click();
    };
    await keyIn('000');
    await r.snap('device-staff-pin-entered');
    await keyIn('000');
    await page.waitForTimeout(1_200);
    await r.snap('device-staff-wrong-pin');
    for (let i = 0; i < 8 && !(await page.getByText(/Too many wrong PINs/).isVisible()); i++) {
      await keyIn('000000');
      await page.waitForTimeout(700);
    }
    await r.snap('device-staff-lockout');
    const fresh = await resetPin(r.api, r.fx.orgId, person.id);
    await reload(r);
    await keyIn(fresh);
    await page.waitForTimeout(1_500);
    await r.snap('device-staff-signed-in-start');
    if (await start(r).isVisible()) await start(r).click();
    await page.waitForTimeout(1_200);
    await r.snap('device-staff-manager-live');
    await open(r, /Who.s in/, 'device-staff-manager-whos-in', "Who's in");
  }
  await settings(r, { staffSignIn: false });
}

/** The event desk: a live scanner that counts people in and out. */
export async function eventDeskStates(r: Run): Promise<void> {
  await startAndLive(r, 'device-event-desk');
  await open(r, /Who.s in/, 'device-event-desk-whos-in', "Who's in");
  await open(r, /^Look up|Find a pass/, 'device-event-desk-lookup', 'Look up');
}
