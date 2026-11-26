import { describe, expect, it } from 'vitest';
import type { Api } from '../sdk/cli/src/api.ts';
import { run } from '../sdk/cli/src/cli.ts';
import { followLogs, type LogLine, logLine } from '../sdk/cli/src/logs.ts';

const line = (n: number, over: Partial<LogLine> = {}): LogLine => ({
  id: `id-${String(n).padStart(3, '0')}`,
  at: Date.UTC(2026, 10, 26, 9, 30, n),
  method: 'POST',
  path: '/api/v1/passes',
  status: 201,
  code: null,
  durationMs: 12,
  requestId: `req-${n}`,
  ...over,
});

/** A log whose list answers like the server: newest first, `after` exclusive, the status class filter. */
function fakeLog(rows: () => LogLine[]) {
  const queries: Array<Record<string, unknown>> = [];
  const api = {
    requestLogs: {
      list: async (q: { after?: string; status?: string; code?: string; limit?: number } = {}) => {
        queries.push(q);
        const items = rows()
          .filter((r) => !q.after || r.id > q.after)
          .filter((r) => !q.status || String(r.status).startsWith(q.status[0] ?? ''))
          .filter((r) => !q.code || r.code === q.code)
          .sort((a, b) => (a.id < b.id ? 1 : -1))
          .slice(0, q.limit ?? 50);
        return { items };
      },
    },
  };
  return { api, queries };
}

describe('logs --follow', () => {
  it('prints calls that arrive after starting, oldest first, once each', async () => {
    const rows = [line(1), line(2)];
    const { api } = fakeLog(() => rows);
    const out: string[] = [];
    let polls = 0;
    await followLogs({
      api,
      log: (l) => out.push(l),
      sleep: async () => {
        polls++;
        if (polls === 1) rows.push(line(3), line(4, { status: 404, code: 'PASS_NOT_FOUND' }));
        if (polls === 2) rows.push(line(5));
        if (polls === 3) throw new Error('stop');
      },
    }).catch(() => undefined);
    expect(out).toEqual([
      logLine(line(3)),
      logLine(line(4, { status: 404, code: 'PASS_NOT_FOUND' })),
      logLine(line(5)),
    ]);
    expect(out[1]).toContain('404');
    expect(out[1]).toContain('PASS_NOT_FOUND');
  });

  it('filters by status and code without re-reading calls that do not match', async () => {
    const rows = [line(1)];
    const { api, queries } = fakeLog(() => rows);
    const out: string[] = [];
    let polls = 0;
    await followLogs({
      api,
      status: '4xx',
      log: (l) => out.push(l),
      sleep: async () => {
        polls++;
        if (polls === 1) rows.push(line(2), line(3));
        if (polls === 2) rows.push(line(4, { status: 404, code: 'X' }));
        if (polls === 3) throw new Error('stop');
      },
    }).catch(() => undefined);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('req-4');
    const filtered = queries.filter((q) => q.status);
    expect(filtered.at(-1)?.after).toBe('id-003');
  });

  it('is the logs command: needs --follow and a valid --status', async () => {
    const errs: string[] = [];
    const io = {
      env: { PASSBOOK_KEY: 'pbp_test_x' },
      out: () => undefined,
      err: (l: string) => errs.push(l),
      writeFile: async () => undefined,
      makeClient: () => fakeLog(() => []).api as unknown as Api,
    };
    expect(await run(['logs'], io)).toBe(1);
    expect(await run(['logs', '--follow', '--status', 'bad'], io)).toBe(1);
    expect(await run(['logs', '--follow', '--once'], io)).toBe(0);
    expect(errs[0]).toContain('--follow');
    expect(errs[1]).toContain('--status');
  });
});
