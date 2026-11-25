import { describe, expect, it } from 'vitest';
import {
  type ConnectionPassContext,
  connectionPassFences,
  connectionPassParams,
  connectionPassPredicate,
} from './repo-connection-context.ts';

const base: ConnectionPassContext = {
  passId: 'p',
  orgId: 'o',
  identityId: 'i',
  mode: 'live',
  status: 'active',
  expectedVersion: 1,
  ownerUserId: null,
  linkGeneration: 1,
  credentialGeneration: 1,
  lifecycleGeneration: 1,
  credentialKeysetCommitment: 'k',
  transferPending: false,
  connectionId: 'c',
  externalRef: 'e',
  generation: 1,
  expectedConnectionMode: 'poll',
};
const proof = { id: 'r', generation: 1, version: 'v' };
const binding = {
  templateId: 't',
  releaseId: null,
  templateVersion: 'v',
  credentialKeysetCommitment: 'a'.repeat(64),
};
const marks = (sql: string) => sql.split('?').length - 1;
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// Callers write `${predicate} AND (${fences || '1 = 1'})`; the old form was `${predicate} ${'AND a AND b'}`.
const where = (context: ConnectionPassContext) =>
  `${connectionPassPredicate} AND (${connectionPassFences(context) || '1 = 1'})`;

describe('connectionPassFences', () => {
  it('adds nothing but a tautology when the context has no fences', () => {
    expect(connectionPassFences(base)).toBe('');
    expect(flat(where(base))).toBe(`${flat(connectionPassPredicate)} AND (1 = 1)`);
    expect(marks(where(base))).toBe(connectionPassParams(base).length);
  });

  it('joins several fences with AND, each bound in order', () => {
    const context = {
      ...base,
      expectedRowVersion: 4,
      retainedReleaseProof: proof,
      retainedBinding: binding,
    };
    expect(flat(connectionPassFences(context))).toBe(
      'row_version = ? AND (release_id = ? AND template_version = ?) AND (passes.template_id = ? AND passes.release_id IS ? AND passes.template_version = ?)',
    );
    expect(marks(where(context))).toBe(connectionPassParams(context).length);
    expect(connectionPassParams(context).slice(-6)).toEqual([4, 'r', 'v', 't', null, 'v']);
  });

  it('emits one fence alone, with no stray AND', () => {
    expect(connectionPassFences({ ...base, expectedRowVersion: 4 })).toBe('row_version = ?');
    expect(connectionPassFences({ ...base, retainedReleaseProof: proof })).toBe(
      '(release_id = ? AND template_version = ?)',
    );
  });
});
