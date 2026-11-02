import { describe, expect, it } from 'vitest';
import { PassBuildError, planPass } from './build.ts';
import { localizeDates, localZones, toLocalIso } from './build-local-time.ts';
import { InMemoryTemplateRegistry } from './template/in-memory-registry.ts';
import { FIXTURE_IDENTITY } from './testing/fixture-identity.ts';
import type { PassJson, Personalization, SigningMaterial, TemplateManifest } from './types.ts';

const at = (iso: string) => Date.parse(iso);

describe('toLocalIso', () => {
  it('writes the wall clock with the zone offset, west and east of UTC', () => {
    expect(toLocalIso(at('2026-11-17T01:00:00.763Z'), 'America/Los_Angeles')).toBe(
      '2026-11-16T17:00:00-08:00',
    );
    expect(toLocalIso(at('2026-07-17T01:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-07-16T18:00:00-07:00',
    );
    expect(toLocalIso(at('2026-11-16T20:30:00Z'), 'Asia/Kolkata')).toBe(
      '2026-11-17T02:00:00+05:30',
    );
    expect(toLocalIso(at('2026-11-16T20:30:00Z'), 'UTC')).toBe('2026-11-16T20:30:00+00:00');
  });
});

describe('localizeDates', () => {
  const pass = () =>
    ({
      semantics: {
        departureLocationTimeZone: 'America/Los_Angeles',
        destinationLocationTimeZone: 'America/New_York',
      },
      boardingPass: {
        headerFields: [
          {
            key: 'date',
            value: '2026-11-17T01:00:00Z',
            timeStyle: 'PKDateStyleNone',
            ignoresTimeZone: true,
          },
        ],
        secondaryFields: [
          { key: 'departs', value: '2026-11-17T01:00:00Z', ignoresTimeZone: true },
          { key: 'arrives', value: '2026-11-17T06:00:00Z', ignoresTimeZone: true },
          {
            key: 'since',
            value: '2026-01-01T00:00:00Z',
            timeStyle: 'PKDateStyleNone',
            ignoresTimeZone: true,
          },
          { key: 'utc', value: '2026-11-17T01:00:00Z' },
        ],
      },
    }) as unknown as PassJson;

  it('uses departure and arrival zones and leaves calendar dates and plain instants alone', () => {
    const p = pass();
    localizeDates(p, localZones(p, undefined));
    const fields = (p as never as { boardingPass: Record<string, { value: string }[]> })
      .boardingPass;
    expect(fields.headerFields?.[0]?.value).toBe('2026-11-16T17:00:00-08:00');
    expect(fields.secondaryFields?.map((f) => f.value)).toEqual([
      '2026-11-16T17:00:00-08:00',
      '2026-11-17T01:00:00-05:00',
      '2026-01-01T00:00:00Z',
      '2026-11-17T01:00:00Z',
    ]);
  });

  it('prefers the input zone', () => {
    const p = pass();
    localizeDates(p, localZones(p, 'Asia/Tokyo'));
    const first = (p as never as { boardingPass: { headerFields: { value: string }[] } })
      .boardingPass.headerFields[0];
    expect(first?.value).toBe('2026-11-17T10:00:00+09:00');
  });
});

describe('planPass with an x-timeZone input', () => {
  const manifest: TemplateManifest = {
    schema: 1,
    name: 'Event',
    inputs: {
      type: 'object',
      required: ['startsAt'],
      properties: {
        startsAt: { type: 'string', format: 'date-time' },
        venueTimeZone: { type: 'string', 'x-timeZone': true },
      },
    },
    sample: { startsAt: '2030-06-01T19:00:00-07:00' },
    bindings: [{ to: { field: ['date', 'time'] }, value: '{{startsAt}}' }],
    display: { title: 'Event' },
  };
  const passJson = {
    formatVersion: 1,
    description: 'd',
    eventTicket: {
      headerFields: [
        {
          key: 'date',
          label: 'Date',
          value: '',
          dateStyle: 'PKDateStyleMedium',
          timeStyle: 'PKDateStyleNone',
          ignoresTimeZone: true,
        },
      ],
      secondaryFields: [
        {
          key: 'time',
          label: 'Starts',
          value: '',
          dateStyle: 'PKDateStyleNone',
          timeStyle: 'PKDateStyleShort',
          ignoresTimeZone: true,
        },
      ],
    },
  } as unknown as PassJson;
  const registry = new InMemoryTemplateRegistry();
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const template = registry.add({ id: 'ev', manifest, passJson, assets: { 'icon.png': PNG } });
  const plan = (input: Personalization) =>
    planPass({
      template,
      registry,
      input,
      signing: {} as SigningMaterial,
      server: {
        serial: 's',
        authToken: 'a'.repeat(32),
        webServiceURL: 'https://wallet.example/wallet',
        organizationName: 'Org',
        identity: FIXTURE_IDENTITY,
      },
    });

  it('signs a UTC start as the venue wall clock', () => {
    const { passJson: out } = plan({
      startsAt: '2026-11-17T00:55:00Z',
      venueTimeZone: 'America/Los_Angeles',
    });
    const ev = (out as never as { eventTicket: Record<string, { value: string }[]> }).eventTicket;
    expect(ev.headerFields?.[0]?.value).toBe('2026-11-16T16:55:00-08:00');
    expect(ev.secondaryFields?.[0]?.value).toBe('2026-11-16T16:55:00-08:00');
  });

  it('refuses a UTC start with no zone, and an unknown zone', () => {
    const issues = (input: Personalization) => {
      try {
        plan(input);
        return [];
      } catch (error) {
        if (!(error instanceof PassBuildError)) throw error;
        return error.report.issues.filter((i) => i.severity === 'error').map((i) => i.code);
      }
    };
    expect(issues({ startsAt: '2026-11-17T00:55:00Z' })).toContain('LOCAL_TIME');
    expect(issues({ startsAt: '2026-11-17T00:55:00Z', venueTimeZone: 'Mars/Base' })).toEqual([
      'INPUT',
    ]);
    expect(issues({ startsAt: '2026-11-16T16:55:00-08:00' })).toEqual([]);
  });
});
