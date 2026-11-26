import { vi } from 'vitest';
import { makeOrg } from '../../../test/helpers/index.ts';
import type {
  CertificateInfo,
  CreatedPassType,
  PassTypeRef,
} from '../../../workers/apple-provisioner/src/types.ts';
import {
  createFakeWwdr,
  type FakeWwdr,
  issueFromCsr,
} from '../modules/identities/cert-fixtures.ts';
import type { RunRow } from '../modules/identities/repo-runs.ts';
import { getRun } from '../modules/identities/repo-runs.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { all } from '../platform/db.ts';
import type { AppEnv } from '../platform/env.ts';
import { runIdentityProvision } from './identity-provision.ts';

export const TEAM = '48H7CLBV8Y';
const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** A stand-in for the apple-provisioner Worker: Apple's pass types and certificates, in memory. */
export class FakeApple {
  passTypes = new Map<string, PassTypeRef>();
  certs: (CertificateInfo & { passTypeAscId: string })[] = [];
  calls: string[] = [];
  reported: string[] = [];
  /** Throw after the next create succeeds, as a dropped response would. */
  /** The provisioner refuses the next certificate order, permanently. */
  refuse = false;
  /** What the refused order throws. */
  refusal = 'ASC_REFUSED: refused';
  /** Answer createPassType with this identifier instead of the requested one. */
  wrongIdentifier: string | null = null;
  dropNext: 'createPassType' | 'createPlatformPassType' | 'createCertificate' | null = null;

  readonly ca: FakeWwdr;
  readonly now: () => number;

  constructor(ca: FakeWwdr, now: () => number) {
    this.ca = ca;
    this.now = now;
  }

  private drop(method: 'createPassType' | 'createPlatformPassType' | 'createCertificate') {
    if (this.dropNext !== method) return;
    this.dropNext = null;
    throw new Error('socket closed');
  }

  count(method: string): number {
    return this.calls.filter((c) => c === method).length;
  }

  async findPassType(identifier: string): Promise<PassTypeRef | null> {
    this.calls.push('findPassType');
    return this.passTypes.get(identifier) ?? null;
  }

  async createPassType(handle: string, name: string): Promise<CreatedPassType> {
    this.calls.push('createPassType');
    const identifier = this.wrongIdentifier ?? `pass.mobile.passbook.${handle}`;
    const held = this.passTypes.get(identifier);
    if (held) return { ...held, outcome: 'existing' };
    const ref = { ascId: `asc-pt-${handle}`, identifier, name };
    this.passTypes.set(identifier, ref);
    this.drop('createPassType');
    return { ...ref, outcome: 'created' };
  }

  async createPlatformPassType(slot: 'root' | 'devtest'): Promise<CreatedPassType> {
    this.calls.push('createPlatformPassType');
    const identifier =
      this.wrongIdentifier ??
      (slot === 'root' ? 'pass.mobile.passbook' : 'pass.mobile.passbook.devtest');
    const held = this.passTypes.get(identifier);
    if (held) return { ...held, outcome: 'existing' };
    const ref = { ascId: `asc-pt-${slot}`, identifier, name: `PassBook ${slot}` };
    this.passTypes.set(identifier, ref);
    this.drop('createPlatformPassType');
    return { ...ref, outcome: 'created' };
  }

  async listCertificates(passTypeAscId: string): Promise<CertificateInfo[]> {
    this.calls.push('listCertificates');
    return this.certs.filter((c) => c.passTypeAscId === passTypeAscId);
  }

  async reportCertificateActive(certAscId: string): Promise<void> {
    this.calls.push('reportCertificateActive');
    this.reported.push(certAscId);
  }

  async createCertificate(passTypeAscId: string, csrDer: Uint8Array): Promise<CertificateInfo> {
    this.calls.push('createCertificate');
    if (this.refuse) throw new Error(this.refusal);
    const pt = [...this.passTypes.values()].find((p) => p.ascId === passTypeAscId);
    if (!pt) throw new Error('ASC_NOT_FOUND: no pass type');
    const der = await issueFromCsr(
      csrDer,
      this.ca,
      { passTypeIdentifier: pt.identifier, teamIdentifier: TEAM },
      { now: this.now() },
    );
    const info = {
      ascId: `asc-cert-${this.certs.length + 1}`,
      certificateType: 'PASS_TYPE_ID',
      serialNumber: null,
      expiresAt: null,
      der,
      passTypeAscId,
    };
    this.certs.push(info);
    this.drop('createCertificate');
    return info;
  }
}

/**
 * A workflow step: retries a failing function up to `retries` times, runs the steps named in `twice`
 * two times (the work happened, the result was lost), and calls `onSleep` for each sleep.
 */
export function fakeStep(
  options: {
    twice?: 'all' | readonly string[];
    retries?: number;
    onSleep?: (name: string) => Promise<void> | void;
  } = {},
) {
  const names: string[] = [];
  const sleeps: string[] = [];
  type Fn = () => Promise<unknown>;
  const step = {
    names,
    sleeps,
    async do(name: string, a: unknown, b?: unknown) {
      names.push(name);
      const fn = (typeof a === 'function' ? a : b) as Fn;
      const attempt = async () => {
        for (let i = 0; ; i++) {
          try {
            return await fn();
          } catch (error) {
            if (error instanceof Error && error.name === 'NonRetryableError') throw error;
            if (i >= (options.retries ?? 3)) throw error;
          }
        }
      };
      let result = await attempt();
      if (options.twice === 'all' || options.twice?.includes(name)) result = await attempt();
      return result;
    },
    async sleep(name: string) {
      sleeps.push(name);
      await options.onSleep?.(name);
    },
  };
  return step;
}

export interface Harness {
  kit: Kit;
  org: { id: string };
  env: AppEnv;
  apple: FakeApple;
  workflow: { created: { id: string; params: unknown }[] };
  mail: ReturnType<typeof vi.fn>;
  start(runId: string, step?: ReturnType<typeof fakeStep>): ReturnType<typeof runIdentityProvision>;
  runRow(runId: string): Promise<RunRow>;
  setApple(on: boolean): void;
}

export async function harness(slug: string): Promise<Harness> {
  const start = Date.UTC(2026, 10, 20);
  const ca = await createFakeWwdr(start);
  const clock = { now: () => start };
  const apple = new FakeApple(ca, () => clock.now());
  const workflow = {
    created: [] as { id: string; params: unknown }[],
    async create(options: { id: string; params: unknown }) {
      workflow.created.push(options);
      return { id: options.id };
    },
  };
  const mail = vi.fn(async () => ({ messageId: 'm' }));
  const kit = await setupKit({
    clockStart: start,
    env: {
      KEK_V1,
      SIGNER_PLATFORM_INTERMEDIATE: ca.pem,
      EMAIL: { send: mail },
      APPLE: apple,
      IDENTITY_PROVISION: workflow,
    } as unknown as Partial<AppEnv>,
  });
  clock.now = () => kit.clock.now();
  const org = await makeOrg(kit.fx, { slug, name: 'Henrys Gym' });
  const env = kit.env;
  return {
    kit,
    org,
    env,
    apple,
    workflow,
    mail,
    start: (runId, step = fakeStep()) =>
      runIdentityProvision(env, { runId }, step as never, undefined, kit.clock),
    async runRow(runId) {
      const row = await getRun(env.DB, runId);
      if (!row) throw new Error('missing run');
      return row;
    },
    setApple(on) {
      Object.assign(env, { APPLE: on ? apple : undefined });
    },
  };
}

export const auditActions = async (db: D1Database, targetOrg: string): Promise<string[]> =>
  (
    await all<{ action: string }>(
      db,
      "SELECT action FROM audit_log WHERE org_id = ? AND action LIKE 'identity.%' ORDER BY id",
      [targetOrg],
    )
  ).map((r) => r.action);
