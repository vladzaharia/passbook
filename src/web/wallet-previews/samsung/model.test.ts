import { describe, expect, it } from 'vitest';
import { samsungModel } from './model.ts';

describe('samsungModel', () => {
  it('reads a ticket: banner, dates, reservation, code, notice, support and app link', () => {
    const m = samsungModel({
      type: 'ticket',
      subType: 'others',
      state: 'ACTIVE',
      attributes: {
        title: 'Spring Concert',
        providerName: 'Northwind',
        mainImg: 'https://img/m.png',
        logoImage: 'https://img/l.png',
        bgColor: '#5e0636',
        fontColor: '#ffffff',
        startDate: '1906596000000',
        reservationNumber: 'R-1',
        'barcode.ptFormat': 'QRCODE',
        'barcode.value': 'CODE-1',
        noticeDesc: 'Doors 18:00',
        'csInfo.call': '+15550100',
        appLinkName: 'Northwind',
        appLinkLogo: 'https://img/a.png',
        locations: JSON.stringify([{ lat: 1, lng: 2, name: 'Venue nearby' }]),
      },
    });
    expect(m).toMatchObject({
      kind: 'Ticket',
      title: 'Spring Concert',
      image: 'https://img/m.png',
      fg: 'light',
      barcode: { bcid: 'qrcode', message: 'CODE-1' },
      notice: 'Doors 18:00',
      contacts: [{ label: 'Call', value: '+15550100' }],
      app: { name: 'Northwind', logo: 'https://img/a.png' },
      places: ['Venue nearby'],
    });
    expect(m.facts.map((f) => f.label)).toEqual(['Starts', 'Reservation']);
  });

  it('reads loyalty amounts and dark text, and ignores unreadable locations', () => {
    const m = samsungModel({
      type: 'loyalty',
      attributes: {
        title: '25',
        amount: '25 pts',
        balance: '5 USD',
        fontColor: '#000000',
        bgImage: 'https://img/b.png',
        locations: 'not json',
      },
    });
    expect(m.amounts).toEqual([
      { label: 'Points', value: '25 pts' },
      { label: 'Balance', value: '5 USD' },
    ]);
    expect(m.fg).toBe('dark');
    expect(m.image).toBe('https://img/b.png');
    expect(m.places).toEqual([]);
  });
});
