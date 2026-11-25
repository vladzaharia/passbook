// Seed steps for the records the visual sweep needs beyond passes: webhooks, messages, imports,
// scanning, bundles, join links and the emails they send. Each step is idempotent by name and
// logs a skip when the API refuses, so one refusal never stops the run.
import type { Session } from './demo-client.ts';

type Ids = { northwind: string; harbor: string; henrys: string; member: string; crew: string };
const DAY = 86_400_000;

async function step(name: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    const note = await run();
    console.log(`  ${name}: ${note ?? 'ok'}`);
  } catch (error) {
    console.warn(`  ${name}: skipped, ${(error as Error).message.slice(0, 200)}`);
  }
}

const IMPORT_CSV =
  'Member ID,Name,Email,Plan\nimp-001,Ada Quinn,ada@members.henrys.example,Monthly\nimp-002,,not-an-email,Monthly\n';

export async function seedExtras(owner: Session, ids: Ids, base: string): Promise<void> {
  const { northwind, harbor, member, crew } = ids;
  const inOrg = (path: string, org: string) =>
    owner.all(`${path}${path.includes('?') ? '&' : '?'}orgId=${org}`);

  await step('webhook endpoint', async () => {
    // The SSRF guard refuses localhost at save time, and create takes no status, so pause it at once.
    const url = 'https://example.com/passbook-demo';
    const found = (await inOrg('/api/v1/webhook-endpoints', northwind)).find((e) => e.url === url);
    const endpoint =
      found ??
      (
        await owner.send('POST', '/api/v1/webhook-endpoints', {
          orgId: northwind,
          url,
          description: 'Demo sink, never called',
          eventTypes: ['pass.issued', 'pass.updated'],
        })
      ).endpoint;
    if (endpoint.status !== 'paused')
      await owner.send('PATCH', `/api/v1/webhook-endpoints/${endpoint.id}`, { status: 'paused' });
    return 'paused';
  });

  await step('broadcasts', async () => {
    const have = (await inOrg('/api/v1/broadcasts', northwind)).map((b) => b.name);
    const make = (name: string, send: 'draft' | 'schedule', text: string) =>
      owner.send('POST', '/api/v1/broadcasts', {
        orgId: northwind,
        kind: 'message',
        name,
        target: { templateIds: [member] },
        patch: { message: text },
        send,
        ...(send === 'schedule' ? { at: Date.now() + 2 * DAY } : {}),
      });
    if (!have.includes('Pool notice (draft)'))
      await make('Pool notice (draft)', 'draft', 'Pool closed Monday.');
    if (!have.includes('Opening hours (scheduled)'))
      await make('Opening hours (scheduled)', 'schedule', 'New hours from Friday.');
    return 'draft and scheduled; a send to test mode needs test-mode passes, left out';
  });

  // Henry's: the sweep's {orgId} is the first org with passes, and an import page needs its own org.
  await step('pass import', async () => {
    const org = ids.henrys;
    const list = await owner.get(`/api/v1/pass-imports?orgId=${org}&limit=50`);
    if (
      (list.items as { source?: { name: string } }[]).some((i) => i.source?.name === 'members.csv')
    )
      return 'exists';
    const made = await owner.send('POST', `/api/v1/pass-imports?orgId=${org}`, {
      templateId: 'baked:henrys-blue',
      source: { kind: 'file', name: 'members.csv', csv: IMPORT_CSV },
      plan: {
        mapping: {
          memberName: { from: '/Name' },
          memberId: { from: '/Member ID' },
          membership: { from: '/Plan' },
        },
        holderEmail: { from: '/Email' },
        externalId: { from: '/Member ID' },
        match: 'externalId',
      },
    });
    return `created ${made.id}, checked, not committed`;
  });

  let eventId: string | undefined;
  await step('scan event', async () => {
    const found = (await inOrg('/api/v1/scan-events', harbor)).find(
      (e) => e.name === 'Harbor Opening Night',
    );
    if (found) {
      eventId = found.id;
      // Re-entry makes the event a counted place: the desk scanner then offers Who's in.
      if (!found.reentry)
        await owner.send('PATCH', `/api/v1/scan-events/${found.id}`, {
          reentry: true,
          capacity: 500,
        });
      return 'exists';
    }
    const made = await owner.send('POST', '/api/v1/scan-events', {
      orgId: harbor,
      name: 'Harbor Opening Night',
      templateIds: [crew],
      opensAt: Date.now() - 3_600_000,
      closesAt: Date.now() + 5 * 3_600_000,
      timeZone: 'America/Los_Angeles',
      reentry: true,
      capacity: 500,
    });
    eventId = made.id;
    return 'created';
  });

  await step('scanner', async () => {
    if (!eventId) throw new Error('no event');
    const found = (await inOrg('/api/v1/scanners', harbor)).find((s) => s.name === 'Gate A');
    if (found) return 'exists';
    const made = await owner.send('POST', '/api/v1/scanners', {
      orgId: harbor,
      name: 'Gate A',
      kind: 'device',
      accepts: { eventId },
      timeZone: 'America/Los_Angeles',
    });
    if (!made.pairing) return 'created, no pairing code';
    await new (owner.constructor as new (b: string) => Session)(base).send(
      'POST',
      '/api/v1/scan/pair',
      {
        code: made.pairing.code,
      },
    );
    return 'created and paired';
  });

  let frontDoorId: string | undefined;
  await step('scanning session', async () => {
    const found = (await inOrg('/api/v1/scanning-sessions', northwind)).find(
      (s) => s.name === 'Front door',
    );
    const session =
      found ??
      (await owner.send('POST', '/api/v1/scanning-sessions', {
        orgId: northwind,
        name: 'Front door',
        timeZone: 'America/Los_Angeles',
        accepts: { templateIds: [member] },
      }));
    frontDoorId = session.id;
    if (found) return 'exists';
    const device = await owner.send('POST', `/api/v1/scanning-sessions/${session.id}/devices`, {
      name: 'Tablet',
    });
    return `created, hours unset, pending pairing code ${device.pairing ? 'issued' : 'none'}`;
  });

  // Staff, a counted place, hours and a monitor: what the scanner and its admin pages show beyond a bare session.
  await step('scan staff', async () => {
    const have = (await inOrg('/api/v1/scan-staff', northwind)).map((m) => m.name);
    for (const [name, role] of [
      ['Mara Lopez', 'manager'],
      ['Dev Desk', 'desk'],
    ] as const)
      if (!have.includes(name))
        await owner.send('POST', '/api/v1/scan-staff', { orgId: northwind, name, role });
    return 'Mara Lopez (manager), Dev Desk (desk); PINs are shown once, reset one to use it';
  });

  await step('scan zone', async () => {
    if (!frontDoorId) throw new Error('no session');
    const found = (await inOrg('/api/v1/scan-zones', northwind)).find((z) => z.key === 'gym');
    const zone =
      found ??
      (await owner.send('POST', '/api/v1/scan-zones', {
        orgId: northwind,
        key: 'gym',
        name: 'Gym floor',
        occupancy: 'track',
        capacity: 60,
      }));
    await owner.send('PATCH', `/api/v1/scanning-sessions/${frontDoorId}`, { zoneIds: [zone.id] });
    return 'Gym floor, tracked to 60, checked at Front door';
  });

  await step('session with hours', async () => {
    const found = (await inOrg('/api/v1/scanning-sessions', northwind)).some(
      (s) => s.name === 'Evening classes',
    );
    if (found) return 'exists';
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    await owner.send('POST', '/api/v1/scanning-sessions', {
      orgId: northwind,
      name: 'Evening classes',
      timeZone: 'America/Los_Angeles',
      accepts: { templateIds: [member] },
      hours: Object.fromEntries(days.map((d) => [d, ['18:00-22:00']])),
    });
    return 'created, open 18:00-22:00';
  });

  await step('monitor', async () => {
    const found = (await inOrg('/api/v1/scan-setups', northwind)).some(
      (s) => s.name === 'Lobby monitor',
    );
    if (found) return 'exists';
    await owner.send('POST', '/api/v1/scan-setups', {
      orgId: northwind,
      name: 'Lobby monitor',
      kind: 'device',
      deviceRole: 'monitor',
      timeZone: 'America/Los_Angeles',
      watch: { allOrg: true },
    });
    return 'created, watches the org';
  });

  await step('bundle', async () => {
    if ((await inOrg('/api/v1/bundles', northwind)).some((b) => b.name === 'Welcome bundle'))
      return 'exists';
    const passes = (await inOrg('/api/v1/passes', northwind)).filter((p) => p.status === 'active');
    if (passes.length < 2) throw new Error('fewer than 2 active passes');
    await owner.send('POST', '/api/v1/bundles', {
      orgId: northwind,
      name: 'Welcome bundle',
      passIds: passes.slice(0, 2).map((p) => p.id),
      holderEmail: 'bundle.demo@members.northwind.example',
      sendEmail: true,
    });
    return 'created, emailed';
  });

  await step('join link', async () => {
    const issues: unknown[] = [];
    for (const org of [northwind, harbor, ids.henrys]) {
      const templates = await inOrg('/api/v1/templates', org);
      const states = await Promise.all(
        templates.map((t) => owner.get(`/api/v1/join-links/${t.id}?orgId=${org}`)),
      );
      if (states.some((st) => st.link)) return 'exists';
      // A template with a barcode input cannot be joined by link; take the first that can.
      for (const [i, st] of states.entries()) {
        if (!st.ready) {
          issues.push(st.issues);
          continue;
        }
        await owner.send('PUT', `/api/v1/join-links/${templates[i].id}?orgId=${org}`, {
          enabled: true,
          revision: 0,
        });
        return `created on ${templates[i].name}`;
      }
    }
    return `no ready template: ${JSON.stringify(issues)}`;
  });

  // Emails no other step sends: an org invitation and the reply-to confirmation.
  await step('invitation email', async () => {
    try {
      await owner.send('POST', `/api/v1/orgs/${harbor}/invitations`, {
        email: 'new.volunteer@harbor.example',
        roles: ['org_admin'],
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'INVITATION_PENDING') return 'pending already';
      throw error;
    }
    return 'sent';
  });
  await step('reply-to email', async () => {
    await owner.send('PUT', '/api/v1/settings', {
      scope: `org:${northwind}`,
      values: { 'support.email': 'help@northwind.example' },
    });
    // Saving the address already sends the link; a resend within a minute is refused.
    return 'sent on save';
  });
}
