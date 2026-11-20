import type { RollCall, RollCallCurrent } from '../../../../shared/contracts/scan-roll-call.ts';
import { kit } from '../act-test-fixtures.ts';
import type { Station } from '../occupancy/whos-in-test-fixtures.ts';

export type Call = RollCall & { code?: string };

export const start = async (s: Station) => {
  const res = await kit.post(s.headers, '/roll-call', {});
  return { status: res.status, body: (await res.json()) as Call };
};
export const current = async (s: Station) =>
  ((await (await kit.get(s.headers, '/roll-call')).json()) as RollCallCurrent).rollCall;
export const read = async (s: Station, id: string) =>
  (await (await kit.get(s.headers, `/roll-call/${id}`)).json()) as Call;
export const mark = async (
  s: Station,
  id: string,
  marks: { passId: string; status: 'present' | 'out' | 'none'; at?: number }[],
) => {
  const res = await kit.post(s.headers, `/roll-call/${id}/marks`, {
    marks: marks.map((m) => ({ rollCallId: id, ...m })),
  });
  return { status: res.status, body: (await res.json()) as Call };
};
export const end = async (s: Station, id: string) => {
  const res = await kit.post(s.headers, `/roll-call/${id}/end`, {});
  return { status: res.status, body: (await res.json()) as Call };
};
