import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderStampFiles } from '@/passkit/stamps/package.ts';
import { stampsIssues } from '@/passkit/template/stamps.ts';
import type { PassJson, TemplateManifest } from '@/passkit/types.ts';
import { applyOp, type Op } from './apply.ts';
import { sampleDoc } from './fixtures.ts';
import { assetsPayload, toBase64 } from './images.ts';
import type { DesignDoc, DraftAsset } from './model.ts';
import { placeStampArt } from './stamp-art.ts';
import { drawStrip } from './stamp-preview.ts';
import {
  ART_SLOTS,
  type ArtSlot,
  countInputs,
  gridNote,
  holdsNote,
  readStamps,
  sampleCount,
} from './stamps.ts';

const bytesOf = (name: string) =>
  new Uint8Array(readFileSync(join(process.cwd(), 'templates/starter-stamp-card', name)));
const asset = (file: string): DraftAsset => {
  const bytes = bytesOf(file);
  return { name: file, slot: 'source', scale: 1, size: bytes.length, upload: toBase64(bytes) };
};
const art = Object.fromEntries(ART_SLOTS.map((s) => [s.slot, asset(s.file)])) as Record<
  ArtSlot,
  DraftAsset
>;
const storeCard = (): DesignDoc => {
  const doc = sampleDoc();
  const generic = doc.passJson.generic;
  delete doc.passJson.generic;
  doc.passJson.storeCard = generic;
  return doc;
};
const run = (doc: DesignDoc, ...ops: Op[]) => ops.reduce(applyOp, doc);
const withStamps = () => run(storeCard(), { op: 'stamps-add', art });

describe('Add stamps', () => {
  it('creates the block, the input, the header and its bindings', () => {
    const doc = withStamps();
    expect(readStamps(doc)).toMatchObject({ input: 'stamps', goal: 10, tilt: true });
    const props = (doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.stamps).toMatchObject({ type: 'integer', minimum: 0, maximum: 19 });
    expect(JSON.stringify(doc.passJson)).toContain('"key":"stamps"');
    const bindings = JSON.stringify(doc.manifest.bindings);
    expect(bindings).toContain('{{pass.stamps.card}} of {{pass.stamps.goal}}');
    expect(bindings).toContain('pass.stamps.ready');
    expect(doc.assets.filter((a) => a.slot === 'source').map((a) => a.name)).toEqual(
      ART_SLOTS.map((s) => s.file),
    );
  });

  it('builds a manifest the checks accept', () => {
    const doc = withStamps();
    const issues = stampsIssues(
      doc.manifest as unknown as TemplateManifest,
      doc.passJson as unknown as PassJson,
    );
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain('STAMPS_SILENT');
  });

  it('does nothing twice', () => {
    const once = withStamps();
    expect(run(once, { op: 'stamps-add', art })).toBe(once);
  });

  it('draws with the shared compositor', () => {
    const doc = withStamps();
    const files = new Map(doc.assets.map((a) => [a.name, bytesOf(a.name)]));
    const drawn = renderStampFiles(doc.manifest.stamps as never, files, { counts: [3] });
    expect(drawn.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(drawn.strips).toHaveLength(2);
  });
});

describe('goal', () => {
  it.each([3, 8, 20])(
    'sets %i and the input maximum to a full card plus the carry-over',
    (goal) => {
      const doc = run(withStamps(), { op: 'stamps-goal', goal });
      expect(readStamps(doc)?.goal).toBe(goal);
      const props = (doc.manifest.inputs as { properties: Record<string, { maximum: number }> })
        .properties;
      expect(props.stamps?.maximum).toBe(2 * goal - 1);
    },
  );

  it('stays within 3 to 20', () => {
    const doc = withStamps();
    expect(run(doc, { op: 'stamps-goal', goal: 2 })).toBe(doc);
    expect(run(doc, { op: 'stamps-goal', goal: 21 })).toBe(doc);
    expect(run(doc, { op: 'stamps-goal', goal: 10 })).toBe(doc);
  });

  it('clamps the sample to the new maximum', () => {
    const doc = run(withStamps(), { op: 'stamps-goal', goal: 20 });
    doc.manifest.sample = { ...(doc.manifest.sample as object), stamps: 30 };
    expect(sampleCount(run(doc, { op: 'stamps-goal', goal: 5 }))).toBe(5);
    expect(
      (run(doc, { op: 'stamps-goal', goal: 5 }).manifest.sample as { stamps: number }).stamps,
    ).toBe(9);
  });

  it('forgets keepReady when the goal moves again', () => {
    const doc = run(withStamps(), { op: 'stamps-set', patch: { keepReady: true } });
    expect(readStamps(doc)?.keepReady).toBe(true);
    expect(readStamps(run(doc, { op: 'stamps-goal', goal: 12 }))?.keepReady).toBe(false);
  });

  it('describes the layout and the capacity', () => {
    expect(gridNote(8)).toBe('2 rows of 4, 44 pt stamps');
    expect(gridNote(5)).toMatch(/^1 row of 5/);
    expect(gridNote(7)).toMatch(/^2 rows \(4 and 3\), \d+ pt stamps$/);
    expect(gridNote(20)).toMatch(/^3 rows \(7, 7 and 6\), 28 pt stamps$/);
    expect(holdsNote(8)).toBe('Holds up to 15: a full card plus 7 saved.');
  });

  it('rewrites the maximum from the goal-change confirm', () => {
    const doc = run(withStamps(), { op: 'stamps-set', patch: { keepReady: true, maximum: 27 } });
    const props = (doc.manifest.inputs as { properties: Record<string, { maximum: number }> })
      .properties;
    expect(props.stamps?.maximum).toBe(27);
  });
});

describe('art and options', () => {
  it('replaces and removes optional art', () => {
    const doc = withStamps();
    const none = run(doc, { op: 'stamps-art', slot: 'reward', asset: null });
    expect(readStamps(none)?.art.reward).toBeUndefined();
    expect(none.assets.some((a) => a.name === 'stamps/reward.png')).toBe(false);
    const back = run(none, { op: 'stamps-art', slot: 'reward', asset: art.reward });
    expect(readStamps(back)?.art.reward).toBe('stamps/reward.png');
  });

  it('switches tilt off and on', () => {
    const off = run(withStamps(), { op: 'stamps-set', patch: { tilt: false } });
    expect(readStamps(off)?.tilt).toBe(false);
    expect(readStamps(run(off, { op: 'stamps-set', patch: { tilt: true } }))?.tilt).toBe(true);
  });

  it('counts from another whole-number input, starting at 0 with room for the carry-over', () => {
    const doc = withStamps();
    const inputs = doc.manifest.inputs as { properties: Record<string, Record<string, unknown>> };
    inputs.properties.visits = { type: 'integer', 'x-label': 'Visits' };
    expect(countInputs(doc.manifest).map((i) => i.value)).toEqual(['stamps', 'visits']);
    const moved = run(doc, { op: 'stamps-input', input: 'visits' });
    expect(readStamps(moved)?.input).toBe('visits');
    const props = (moved.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(props.visits).toMatchObject({ minimum: 0, maximum: 19 });
    expect(run(moved, { op: 'stamps-input', input: 'holder' })).toBe(moved);
  });

  it('follows a renamed input', () => {
    const doc = run(withStamps(), { op: 'input-set', name: 'stamps', patch: { name: 'visits' } });
    expect(readStamps(doc)?.input).toBe('visits');
  });
});

describe('save payload', () => {
  it('never sends generated strips back', () => {
    const doc = withStamps();
    const assets: DraftAsset[] = [
      ...doc.assets,
      {
        name: 'stamps/strips/3/strip@2x.png',
        slot: 'strip',
        scale: 2,
        size: 1,
        sha1: 'a'.repeat(40),
      },
    ];
    const names = assetsPayload(assets).map((a) => a.name);
    expect(names).not.toContain('stamps/strips/3/strip@2x.png');
    expect(names).toContain('stamps/filled.png');
  });
});

describe('stamp art files', () => {
  it('takes a square PNG of 128 to 1000 px', () => {
    expect(placeStampArt('stamps/filled.png', bytesOf('stamps/filled.png'))).toMatchObject({
      ok: true,
    });
  });
  it('refuses text, and PNGs that are not square or are the wrong size', () => {
    expect(placeStampArt('stamps/filled.png', new Uint8Array(40))).toMatchObject({ ok: false });
    const wide = bytesOf('strip@2x.png');
    expect(placeStampArt('stamps/filled.png', wide)).toMatchObject({ ok: false });
  });
});

describe('browser preview', () => {
  it('draws the bytes the server stores for the same count', async () => {
    const doc = withStamps();
    doc.assets = [
      ...doc.assets,
      {
        name: 'strip@2x.png',
        slot: 'strip',
        scale: 2,
        size: 1,
        upload: toBase64(bytesOf('strip@2x.png')),
      },
    ];
    const url = await drawStrip(doc, '/unused', 4);
    const files = new Map(
      doc.assets.map((a) => [
        a.name,
        a.upload ? Uint8Array.from(atob(a.upload), (c) => c.charCodeAt(0)) : bytesOf(a.name),
      ]),
    );
    const server = renderStampFiles(doc.manifest.stamps as never, files, {
      counts: [4],
    }).strips.find((s) => s.scale === 2);
    expect(url).toBe(`data:image/png;base64,${toBase64(server?.bytes as Uint8Array)}`);
  });

  it('draws nothing without a block', async () => {
    expect(await drawStrip(storeCard(), '/unused', 1)).toBeNull();
  });
});
