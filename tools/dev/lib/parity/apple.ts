// Apple reference: the .pkpass itself, Quick Look, and the iOS Simulator's Add Pass sheet.
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function downloadPass(url: string, file: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pkpass download -> ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs a command with a hard deadline; resolves with how it ended. */
function bounded(cmd: string, args: string[], ms: number): Promise<'done' | 'timeout' | string> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done('timeout');
    }, ms);
    child.on('error', (e) => {
      clearTimeout(timer);
      done(e.message);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      done('done');
    });
  });
}

export type Shot = { file: string | null; note: string };

/** Quick Look hung on a fixture-signed pass in the first trials; two timeouts in a row stop it. */
export class QuickLook {
  private timeouts = 0;
  async thumbnail(pkpass: string, outDir: string): Promise<Shot> {
    if (this.timeouts >= 2)
      return { file: null, note: 'skipped: Quick Look timed out twice before' };
    const out = `${pkpass.split('/').pop()}.png`;
    const how = await bounded('qlmanage', ['-t', '-s', '1200', '-o', outDir, pkpass], 40_000);
    const file = resolve(outDir, out);
    if (existsSync(file)) {
      this.timeouts = 0;
      return { file: out, note: 'qlmanage thumbnail (front only; Quick Look has no back side)' };
    }
    if (how === 'timeout') this.timeouts++;
    return { file: null, note: `qlmanage produced nothing (${how}, 40 s limit)` };
  }
}

const simctl = (...args: string[]) =>
  new Promise<string>((done, fail) =>
    execFile('xcrun', ['simctl', ...args], { timeout: 120_000 }, (e, out, err) =>
      e ? fail(new Error(`${err || e.message}`.trim())) : done(out),
    ),
  );

/** One booted simulator: Safari opens the hosted .pkpass and the screen is saved. */
export class Simulator {
  private booted = false;
  private id: string | null = null;
  private readonly name = 'iPhone 18 Pro';

  async boot(): Promise<string | null> {
    try {
      const list = JSON.parse(await simctl('list', 'devices', 'available', '-j')) as {
        devices: Record<string, { name: string; udid: string }[]>;
      };
      const all = Object.entries(list.devices)
        .filter(([rt]) => rt.includes('iOS-27'))
        .flatMap(([, d]) => d);
      this.id = all.find((d) => d.name === this.name)?.udid ?? null;
      if (!this.id) return `no ${this.name} on an iOS 27 runtime`;
      await simctl('boot', this.id).catch((e: Error) => {
        if (!/current state: Booted/.test(e.message)) throw e;
      });
      await simctl('bootstatus', this.id);
      this.booted = true;
      return null;
    } catch (e) {
      return (e as Error).message.slice(0, 200);
    }
  }

  async addPass(pkpassUrl: string, file: string): Promise<Shot> {
    if (!this.booted || !this.id) return { file: null, note: 'simulator not booted' };
    try {
      await simctl('terminate', this.id, 'com.apple.mobilesafari').catch(() => '');
      await simctl('openurl', this.id, pkpassUrl);
      await sleep(9_000);
      await simctl('io', this.id, 'screenshot', file);
      return {
        file: file.split('/').pop() ?? null,
        note: 'Safari after openurl of the hosted .pkpass; an Add Pass sheet would show here',
      };
    } catch (e) {
      return { file: null, note: `simulator: ${(e as Error).message.slice(0, 160)}` };
    }
  }

  async shutdown(): Promise<void> {
    if (this.id && this.booted) await simctl('shutdown', this.id).catch(() => '');
    this.booted = false;
  }
}
