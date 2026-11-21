import { expect } from 'vitest';
import type { ScanSetupResult } from '../../../shared/contracts/scan-setup-intent.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

export const fixture = scanningSessionsFixture();

let seq = 0;
export const newKey = () => `setup-${Date.now()}-${seq++}`;

export const post = (
  body: unknown,
  headers: Record<string, string> = fixture.fake.admin(),
  key: string | null = newKey(),
  query = '',
) =>
  fixture.call(
    'POST',
    `/scanning-sessions/setup${query}`,
    body,
    key === null ? headers : { ...headers, 'idempotency-key': key },
  );

/** The setup answer of a call that must succeed. */
export async function made(res: Response): Promise<ScanSetupResult> {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as ScanSetupResult;
}

export const door = (templateId: string, over: Record<string, unknown> = {}) => ({
  name: 'Front desk',
  admits: { templateIds: [templateId] },
  ...over,
});
