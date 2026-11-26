// Seed steps the visual sweep's detail pages and clicks need: a webhook endpoint with deliveries and
// Henry's scanning (a session with a closed date, an event, a paired device and its scans).
import { randomBytes } from 'node:crypto';
import { Session } from './demo-client.ts';

const DAY = 86_400_000;

const uuidv7 = (): string => {
  const ts = Date.now().toString(16).padStart(12, '0');
  const r = randomBytes(10).toString('hex');
  const variant = ((Number.parseInt(r.charAt(3), 16) & 3) | 8).toString(16);
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${r.slice(0, 3)}-${variant}${r.slice(4, 7)}-${r.slice(7, 19)}`;
};

/**
 * An active endpoint at a host the e2e server resolves without DNS (WEBHOOK_TEST_DNS). Updating
 * two passes then queues `pass.updated` deliveries, which stay pending or retrying offline.
 */
export async function seedWebhook(owner: Session, org: string): Promise<string> {
  const url = 'https://hooks.example.com/passbook-demo';
  const have = await owner.all(`/api/v1/webhook-endpoints?orgId=${org}`);
  if (have.some((e) => e.url === url)) return 'exists';
  await owner.send('POST', '/api/v1/webhook-endpoints', {
    orgId: org,
    url,
    description: 'Demo sink',
    eventTypes: ['pass.issued', 'pass.updated'],
  });
  const passes = (await owner.all(`/api/v1/passes?orgId=${org}&status=active`)).slice(0, 2);
  for (const p of passes) {
    const input = (await owner.get(`/api/v1/passes/${p.id}`)).personalization;
    await owner.send('PATCH', `/api/v1/passes/${p.id}`, {
      input: {
        ...input,
        ...('memberName' in input ? { message: 'Hours changed.' } : { note: 'Updated by staff.' }),
      },
    });
  }
  return `created, ${passes.length} deliveries queued`;
}

/** Henry's: a Front desk session with a paired device and scans, a closed date, and an event. */
export async function seedHenrysScanning(
  owner: Session,
  org: string,
  base: string,
): Promise<string> {
  const q = `orgId=${org}`;
  const templateIds = (await owner.all(`/api/v1/templates?${q}`)).map((t) => t.id as string);
  const timeZone = 'America/Los_Angeles';
  if (!(await owner.all(`/api/v1/scan-events?${q}`)).some((e) => e.name === 'Open day'))
    await owner.send('POST', '/api/v1/scan-events', {
      orgId: org,
      name: 'Open day',
      templateIds,
      opensAt: Date.now() + 7 * DAY,
      closesAt: Date.now() + 7 * DAY + 8 * 3_600_000,
      timeZone,
    });
  if ((await owner.all(`/api/v1/scanning-sessions?${q}`)).some((s) => s.name === 'Front desk'))
    return 'exists';
  const closed = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const session = await owner.send('POST', '/api/v1/scanning-sessions', {
    orgId: org,
    name: 'Front desk',
    timeZone,
    accepts: { templateIds },
    hours: {
      ...Object.fromEntries(days.map((d) => [d, ['05:00-22:00']])),
      dates: { [closed]: [] },
    },
  });
  const added = await owner.send('POST', `/api/v1/scanning-sessions/${session.id}/devices`, {
    name: 'Desk iPad',
  });
  const code = added.pairing?.code as string | undefined;
  if (!code) return 'created, no pairing code';
  const device = new Session(base);
  await device.send('POST', '/api/v1/scan/pair', { code });
  const csrf = (await device.get('/api/v1/scan/session')).csrfToken as string;
  const codes: string[] = [];
  for (const p of (await owner.all(`/api/v1/passes?${q}&status=active`)).slice(0, 5)) {
    const message = (await owner.get(`/api/v1/passes/${p.id}`)).passJson?.barcodes?.[0]?.message;
    if (typeof message === 'string') codes.push(message);
  }
  // Each pass once, the first again (a repeat) and an unknown code (a refusal).
  for (const input of [...codes, ...codes.slice(0, 1), 'NOT-A-PASS-0000'])
    await device.send(
      'POST',
      '/api/v1/scan/actions',
      {
        idempotencyKey: uuidv7(),
        input: { code: input, method: 'wedge' },
        clientTs: Date.now(),
        actionId: 'auto',
      },
      { 'x-csrf-token': csrf },
    );
  return `created, ${codes.length} check-ins, a repeat and a refusal`;
}
