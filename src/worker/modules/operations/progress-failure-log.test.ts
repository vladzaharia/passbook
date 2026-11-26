import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../platform/errors.ts';
import type { LogData, Logger } from '../../platform/log.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { ORG_KIND, registerTestKinds } from './operations-test-fixtures.ts';
import { progressOf } from './progress.ts';
import { startOperation } from './start.ts';

interface Line {
  level: string;
  event: string;
  data: LogData;
}

let kit: Kit;
let lines: Line[];
let undo: () => void;

function capture(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (event, data = {}) => void lines.push({ level: 'warn', event, data }),
    error: (event, data = {}) => void lines.push({ level: 'error', event, data }),
    child: () => logger,
  };
  return logger;
}

beforeEach(async () => {
  kit = await setupKit();
  lines = [];
  undo = registerTestKinds();
});
afterEach(() => undo());

/** Fails a running step 'b' with `error` and returns what the runner logged. */
async function failWith(error: unknown) {
  lines = [];
  const ctx = { ...kit.ctx, log: capture() };
  const op = await startOperation(ctx, {
    kind: ORG_KIND.kind,
    org: { orgId: kit.org.id, mode: 'live' },
    actor: { type: 'user', id: 'u1' },
    subject: { k: ctx.ids.id() },
  });
  const p = progressOf(ctx, op.id, op.attempt);
  await p.step('a').done();
  p.step('b');
  await p.fail(error);
  return lines.filter((l) => l.event === 'operation.failed');
}

describe('a failed operation logs its cause', () => {
  it('names the step and the error code of an error that carries one, never its message', async () => {
    const failure = Object.assign(new Error('chain check failed for holder@example.com'), {
      name: 'SigningError',
      code: 'SIGN_CHAIN_INVALID',
    });
    const [line, ...rest] = await failWith(failure);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      level: 'error',
      data: {
        code: 'OPERATION_FAILED',
        step: 'b',
        cause: 'SigningError',
        causeCode: 'SIGN_CHAIN_INVALID',
      },
    });
    expect(JSON.stringify(line)).not.toContain('holder@example.com');
  });

  it('finds the code on a cause, and a D1 constraint by its class', async () => {
    const [wrapped] = await failWith(
      new Error('write failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }),
    );
    expect(wrapped?.data.causeCode).toBe('ECONNRESET');
    const [unique] = await failWith(
      new Error('D1_ERROR: UNIQUE constraint failed: passes.external_id: SQLITE_CONSTRAINT'),
    );
    expect(unique?.data.causeCode).toBe('D1_UNIQUE');
    const [raw] = await failWith(new Error('D1_ERROR: no such table: nope: SQLITE_ERROR'));
    expect(raw?.data.causeCode).toBe('SQLITE_ERROR');
  });

  it('says where an error with no code was thrown', async () => {
    const [line] = await failWith(new Error('boom: holder@example.com'));
    expect(line?.data).toMatchObject({ code: 'OPERATION_FAILED', step: 'b', causeCode: null });
    expect(String(line?.data.site)).toMatch(/progress-failure-log\.test\.ts:\d+:\d+$/);
    expect(JSON.stringify(line)).not.toContain('holder@example.com');
  });

  it('logs an AppError at warn with its own code and the step', async () => {
    const [line] = await failWith(new AppError('IDENTITY_MOVE_PARTIAL', 502, 'Retry. a@b.example'));
    expect(line).toMatchObject({
      level: 'warn',
      data: { code: 'IDENTITY_MOVE_PARTIAL', step: 'b', causeCode: 'IDENTITY_MOVE_PARTIAL' },
    });
    expect(JSON.stringify(line)).not.toContain('a@b.example');
  });
});
