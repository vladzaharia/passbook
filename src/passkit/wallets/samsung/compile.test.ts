import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import { fidelityReport, statusLabel } from '../fidelity.ts';
import type { CompileResult, RoleValue, WalletPassView } from '../types.ts';
import { attributes, compile, NOW, view } from './fixtures.ts';
import { samsungCardBody, samsungCompiler } from './index.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

const lines = (r: CompileResult): string[] =>
  r.items.map((i) => `${i.capability} | ${i.support} | ${i.path}`);
const text = (value: string): RoleValue => ({
  kind: 'text',
  text: value,
  source: 'manifest',
  fields: [],
});
const without = (
  v: WalletPassView,
  ...roles: (keyof WalletPassView['roles'])[]
): WalletPassView => {
  const copy = { ...v.roles };
  for (const role of roles) delete copy[role];
  return { ...v, roles: copy };
};

describe('samsung compiler over every starter and baked template', () => {
  it.each(bakedSlugs())('%s', async (slug) => {
    const r = compile(await view(slug));
    expect(r.blocked).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('extendedFields');
    expect({ type: r.type, card: r.cardData, items: lines(r) }).toMatchSnapshot();
  });
});

describe('fidelity report', () => {
  it('gives every template a status, none blocked', async () => {
    const labels: Record<string, string> = {};
    for (const slug of bakedSlugs()) {
      const v = await view(slug);
      const report = fidelityReport({
        target: 'samsung',
        compiler: samsungCompiler,
        views: [v],
        now: NOW,
      });
      expect(report.status.kind).not.toBe('blocked');
      labels[slug] = `${report.type}: ${statusLabel(report.status)}`;
    }
    expect(labels).toMatchSnapshot();
  });
});

describe('type selection', () => {
  it('maps eventTicket, coupon and storeCard to their own types', async () => {
    expect(compile(await view('starter-event-ticket')).type).toBe('ticket');
    expect(compile(await view('starter-coupon')).type).toBe('coupon');
    expect(compile(await view('starter-store-card')).type).toBe('loyalty');
  });

  it.each(['starter-generic', 'starter-poster-generic', 'starter-boarding-pass', 'henrys-blue'])(
    'Q14: %s compiles as loyalty/others with a type omission',
    async (slug) => {
      const r = compile(await view(slug));
      expect(r.type).toBe('loyalty');
      expect((r.cardData as { subType: string }).subType).toBe('others');
      expect(r.items.find((i) => i.capability === 'type')).toMatchObject({ support: 'omitted' });
    },
  );

  it('Q14: a gift card shape compiles as loyalty with the same omission', async () => {
    const v = await view('starter-store-card');
    const gift = without(v, 'memberId', 'points');
    gift.roles.giftCardNumber = text('GC-1');
    const r = compile(gift);
    expect(r.type).toBe('loyalty');
    expect(r.items.find((i) => i.capability === 'type')?.message).toContain('giftcard');
  });

  it('Q14: an explicit generic or giftcard type does the same', async () => {
    for (const type of ['generic', 'giftcard']) {
      const v = await view('starter-store-card', { wallets: { schema: 1, samsung: { type } } });
      const r = compile(v);
      expect(r.type).toBe('loyalty');
      expect(r.items.find((i) => i.capability === 'type')?.message).toContain(type);
    }
  });

  it('Q14: the omission is approved by naming type, and blocks when type is required', async () => {
    const generic = await view('starter-generic', {
      wallets: { schema: 1, samsung: { omit: ['type'] } },
    });
    const report = fidelityReport({
      target: 'samsung',
      compiler: samsungCompiler,
      views: [generic],
      ...(generic.wallets ? { wallets: generic.wallets } : {}),
      now: NOW,
    });
    expect(report.type).toBe('loyalty');
    expect(report.items.find((i) => i.capability === 'type')).toMatchObject({
      severity: 'omission',
      chosen: true,
    });
    const required = await view('starter-generic', {
      wallets: { schema: 1, required: ['type'] },
    });
    const blocked = compile(required);
    expect(blocked.blocked?.code).toBe('TYPE_UNSATISFIED');
    expect(blocked.cardData).toBeUndefined();
  });

  it('falls back to loyalty when a ticket lacks its event start', async () => {
    const v = without(await view('starter-event-ticket'), 'eventStart');
    const r = compile(v);
    expect(r.type).toBe('loyalty');
    expect(r.items.find((i) => i.capability === 'type')?.message).toContain('a start time');
  });

  it('falls back to loyalty when a coupon lacks an expiry or a main image', async () => {
    const v = without(await view('starter-coupon'), 'validUntil');
    expect(compile(v).items.find((i) => i.capability === 'type')?.message).toContain(
      'an expiry date',
    );
    const noArt = { ...(await view('starter-coupon')) };
    noArt.images = { ...noArt.images, apple: { logo: noArt.images.apple.logo ?? [] } };
    expect(compile(noArt).items.find((i) => i.capability === 'type')?.message).toContain(
      'a main image',
    );
  });

  it('honours type off', async () => {
    const v = await view('starter-coupon', { wallets: { schema: 1, samsung: { type: 'off' } } });
    expect(compile(v)).toEqual({ type: 'off', items: [] });
  });

  it('blocks when a required role is empty', async () => {
    const v = await view('starter-coupon', { wallets: { schema: 1, required: ['role.tier'] } });
    expect(compile(v).blocked).toMatchObject({ code: 'REQUIRED_ROLE_EMPTY' });
  });
});

describe('ticket details', () => {
  it('uses the barcode message as the reservation number when no role gives one', async () => {
    const r = compile(await view('starter-event-ticket'));
    // The barcode is the scan code (PS-28).
    expect(attributes(r).reservationNumber).toBe('SNAPSHOT-SCAN-CODE');
  });

  it('prefers a confirmation code and keeps the ticket number as a notice line', async () => {
    const v = await view('starter-event-ticket');
    v.roles.confirmationCode = text('CONF-9');
    v.roles.ticketNumber = text('NUM-3');
    const a = attributes(compile(v));
    expect(a.reservationNumber).toBe('CONF-9');
    expect(a.noticeDesc).toContain('Ticket number: NUM-3');
  });

  it('takes the subtype from the author, then from the eventType tag', async () => {
    const authored = await view('starter-event-ticket', {
      wallets: { schema: 1, samsung: { subType: 'sports' } },
    });
    expect((compile(authored).cardData as { subType: string }).subType).toBe('sports');
    const tagged = await view('starter-event-ticket');
    tagged.fields = tagged.fields.map((f, i) =>
      i === 0 ? { ...f, semantics: { eventType: 'PKEventTypeMovie' } } : f,
    );
    expect((compile(tagged).cardData as { subType: string }).subType).toBe('movies');
  });

  it('shows the next event of a multi-event pass and says so', async () => {
    const v = await view('starter-event-ticket');
    const [first, second] = v.events;
    expect(first?.date && second?.date).toBeTruthy();
    const r = compile(v, { now: new Date('2030-06-05T00:00:00Z') });
    expect(attributes(r).startDate).toBe(String(Date.parse(second?.date as string)));
    expect(lines(r)).toContain('upcoming.multi | difference | events');
  });
});

describe('state, time and the envelope', () => {
  it('sets the card state from the pass', async () => {
    const v = await view('starter-store-card');
    const state = (x: WalletPassView) => (compile(x).cardData as { state: string }).state;
    expect(state(v)).toBe('ACTIVE');
    expect(state({ ...v, validity: { ...v.validity, voided: true } })).toBe('CANCELED');
    expect(state({ ...v, validity: { ...v.validity, expired: true } })).toBe('EXPIRED');
  });

  it('does not depend on the clock: updatedAt is the pass revision time (R10)', async () => {
    const v = await view('starter-store-card');
    const a = compile(v, { now: new Date('2026-01-01T00:00:00Z') });
    const b = compile(v, { now: new Date('2031-01-01T00:00:00Z') });
    expect(b.cardData).toEqual(a.cardData);
    const body = samsungCardBody(a.cardData as never, {
      refId: 'REF',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      updatedAt: new Date('2026-03-01T00:00:00Z'),
    });
    expect(body.card.data[0]).toMatchObject({
      refId: 'REF',
      state: 'ACTIVE',
      createdAt: Date.parse('2026-02-01T00:00:00Z'),
      updatedAt: Date.parse('2026-03-01T00:00:00Z'),
    });
  });

  it('keeps the ticket issue date at the pass issue time', async () => {
    const v = await view('starter-event-ticket');
    const issuedAt = new Date('2026-05-05T05:05:05Z');
    expect(attributes(compile(v, { issuedAt })).issueDate).toBe(String(issuedAt.getTime()));
  });

  it('writes localized title and notice only where they differ', async () => {
    const v = await view('starter-event-ticket');
    v.localization = { de: { 'Sample Event': 'Beispiel', Admission: 'Eintritt' }, en: {} };
    const data = compile(v).cardData as {
      localization?: { language: string; attributes: Record<string, string> }[];
    };
    expect(data.localization).toHaveLength(1);
    expect(data.localization?.[0]).toMatchObject({
      language: 'de',
      attributes: { title: 'Beispiel' },
    });
    expect(data.localization?.[0]?.attributes.noticeDesc).toContain('Eintritt: General');
  });
});

describe('change text', () => {
  it("writes a notifying field's change message into the notice with its value filled in", async () => {
    const v = await view('starter-store-card');
    const field = v.fields[0];
    if (!field) throw new Error('fixture has no field');
    field.changeMessage = 'Now %@ (100%%)';
    const r = compile(v);
    expect(attributes(r).noticeDesc).toContain(`Now ${field.text} (100%)`);
    expect(lines(r)).toContain(`messaging.notify | text | ${field.path}`);
  });
});

describe('author choices', () => {
  it('leaves a field out when it is named in omit and reports it', async () => {
    const v = await view('starter-store-card', {
      wallets: { schema: 1, samsung: { omit: ['backFields.terms'] } },
    });
    const r = compile(v, { omit: ['backFields.terms'] });
    expect(attributes(r).noticeDesc).not.toContain('Balance is not redeemable');
    expect(lines(r)).toContain('field.back | omitted | backFields.terms');
  });
});
