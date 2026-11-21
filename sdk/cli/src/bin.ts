#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { PassBook } from '@passbook/sdk';
import { run } from './cli.ts';

const stop = new AbortController();
process.on('SIGINT', () => stop.abort());

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  writeFile: (path, text) => writeFile(path, text),
  makeClient: ({ apiKey, baseUrl }) => new PassBook({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
  signal: stop.signal,
});
