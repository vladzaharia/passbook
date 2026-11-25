#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { PassBook } from '@passbook/sdk';
import { run } from './cli.ts';

const stop = new AbortController();
process.on('SIGINT', () => stop.abort());

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  writeFile: (path, text) => writeFile(path, text),
  readFile: (path) => readFile(path, 'utf8'),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
  makeClient: ({ apiKey, baseUrl, userAgent }) =>
    new PassBook({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(userAgent ? { userAgent } : {}),
    }),
  signal: stop.signal,
});
