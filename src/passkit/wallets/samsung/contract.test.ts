/**
 * Samsung contract: compiled cards and the Update Notification bodies against Samsung's documented
 * shapes, and the fixtures under test/fixtures/wallets/samsung against the same shapes. Fixtures are
 * doc-shape until the owner records real ones (journey 20); the same assertions then hold them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import { loadFixture, loadFixtures } from '../contract-fixtures.ts';
import { compile, view } from './fixtures.ts';
import { samsungCardBody } from './index.ts';
import { cardBody, updateNotification } from './shapes.ts';

const TYPES = ['loyalty', 'ticket', 'coupon'] as const;
const META = { refId: 'r'.repeat(32), createdAt: new Date(1e12), updatedAt: new Date(1e12) };

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

describe('compiled cards fit Samsung card shapes', () => {
  for (const slug of bakedSlugs())
    it(`${slug}: the card body has every required attribute and fits the limits`, async () => {
      const result = compile(await view(slug));
      expect(result.blocked, slug).toBeUndefined();
      const data = result.cardData as Parameters<typeof samsungCardBody>[0];
      const type = data.type;
      expect(
        cardBody(type).safeParse(samsungCardBody(data, META)).error?.issues,
        `${slug} ${type}`,
      ).toBeUndefined();
    });

  it('covers every card type the compiler writes across the baked templates', async () => {
    const seen = new Set<string>();
    for (const slug of bakedSlugs()) seen.add(compile(await view(slug)).type);
    expect([...seen].sort()).toEqual([...TYPES].sort());
  });
});

describe('shape checks reject what Samsung rejects', () => {
  const good = () => ({
    card: {
      type: 'loyalty',
      subType: 'others',
      data: [
        {
          refId: 'r1',
          state: 'ACTIVE',
          createdAt: 1,
          updatedAt: 1,
          language: 'en',
          attributes: {
            title: 'T',
            providerName: 'P',
            appLinkLogo: 'https://l',
            appLinkName: 'N',
            appLinkData: 'https://d',
          },
        },
      ],
    },
  });

  it('accepts the minimal loyalty card', () => {
    expect(cardBody('loyalty').safeParse(good()).success).toBe(true);
  });

  it('rejects a card missing a required attribute', () => {
    const card = good();
    const { providerName: _dropped, ...rest } = card.card.data[0]?.attributes ?? {};
    (card.card.data[0] as { attributes: unknown }).attributes = rest;
    expect(cardBody('loyalty').safeParse(card).success).toBe(false);
  });

  it('rejects a title over 32 bytes', () => {
    const card = good();
    (card.card.data[0] as { attributes: Record<string, string> }).attributes.title = 'é'.repeat(17);
    expect(cardBody('loyalty').safeParse(card).success).toBe(false);
  });

  it('rejects a seventh data item, a long refId and an unknown key', () => {
    const seven = good();
    seven.card.data = Array.from({ length: 7 }, () => good().card.data[0] as never);
    expect(cardBody('loyalty').safeParse(seven).success).toBe(false);
    const long = good();
    (long.card.data[0] as { refId: string }).refId = 'r'.repeat(33);
    expect(cardBody('loyalty').safeParse(long).success).toBe(false);
    expect(cardBody('loyalty').safeParse({ ...good(), extra: 1 }).success).toBe(false);
  });

  it('rejects an Update Notification state Samsung does not list', () => {
    const body = { card: { type: 'loyalty', data: [{ refId: 'r', state: 'REMOVED' }] } };
    expect(updateNotification.safeParse(body).success).toBe(false);
  });
});

describe('fixtures', () => {
  const all = loadFixtures('samsung');

  it('has Get Card Data, Update Notification and Send Card State fixtures for every type', () => {
    for (const type of TYPES) {
      expect(
        all.some((f) => f.name === `${type}-get-card-data`),
        type,
      ).toBe(true);
      for (const state of ['updated', 'canceled', 'active', 'expired', 'deleted'])
        expect(
          all.some((f) => f.name === `${type}-update-${state}`),
          `${type} ${state}`,
        ).toBe(true);
    }
    for (const event of ['added', 'deleted'])
      expect(
        all.some((f) => f.name === `send-card-state-${event}`),
        event,
      ).toBe(true);
  });

  it('declares where every fixture came from', () => {
    for (const f of all) expect(['recorded', 'doc-shape'], f.name).toContain(f.provenance);
    for (const f of all.filter((x) => x.provenance === 'doc-shape'))
      expect(f.note, f.name).toContain('Doc-shape, not recorded');
  });

  for (const type of TYPES)
    it(`${type}: the Get Card Data answer fits the card shape`, () => {
      const f = loadFixture('samsung', `${type}-get-card-data`);
      expect(f.body.response.status).toBe(200);
      expect(cardBody(type).safeParse(f.body.response.body).error?.issues).toBeUndefined();
    });

  for (const f of all.filter((x) => x.name.includes('-update-')))
    it(`${f.name}: the request is an Update Notification to the cards updates path`, () => {
      expect(f.body.request.method).toBe('POST');
      expect(f.body.request.path).toMatch(/^\/[A-Z]{2}\/wltex\/cards\/[^/]+\/updates$/);
      expect(updateNotification.safeParse(f.body.request.body).error?.issues).toBeUndefined();
      expect(f.body.response.status).toBe(200);
    });

  for (const f of all.filter((x) => x.name.startsWith('send-card-state-')))
    it(`${f.name}: carries cc2 and a documented event and is answered 200`, () => {
      const url = new URL(f.body.request.path, 'https://worker.example');
      expect(url.searchParams.get('cc2')).toMatch(/^[A-Z]{2}$/);
      expect(['ADDED', 'DELETED', 'UPDATED', 'PROVISIONED']).toContain(
        url.searchParams.get('event'),
      );
      expect(f.body.response.status).toBe(200);
    });
});
