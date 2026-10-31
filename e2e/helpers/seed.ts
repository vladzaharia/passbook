import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type Api, uid } from './api.ts';

const FILE = 'e2e/.auth/seed.json';

export interface Seed {
  org: { id: string; slug: string; name: string };
}

/** One fresh org per run keeps specs independent of whatever the persisted local D1 already holds. */
export async function createSeed(api: Api): Promise<Seed> {
  const slug = uid('e2e').toLowerCase();
  const org = await api.send('POST', '/api/v1/orgs', { slug, name: `E2E Org ${slug}` });
  const seed: Seed = { org: { id: org.id, slug, name: org.name } };
  mkdirSync('e2e/.auth', { recursive: true });
  writeFileSync(FILE, JSON.stringify(seed));
  return seed;
}

export const readSeed = (): Seed => JSON.parse(readFileSync(FILE, 'utf8')) as Seed;
