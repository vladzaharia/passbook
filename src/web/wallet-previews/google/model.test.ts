import { describe, expect, it } from 'vitest';
import { googleModel } from './model.ts';

const text = (value: string) => ({ defaultValue: { language: 'en', value } });
const image = (uri: string) => ({ sourceUri: { uri }, contentDescription: text('x') });

describe('googleModel', () => {
  it('reads a generic object: title row, subheader, hero, code and details', () => {
    const m = googleModel(
      'generic',
      {},
      {
        cardTitle: text('Northwind'),
        header: text('Ada Lovelace'),
        subheader: text('Gold'),
        logo: image('https://img/logo.png'),
        heroImage: image('https://img/hero.png'),
        hexBackgroundColor: '#112233',
        state: 'ACTIVE',
        barcode: { type: 'QR_CODE', renderEncoding: 'UTF_8', value: 'CODE-1', alternateText: 'A1' },
        textModulesData: [
          { id: 'a', header: 'Tier', body: 'Plus' },
          { id: 'b', body: '' },
        ],
        linksModuleData: { uris: [{ id: 'l', uri: 'https://x.test', description: 'Site' }] },
      },
    );
    expect(m).toMatchObject({
      kind: 'Generic',
      issuer: 'Northwind',
      heading: 'Ada Lovelace',
      subheader: 'Gold',
      bg: '#112233',
      logo: 'https://img/logo.png',
      hero: 'https://img/hero.png',
      barcode: { bcid: 'qrcode', message: 'CODE-1', alt: 'A1' },
      modules: [{ header: 'Tier', body: 'Plus' }],
      links: [{ description: 'Site', uri: 'https://x.test' }],
    });
  });

  it('reads an event: the class carries the event, the object the seat and holder', () => {
    const m = googleModel(
      'event',
      {
        issuerName: 'Northwind Hall',
        eventName: text('Spring Concert'),
        venue: { name: text('Main hall') },
        dateTime: { start: '2030-06-01T19:00:00-07:00' },
        heroImage: image('https://img/h.png'),
        hexBackgroundColor: '#5e0636',
      },
      {
        ticketHolderName: 'Ada',
        seatInfo: { section: text('B'), row: text('4') },
        state: 'ACTIVE',
      },
    );
    expect(m.kind).toBe('Event ticket');
    expect(m.heading).toBe('Spring Concert');
    expect(m.issuer).toBe('Northwind Hall');
    expect(m.facts.map((f) => f.label)).toEqual([
      'Date',
      'Venue',
      'Section',
      'Row',
      'Ticket holder',
    ]);
    expect(m.bg).toBe('#5e0636');
  });

  it('reads loyalty points, gift balance and an offer title', () => {
    const loyalty = googleModel(
      'loyalty',
      { programName: 'Club', programLogo: image('https://img/p.png') },
      {
        loyaltyPoints: { label: 'pts', balance: { int: 1250 } },
        accountName: 'Ada',
        accountId: 'M-1',
      },
    );
    expect(loyalty.heading).toBe('1,250 pts');
    expect(loyalty.subheader).toBe('Ada');
    expect(loyalty.facts).toEqual([{ label: 'Account', value: 'M-1' }]);

    const gift = googleModel(
      'gift',
      { merchantName: 'Cafe' },
      { cardNumber: '123', balance: { micros: '25000000', currencyCode: 'USD' } },
    );
    expect(gift.heading).toBe('$25.00');

    const offer = googleModel(
      'offer',
      {
        provider: 'Cafe',
        title: '2 for 1',
        redemptionChannel: 'INSTORE',
        finePrint: 'One per visit.',
      },
      {},
    );
    expect(offer.heading).toBe('2 for 1');
    expect(offer.facts).toEqual([{ label: 'Redeem', value: 'In store' }]);
    expect(offer.modules).toEqual([{ header: 'Fine print', body: 'One per visit.' }]);
  });

  it('draws no code for a type it cannot name', () => {
    const m = googleModel('generic', {}, { barcode: { type: 'TEXT_ONLY', value: 'x' } });
    expect(m.barcode).toBeUndefined();
  });
});
