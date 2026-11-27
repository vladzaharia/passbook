// Records every distinct SQL text the worker tests prepare, for tools/check-sql-depth.ts.
// stmt() reports through the db.ts hook; a patched D1 prepare catches direct `prepare` sites.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { installSqlRecorder } from '../../src/worker/platform/db.ts';

// Taken before any test spies on console.log, so a test that asserts on its own log output never sees these.
// biome-ignore lint/suspicious/noConsole: the transport to onConsoleLog in vitest.config.ts
const emit = console.log.bind(console);
const seen = new Set<string>();
const record = (sql: string) => {
  if (seen.has(sql)) return;
  seen.add(sql);
  const test = expect.getState().currentTestName ?? null;
  emit(`@@SQL@@${JSON.stringify({ sql, test })}`);
};

if (installSqlRecorder(env as unknown as { SQL_CORPUS?: string }, record)) {
  const proto = Object.getPrototypeOf(env.DB) as { prepare: (sql: string) => unknown };
  const prepare = proto.prepare;
  proto.prepare = function (this: unknown, sql: string) {
    record(sql);
    return prepare.call(this, sql);
  };
}
