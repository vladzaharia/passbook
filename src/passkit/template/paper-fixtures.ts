import type { PassJson, TemplateManifest } from '../types.ts';

/** An event ticket with the facts a printed ticket reads, in semantics and fields. */
export const EVENT_PASS = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.test',
  teamIdentifier: 'TEAM',
  serialNumber: 's-1',
  organizationName: 'Northwind Hall',
  description: 'Spring Concert',
  semantics: {
    eventName: 'Spring Concert',
    eventStartDate: '2027-04-12T19:30:00-05:00',
    venueName: 'Northwind Hall',
    attendeeName: 'Ada Lovelace',
    admissionLevel: 'General admission',
    seats: [{ seatSection: 'B', seatRow: '4', seatNumber: '12' }],
  },
  eventTicket: {
    primaryFields: [{ key: 'event', label: 'Event', value: 'Spring Concert' }],
    secondaryFields: [{ key: 'level', label: 'Level', value: 'Balcony' }],
    auxiliaryFields: [{ key: 'order', label: 'Order', value: 'A-1042' }],
    backFields: [{ key: 'terms', label: 'Terms', value: 'No refunds.' }],
  },
  barcodes: [
    { format: 'PKBarcodeFormatQR', message: 'SECRET-SCAN-CODE', messageEncoding: 'utf-8' },
  ],
} as unknown as PassJson;

export const EVENT_MANIFEST = {
  schema: 1,
  name: 'Concert',
  inputs: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      ticketNo: { type: 'string' },
      terms: { type: 'string' },
    },
  },
  sample: { name: 'Ada', ticketNo: 'T-77', terms: 'No refunds. Doors 18:30.' },
  display: { title: '{{name}}' },
  scan: { lookup: { input: 'ticketNo' } },
  bindings: [{ to: { field: 'order' }, value: '{{ticketNo}}' }],
} as unknown as TemplateManifest;
