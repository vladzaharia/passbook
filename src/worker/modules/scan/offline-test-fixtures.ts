import { sha256Hex } from '../../platform/ids.ts';
import { CHECK_IN, kit, type out } from './act-test-fixtures.ts';
import { key } from './test-kit.ts';

export const LIST = { offline: true, whenOffline: 'list' } as const;
export const hashOf = async (code: string) => (await sha256Hex(code)).slice(0, 32);

export interface RosterBody {
  entries: { h: string; status: string; state: string | null; g?: string }[];
  cursor: string | null;
  asOf: number;
  validUntil: number;
  sig: string;
}

export const rosterOf = async (headers: Record<string, string>) =>
  (await (await kit.get(headers, '/roster')).json()) as RosterBody;

export const item = (code: string, over: Record<string, unknown> = {}) => ({
  idempotencyKey: key(),
  code,
  method: 'camera' as const,
  clientTs: kit.clock.now(),
  ...over,
});

export const batch = (headers: Record<string, string>, items: unknown[], roster?: unknown) =>
  kit.post(headers, '/batch', { items, ...(roster ? { roster } : {}) });

export interface BatchBody {
  items: { idempotencyKey: string; outcome: Awaited<ReturnType<typeof out>>; conflict?: boolean }[];
}
export const batchOf = async (res: Response) => (await res.json()) as BatchBody;

export const ticketTemplate = () => kit.scanTemplate('Ticket', { actions: [CHECK_IN] });
