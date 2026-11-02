import { describe, expect, it } from 'vitest';
import { createLogger } from './log.ts';
import { createServiceContext } from './service-context.ts';

describe('waitUntil', () => {
  it('logs a rejected promise handed to a real execution context', async () => {
    const lines: string[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(line) });
    const handed: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void handed.push(p) } as ExecutionContext;
    const sc = createServiceContext({} as never, { log, ctx });
    sc.waitUntil(Promise.reject(new Error('boom')));
    await Promise.all(handed);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('waituntil.failed');
  });

  it('logs when there is no execution context', async () => {
    const lines: string[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(line) });
    const sc = createServiceContext({} as never, { log });
    sc.waitUntil(Promise.reject(new Error('boom')));
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toHaveLength(1);
  });
});
