// The console API as the visual sweep needs it for the scanner: CSRF-aware calls, fixtures, pairing.
import type { APIRequestContext, Page } from '@playwright/test';

// biome-ignore lint/suspicious/noExplicitAny: loosely typed console payloads
type Json = any;

export type ScanApi = {
  get: (path: string) => Promise<Json>;
  send: (method: 'POST' | 'PATCH' | 'PUT', path: string, data?: unknown) => Promise<Json>;
};

export async function scanApi(ctx: APIRequestContext): Promise<ScanApi> {
  const csrf = ((await (await ctx.get('/api/v1/session')).json()) as { csrfToken: string })
    .csrfToken;
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await ctx.fetch(path, {
      method,
      ...(data === undefined ? {} : { data }),
      headers: { 'x-csrf-token': csrf },
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  return { get: (path) => call('GET', path), send: (m, p, d) => call(m, p, d) };
}

/** What the harness drives: the seed's Northwind session, its device, staff and monitor. */
export type ScanFixtures = {
  orgId: string;
  sessionId: string;
  deviceId: string;
  monitorId: string;
  /** Harbor's Gate A: an event with re-entry, so a desk there counts who is in. */
  gate: { orgId: string; id: string };
  staff: { name: string; id: string }[];
};

export async function findFixtures(
  api: ScanApi,
  orgId: string,
  harborId: string,
): Promise<ScanFixtures> {
  const q = `orgId=${orgId}&limit=50`;
  const sessions = (await api.get(`/api/v1/scanning-sessions?${q}`)).items as Json[];
  const session = sessions.find((s) => s.name === 'Front door');
  const detail =
    session && (await api.get(`/api/v1/scanning-sessions/${session.id}?orgId=${orgId}`));
  const device = detail?.devices?.[0];
  const monitor = ((await api.get(`/api/v1/scan-setups?${q}`)).items as Json[]).find(
    (s) => s.name === 'Lobby monitor',
  );
  const staff = ((await api.get(`/api/v1/scan-staff?${q}`)).items as Json[]).map((s) => ({
    name: s.name as string,
    id: s.id as string,
  }));
  const gate = (
    (await api.get(`/api/v1/scan-setups?orgId=${harborId}&limit=50`)).items as Json[]
  ).find((s) => s.name === 'Gate A');
  if (!session || !device || !monitor || !gate || staff.length === 0)
    throw new Error(
      'Seed has no Front door device, Lobby monitor, Gate A or staff: run tools/seed-demo.ts.',
    );
  return {
    orgId,
    sessionId: session.id,
    deviceId: device.id,
    monitorId: monitor.id,
    gate: { orgId: harborId, id: gate.id },
    staff,
  };
}

/** A fresh pairing code for a scanner or device (replaces any live one). */
export async function newPairingCode(api: ScanApi, scannerId: string): Promise<string> {
  return (await api.send('POST', `/api/v1/scanners/${scannerId}/pairing`, {})).code as string;
}

/** A staff member's PIN: a reset shows a new one, the only time it is visible. */
export async function resetPin(api: ScanApi, orgId: string, staffId: string): Promise<string> {
  return (await api.send('POST', `/api/v1/scan-staff/${staffId}/reset-pin?orgId=${orgId}`, {}))
    .pin as string;
}

/** Opens the pairing link and confirms it, as a person with a new tablet would. */
export async function pairBrowser(
  page: Page,
  base: string,
  code: string,
  onConfirm?: () => Promise<void>,
): Promise<void> {
  await page.goto(`${base}/scan#pair=${encodeURIComponent(code)}`);
  const confirm = page.getByTestId('scan-pair-confirm');
  await confirm.waitFor({ timeout: 15_000 });
  await onConfirm?.();
  await confirm.getByRole('button', { name: 'Join', exact: true }).click();
  await confirm.waitFor({ state: 'hidden', timeout: 15_000 });
}

/** Window of 1 h that excludes now (UTC), on every weekday: the session reads as closed. */
export function closedHours(now = new Date()): Record<string, string[]> {
  const start = (now.getUTCHours() + 3) % 24;
  const end = start === 23 ? '24:00' : `${String(start + 1).padStart(2, '0')}:00`;
  const span = `${String(start).padStart(2, '0')}:00-${end}`;
  return Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [span]]),
  );
}
