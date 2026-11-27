/**
 * Reads provider contract fixtures from test/fixtures/wallets/<provider>/. Test code only; nothing here
 * touches the network. A fixture is either `recorded` (what tools/record-wallet-contract.ts wrote: no
 * `provenance` key) or `doc-shape` (written by hand from the provider's documentation: `provenance`
 * and a `note` citing the document are required). Real recordings replace doc-shape files by name.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type FixtureProvider = 'google' | 'samsung';
export type FixtureProvenance = 'recorded' | 'doc-shape';

export interface ContractFixture<T = unknown> {
  name: string;
  provenance: FixtureProvenance;
  /** Where a doc-shape fixture comes from. */
  note?: string;
  body: T;
}

/** One provider call as the recorder writes it. */
export interface RecordedExchange {
  name: string;
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

const ROOT = resolve(import.meta.dirname, '../../../test/fixtures/wallets');
const dirOf = (provider: FixtureProvider) => resolve(ROOT, provider);

export function fixtureNames(provider: FixtureProvider): string[] {
  return readdirSync(dirOf(provider))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function loadFixture<T = RecordedExchange>(
  provider: FixtureProvider,
  name: string,
): ContractFixture<T> {
  const raw = JSON.parse(readFileSync(resolve(dirOf(provider), `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
  const provenance = (raw.provenance ?? 'recorded') as FixtureProvenance;
  if (provenance !== 'recorded' && provenance !== 'doc-shape')
    throw new Error(`${provider}/${name}: unknown provenance ${String(provenance)}.`);
  const note = typeof raw.note === 'string' ? raw.note : undefined;
  if (provenance === 'doc-shape' && !note)
    throw new Error(`${provider}/${name}: a doc-shape fixture needs a note citing its source.`);
  return { name, provenance, ...(note ? { note } : {}), body: raw as T };
}

export function loadFixtures<T = RecordedExchange>(
  provider: FixtureProvider,
  prefix = '',
): ContractFixture<T>[] {
  return fixtureNames(provider)
    .filter((n) => n.startsWith(prefix))
    .map((n) => loadFixture<T>(provider, n));
}
