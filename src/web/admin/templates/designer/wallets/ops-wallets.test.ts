import { describe, expect, it } from 'vitest';
import { sampleDoc } from '../fixtures.ts';
import type { DraftAsset } from '../model.ts';
import { applyWalletsOp, normalizeWallets, readWallets } from './ops-wallets.ts';

const art = (name = ''): DraftAsset => ({
  name,
  slot: 'source',
  scale: 1,
  size: 9,
  upload: 'AAAA',
});

describe('wallets ops', () => {
  it('leaves a template the tab never touched without a wallets key', () => {
    const doc = sampleDoc();
    expect(applyWalletsOp(doc, { op: 'wallets-required', id: 'type', on: false })).toBe(doc);
    expect(applyWalletsOp(doc, { op: 'wallets-role', role: 'tier', source: null })).toBe(doc);
    expect('wallets' in doc.manifest).toBe(false);
  });

  it('adds schema 1 when the block appears and drops the block when it empties', () => {
    const doc = sampleDoc();
    const on = applyWalletsOp(doc, { op: 'wallets-role', role: 'tier', source: { field: 'tier' } });
    expect(on.manifest.wallets).toEqual({ schema: 1, roles: { tier: { field: 'tier' } } });
    const off = applyWalletsOp(on, { op: 'wallets-role', role: 'tier', source: null });
    expect('wallets' in off.manifest).toBe(false);
    expect(off.manifest).toEqual(doc.manifest);
  });

  it('writes one role, several roles in one step, empty and expression sources', () => {
    let doc = applyWalletsOp(sampleDoc(), { op: 'wallets-role', role: 'title', source: false });
    doc = applyWalletsOp(doc, {
      op: 'wallets-roles',
      sources: { tier: { field: 'tier' }, memberId: { value: '{{name}}' } },
    });
    expect(readWallets(doc).roles).toEqual({
      title: false,
      memberId: { value: '{{name}}' },
      tier: { field: 'tier' },
    });
  });

  it('sets and clears a type, keeping the other wallet', () => {
    let doc = applyWalletsOp(sampleDoc(), { op: 'wallets-type', target: 'google', type: 'event' });
    doc = applyWalletsOp(doc, { op: 'wallets-type', target: 'samsung', type: 'ticket' });
    doc = applyWalletsOp(doc, { op: 'wallets-subtype', subType: 'movies' });
    doc = applyWalletsOp(doc, { op: 'wallets-class-key', expr: '{{name|url}}' });
    expect(readWallets(doc)).toEqual({
      schema: 1,
      google: { type: 'event', classKey: '{{name|url}}' },
      samsung: { type: 'ticket', subType: 'movies' },
    });
    doc = applyWalletsOp(doc, { op: 'wallets-type', target: 'google', type: null });
    expect(readWallets(doc).google).toEqual({ classKey: '{{name|url}}' });
  });

  it('keeps omit and required sorted and without duplicates', () => {
    let doc = sampleDoc();
    for (const entry of ['sharing', 'backFields.terms', 'sharing'])
      doc = applyWalletsOp(doc, { op: 'wallets-omit', target: 'samsung', entry, on: true });
    for (const id of ['type', 'barcode.format', 'type'])
      doc = applyWalletsOp(doc, { op: 'wallets-required', id, on: true });
    expect(readWallets(doc)).toEqual({
      schema: 1,
      required: ['barcode.format', 'type'],
      samsung: { omit: ['backFields.terms', 'sharing'] },
    });
    doc = applyWalletsOp(doc, {
      op: 'wallets-omit',
      target: 'samsung',
      entry: 'sharing',
      on: false,
    });
    expect(readWallets(doc).samsung).toEqual({ omit: ['backFields.terms'] });
  });

  it('writes art as an asset and an images entry together, and removes both', () => {
    const doc = applyWalletsOp(sampleDoc(), {
      op: 'wallets-image',
      target: 'google',
      slot: 'logo',
      asset: art(),
    });
    expect(doc.assets.map((a) => a.name)).toContain('wallets/google/logo.png');
    expect(readWallets(doc).google).toEqual({ images: { logo: 'wallets/google/logo.png' } });
    const replaced = applyWalletsOp(doc, {
      op: 'wallets-image',
      target: 'google',
      slot: 'logo',
      asset: { ...art(), upload: 'BBBB' },
    });
    expect(replaced.assets.filter((a) => a.name === 'wallets/google/logo.png')).toHaveLength(1);
    const gone = applyWalletsOp(replaced, {
      op: 'wallets-image',
      target: 'google',
      slot: 'logo',
      asset: null,
    });
    expect(gone.assets.map((a) => a.name)).toEqual(['icon@3x.png']);
    expect('wallets' in gone.manifest).toBe(false);
  });

  it('never touches the pass document', () => {
    const doc = sampleDoc();
    const next = applyWalletsOp(doc, { op: 'wallets-type', target: 'google', type: 'loyalty' });
    expect(next.passJson).toBe(doc.passJson);
  });

  it('normalizes a block with only a schema away', () => {
    expect(normalizeWallets({ schema: 1, google: {}, required: [] })).toBeUndefined();
  });
});
