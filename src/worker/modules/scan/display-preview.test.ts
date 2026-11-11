import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { sourcePolicyProven } from './card-semantics.ts';
import type { BuildDisplayInput } from './display.ts';
import { previewScope } from './display-preview.ts';
import type { Found } from './resolve.ts';

const ctx = {} as ServiceContext;
const template = { id: 'template-1', orgId: 'org-1', version: 'v1', manifest: {} };
const pass = {
  id: 'pass-1',
  orgId: 'org-1',
  mode: 'live',
  templateId: 'template-1',
  templateVersion: 'v1',
};

let keysetCommitment: string;
let otherKeysetCommitment: string;
beforeAll(async () => {
  const env = await makeEnv();
  keysetCommitment = await ensureCredentialRefKeyset(env.DB, env);
  otherKeysetCommitment = await credentialRefKeysetCommitment({ KEK_V1: btoa('a'.repeat(32)) });
});

describe('preview scope authority', () => {
  it('returns no scope if the pinned, active, pass or actor snapshot is missing or drifted', () => {
    const found = {
      pass,
      template,
      activePolicy: template,
      activeVersion: 'v1',
      transferPending: false,
      credentialKeysetCommitment: keysetCommitment,
    };
    const input = {
      actor: {
        role: 'door',
        orgId: 'org-1',
        mode: 'live',
        credentialKeysetCommitment: keysetCommitment,
      },
      pass: { id: 'pass-1', title: 'private title' },
      screen: 'ready',
    } as unknown as BuildDisplayInput;
    expect(sourcePolicyProven(found as unknown as Found, input.actor)).toBe(true);
    const invalid = [
      { ...found, activePolicy: undefined },
      { ...found, activePolicy: { ...template, id: 'other-template' } },
      { ...found, activePolicy: { ...template, version: 'v2' } },
      { ...found, activePolicy: { ...template, orgId: 'other-org' } },
      { ...found, template: { ...template, orgId: 'other-org' } },
      { ...found, template: { ...template, orgId: undefined } },
      { ...found, template: { ...template, version: 'v2' } },
      { ...found, pass: { ...pass, id: 'other-pass' } },
      { ...found, pass: { ...pass, orgId: 'other-org' } },
      { ...found, pass: { ...pass, mode: 'test' } },
      { ...found, transferPending: true },
      { ...found, credentialKeysetCommitment: '' },
      { ...found, credentialKeysetCommitment: otherKeysetCommitment },
    ];
    for (const snapshot of invalid)
      expect(previewScope(ctx, input, snapshot as unknown as Found)).toEqual({});
    const roleless = { ...input, actor: { ...input.actor, role: null } };
    expect(previewScope(ctx, roleless, found as unknown as Found)).toEqual({});
    for (const commitment of [undefined, '', otherKeysetCommitment]) {
      const unproven = {
        ...input,
        actor: { ...input.actor, credentialKeysetCommitment: commitment },
      };
      expect(previewScope(ctx, unproven, found as unknown as Found)).toEqual({});
    }
  });
});
