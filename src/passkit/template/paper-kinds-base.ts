/** Types and readers shared by every paper class (paper-kinds*.ts). */
import type { ResolvedRoles, RoleValue } from '../wallets/types.ts';
import type { PaperKind } from './paper.ts';

export interface Kinded {
  kind: PaperKind;
  roles: ResolvedRoles;
  /** The first named field with printable text; credentials and the lookup value read as absent. */
  field: (...keys: string[]) => string | undefined;
  /** The same lookup with the field's own label. */
  meta: (...keys: string[]) => { label?: string; text: string } | undefined;
  /** Every printable field in the pass, in wallet order. */
  all: { key: string; label?: string; text: string; path: string }[];
  semantics: Record<string, unknown>;
  holderName?: string | undefined;
  /** The lookup value, when the template declares it public: a permit prints it as the plate. */
  publicLookup?: string | undefined;
  /** The template's own start and end times (ISO), read from its inputs; never the lock-screen date. */
  declared?: { start?: string | undefined; end?: string | undefined } | undefined;
}

export interface KindParts {
  title?: string;
  kicker?: string;
  start?: string;
  end?: string;
  doors?: string;
  validFrom?: string;
  validUntil?: string;
  venue?: string;
  address?: string;
  room?: string;
  directions?: string;
  holder?: string;
  type?: string;
  seat?: { section?: string; row?: string; seat?: string };
  facts: { label: string; text: string }[];
  items?: string[];
  hero?: { zone?: string; plate?: string; offer?: string; offerNote?: string; name?: string };
  /** Class facts by key (`from`, `to`, `gate`, ...); see `InfoKey`. Read only by ticket-text. */
  info: Info;
}

/** The keys a class puts in `info`: journey, booking, stay, badge, credential and loyalty. */
export type InfoKey =
  | 'from'
  | 'fromCity'
  | 'fromFull'
  | 'toFull'
  | 'to'
  | 'toCity'
  | 'vehicle'
  | 'vehicleLabel'
  | 'pack'
  | 'gate'
  | 'gateLabel'
  | 'boards'
  | 'group'
  | 'party'
  | 'boardsLabel'
  | 'arrives'
  | 'arrivesZone'
  | 'with'
  | 'nights'
  | 'included'
  | 'team'
  | 'host'
  | 'company'
  | 'goTo'
  | 'zone'
  | 'credential'
  | 'number'
  | 'issued'
  | 'reward'
  | 'goal'
  | 'typeLabel'
  | 'venueLabel';
export type Info = Partial<Record<InfoKey, string>>;

export const text = (v: RoleValue | undefined): string | undefined =>
  v && (v.kind === 'text' || v.kind === 'number') ? v.text : undefined;
export const iso = (v: RoleValue | undefined): string | undefined =>
  v?.kind === 'date' ? v.iso : undefined;
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
export const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** A role's ISO time, else the first named field that holds one. */
export const when = (c: Kinded, role: RoleValue | undefined, ...keys: string[]) => {
  const fromRole = iso(role);
  if (fromRole) return fromRole;
  const value = c.field(...keys);
  return value && ISO.test(value) ? value : undefined;
};
