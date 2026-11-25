import { describe, expect, it } from 'vitest';
import { fence, guideApi, snippetBody } from './guide-api.ts';

const TEMPLATE = '0193a1b2-7c00-7000-8000-0000000000b1';
const ORG = '0193a1b2-7c00-7000-8000-0000000000a1';

/** The claims of the auto-mapping and change-many-passes guides, each proven by the API. */
describe('import with auto mapping', () => {
  it('maps the file, reports the bad cell, takes the fix, and starts the commit', async () => {
    const { call } = await guideApi();
    const made = await call(
      'POST',
      '/pass-imports',
      fence('import-auto-map', 'pass-imports.postPassImports'),
    );
    expect(made.status).toBe(201);
    expect(made.json.state).toBe('ready');
    expect(made.json.counts).toMatchObject({ rows: 3, create: 2, errors: 1, errorsCreate: 1 });
    expect(made.json.problems[0]).toMatchObject({
      row: 3,
      column: 'Starts',
      field: 'startsAt',
      code: 'IMPORT_DATE_UNREADABLE',
      value: 'TBD',
    });
    expect(made.json.mapping).toMatchObject({ missing: [], unused: [], columns: 8, used: 8 });

    const checked = await call(
      'POST',
      `/pass-imports/${made.json.id}/check`,
      snippetBody('import-fix-cells'),
    );
    expect(checked.status).toBe(200);
    expect(checked.json.counts).toMatchObject({ create: 3, errors: 0 });

    const commit = await call(
      'POST',
      `/pass-imports/${made.json.id}/commit`,
      fence('import-auto-map', 'pass-imports.postPassImportsByIdCommit'),
    );
    expect(commit.status).toBe(200);
    expect(commit.json.state).toBe('committing');
    // The workflow runs once the commit has answered: the import ends done with its passes.
    const done = await call('GET', `/pass-imports/${made.json.id}`);
    expect(done.json.state).toBe('done');
    expect(done.json.progress).toMatchObject({ created: 3, failed: 0 });
    const listed = await call('GET', '/passes?status=active');
    expect(listed.json.items.length).toBeGreaterThanOrEqual(4);
    // Undo removes what the import created and the answer reads back done.
    const undo = await call('POST', `/pass-imports/${made.json.id}/undo`, {});
    expect(undo.status).toBe(200);
    const after = await call('GET', `/pass-imports/${made.json.id}`);
    expect(after.json.undo.state).toBe('done');
  });

  it('leaves state mapping with no plan when no column fits, and asks for a date format when two fit', async () => {
    const { call } = await guideApi();
    const none = await call('POST', '/pass-imports', {
      templateId: TEMPLATE,
      source: { kind: 'file', name: 'x.csv', csv: 'Foo,Bar\n1,2' },
      mapping: 'auto',
    });
    expect(none.json.state).toBe('mapping');
    expect(none.json.plan).toBeNull();
    expect(none.json.mapping.missing).toContain('startsAt');

    const head = 'Holder email,Event,Venue,City,Starts,Ends,Attendee,Ticket ID';
    const row = (n: string, d: string) =>
      `${n}@example.com,Harbor Night,Harbor Hall,"Cupertino, CA",${d},2030-06-01T22:00:00-07:00,${n},T-${n}`;
    const csv = [head, row('ada', '03/04/2030'), row('bo', '05/06/2030')].join('\n');
    const made = await call('POST', '/pass-imports', {
      templateId: TEMPLATE,
      source: { kind: 'file', name: 'dates.csv', csv },
      mapping: 'auto',
    });
    const starts = made.json.mapping.fields.find(
      (f: { target: string }) => f.target === 'startsAt',
    );
    expect(starts.entry).toBeNull();
    expect(starts.date.choices).toEqual(['mdy', 'dmy']);
    expect(made.json.problems[0].message).toBe('Starts is required.');

    // The guide's one-line fix: name the format.
    const plan = {
      ...made.json.plan,
      mapping: {
        ...made.json.plan.mapping,
        startsAt: {
          from: '/Starts',
          transform: { kind: 'date', options: { input: 'mdy', output: 'iso' } },
        },
      },
    };
    const fixed = await call('POST', `/pass-imports/${made.json.id}/check`, { plan });
    expect(fixed.json.counts).toMatchObject({ create: 2, errors: 0 });
  });
});

describe('change many passes', () => {
  it('previews and starts a run in a sandbox', async () => {
    const { call } = await guideApi();
    const pass = await call('POST', '/passes', fence('change-many-passes', 'passes.postPasses'));
    expect(pass.status, pass.text).toBe(201);
    const preview = await call(
      'POST',
      '/broadcasts/preview',
      fence('change-many-passes', 'broadcasts.postBroadcastsPreview'),
    );
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ targeted: 1, unchanged: 0, blocked: [], estimated: true });
    expect(preview.json.samples[0].changes).toEqual([
      { key: 'venueName', label: 'Venue', from: 'Harbor Hall', to: 'Pier 9' },
    ]);
    const body = snippetBody('change-run');
    const started = await call('POST', '/broadcasts', body);
    expect(started.status).toBe(201);
    expect(['scheduled', 'sending']).toContain(started.json.state);
    expect((await call('GET', `/broadcasts/${started.json.id}`)).status).toBe(200);
  });

  it('starts with the preview count, refuses a drifted count, and cannot undo a running run', async () => {
    const { call } = await guideApi({ sandbox: false });
    const pass = await call('POST', '/passes', fence('change-many-passes', 'passes.postPasses'));
    expect(pass.status, pass.text).toBe(201);
    const body = snippetBody('change-run') as { target: Record<string, unknown> };
    const drifted = await call('POST', '/broadcasts', {
      ...body,
      target: { ...body.target, expectCount: 2 },
    });
    expect([drifted.status, drifted.json.code]).toEqual([409, 'SELECTION_CHANGED']);

    const started = await call('POST', '/broadcasts', body);
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({ kind: 'change', notify: false });
    expect(['scheduled', 'sending']).toContain(started.json.state);

    const read = await call('GET', `/broadcasts/${started.json.id}`);
    expect(read.json.counts).toHaveProperty('overBudget');
    const early = await call('POST', `/broadcasts/${started.json.id}/undo`);
    expect([early.status, early.json.code]).toEqual([409, 'BROADCAST_NOT_UNDOABLE']);
    expect((await call('POST', `/broadcasts/${started.json.id}/stop`)).status).toBe(200);
  });

  it('shifts dates and refuses a filter it does not know and what a run cannot take', async () => {
    const { call } = await guideApi({ sandbox: false });
    const target = { templateIds: [TEMPLATE] };
    const shift = await call('POST', '/broadcasts/preview', {
      orgId: ORG,
      target,
      patch: { startsAt: { shift: 'P1D' }, endsAt: { shift: 'P1D' } },
    });
    expect(shift.json.samples[0].changes.map((c: { key: string }) => c.key)).toEqual([
      'startsAt',
      'endsAt',
    ]);

    // A target key the run does not take is refused, never dropped.
    for (const filter of ['status', 'holderEmail', 'externalId', 'connectionId']) {
      const refusedFilter = await call('POST', '/broadcasts/preview', {
        orgId: ORG,
        target: { ...target, [filter]: 'x' },
      });
      expect([refusedFilter.status, refusedFilter.json.code]).toEqual([
        422,
        'BROADCAST_UNSUPPORTED_FILTER',
      ]);
      expect(refusedFilter.json.issues[0].path).toBe(`target.${filter}`);
    }

    const text = await call('POST', '/broadcasts/preview', {
      orgId: ORG,
      target: { ...target, match: [{ input: 'attendee', op: 'contains', value: 'Ada' }] },
    });
    expect([text.status, text.json.issues[0].message]).toEqual([
      422,
      'Runs match values or ranges.',
    ]);

    const two = await call('POST', '/broadcasts/preview', {
      orgId: ORG,
      target: { ...target, passIds: ['0193a1b2-7c00-7000-8000-0000000000c1'] },
    });
    expect(two.status).toBe(422);

    // An input the template lacks: preview shows nothing, the run refuses it.
    const unknown = { orgId: ORG, target, patch: { nope: { set: 'x' } } };
    const empty = await call('POST', '/broadcasts/preview', unknown);
    expect(empty.json.samples[0].changes).toEqual([]);
    const refused = await call('POST', '/broadcasts', {
      ...unknown,
      kind: 'change',
      send: 'now',
    });
    expect([refused.status, refused.json.code]).toEqual([422, 'BROADCAST_UNKNOWN_INPUT']);
  });
});
