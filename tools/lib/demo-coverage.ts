// Seed steps for the records the visual sweep's detail routes need: a sent message, a finished change
// run and a custom Polaris ID group. Idempotent by name.
import type { Session } from './demo-client.ts';

const named = async (owner: Session, org: string, name: string) =>
  (await owner.all(`/api/v1/broadcasts?orgId=${org}`)).some((b) => b.name === name);

/** A message and a change run sent to Northwind Member passes; both settle offline as `sent`. */
export async function seedSentBroadcasts(
  owner: Session,
  org: string,
  member: string,
): Promise<string> {
  const target = { templateIds: [member] };
  const made: string[] = [];
  if (!(await named(owner, org, 'Welcome back (sent)'))) {
    await owner.send('POST', '/api/v1/broadcasts', {
      orgId: org,
      kind: 'message',
      name: 'Welcome back (sent)',
      target,
      patch: { message: 'Welcome back.' },
      send: 'now',
    });
    made.push('message');
  }
  if (!(await named(owner, org, 'Hours notice (change run)'))) {
    await owner.send('POST', '/api/v1/broadcasts', {
      orgId: org,
      kind: 'change',
      name: 'Hours notice (change run)',
      target,
      patch: { message: { set: 'Hours changed.' } },
      send: 'now',
      notify: false,
    });
    made.push('change run');
  }
  return made.length ? `sent ${made.join(' and ')}` : 'exists';
}

/** A custom group: the sweep's group detail needs a key that is not a role group. */
export async function seedCustomGroup(owner: Session): Promise<string> {
  const have = await owner.get('/api/v1/platform/idp/groups');
  if ((have.items as { key: string }[]).some((g) => g.key === 'floor_staff')) return 'exists';
  await owner.send('POST', '/api/v1/platform/idp/groups', {
    key: 'floor_staff',
    friendlyName: 'Floor staff',
  });
  return 'created floor_staff';
}
