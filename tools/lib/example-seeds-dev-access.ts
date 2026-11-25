// Seeds for the developer invitation operations. Same contract as example-seeds.ts: a partial value the
// sampler fits to the schema.
import { hex, IDS, T } from './example-world.ts';

const uuid = (seed: string): string => `0193a1b2-7c00-7000-8000-${hex(seed, 12)}`;
const DAY = 86_400_000;
const INVITATION = {
  id: uuid('developer-invitation-ada'),
  orgId: IDS.org,
  email: 'ada@example.com',
  roles: ['read_only'],
  state: 'pending',
  createdAt: T.updated,
  expiresAt: T.updated + 7 * DAY,
  revokedAt: null,
};

export const DEV_ACCESS_SEEDS: Record<string, unknown> = {
  'developer-invitations.postOrgsByIdDeveloperInvitations request': {
    email: INVITATION.email,
    roles: INVITATION.roles,
  },
  'developer-invitations.postOrgsByIdDeveloperInvitations response': INVITATION,
  'developer-invitations.getOrgsByIdDeveloperInvitations response': {
    items: [INVITATION],
    nextCursor: null,
  },
  'developer-invitations.getOrgsByIdDevelopers response': {
    available: true,
    limit: 5,
    items: [
      {
        userId: uuid('user-priya'),
        name: 'Priya Nair',
        email: 'priya@example.com',
        since: T.updated,
        roles: ['read_only'],
      },
    ],
    nextCursor: null,
  },
};
