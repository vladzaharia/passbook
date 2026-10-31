import { checkRules, poster, type Rule } from './rules-helpers.ts';

const RULES: Rule[] = [
  // Barcodes
  {
    rule: 'barcode format',
    fixture: 'generic',
    mutate: (p) => {
      p.barcodes[0].format = 'nope';
    },
    severity: 'error',
    code: 'BARCODE_FORMAT',
  },
  {
    rule: 'barcode message',
    fixture: 'generic',
    mutate: (p) => {
      delete p.barcodes[0].message;
    },
    severity: 'error',
    code: 'BARCODE',
  },
  {
    rule: 'barcode encoding',
    fixture: 'generic',
    mutate: (p) => {
      delete p.barcodes[0].messageEncoding;
    },
    severity: 'error',
    code: 'BARCODE',
  },
  {
    rule: 'new format needs fallback',
    fixture: 'generic',
    mutate: (p) => {
      p.barcodes.pop();
    },
    severity: 'warning',
    code: 'BARCODE_NO_FALLBACK',
  },
  {
    rule: 'fallback before new format',
    fixture: 'generic',
    mutate: (p) => {
      p.barcodes.reverse();
    },
    severity: 'warning',
    code: 'BARCODE_NO_FALLBACK',
  },
  {
    rule: 'Code 39 data',
    fixture: 'generic',
    mutate: (p) => {
      p.barcodes[0].message = 'abc';
    },
    severity: 'warning',
    code: 'BARCODE_DATA',
  },
  {
    rule: 'EAN-13 data',
    fixture: 'generic',
    mutate: (p) => {
      p.barcodes[0] = {
        format: 'PKBarcodeFormatEAN13',
        message: '12',
        messageEncoding: 'iso-8859-1',
      };
    },
    severity: 'warning',
    code: 'BARCODE_DATA',
  },
  {
    rule: 'legacy barcode deprecated',
    fixture: 'generic',
    mutate: (p) => {
      p.barcode = {
        format: 'PKBarcodeFormatQR',
        message: 'x',
        messageEncoding: 'iso-8859-1',
      };
    },
    severity: 'warning',
    code: 'BARCODE_DEPRECATED',
  },
  {
    rule: 'legacy barcode format',
    fixture: 'generic',
    mutate: (p) => {
      p.barcode = {
        format: 'PKBarcodeFormatCode128',
        message: 'x',
        messageEncoding: 'iso-8859-1',
      };
    },
    severity: 'error',
    code: 'BARCODE_FORMAT',
  },
  {
    rule: 'square barcode field budget',
    fixture: 'generic',
    mutate: (p) => {
      p.barcodes = [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }];
      p.generic.secondaryFields.push(...[1, 2, 3].map((i) => ({ key: `s${i}`, value: 'x' })));
      p.generic.auxiliaryFields.push({ key: 'a2', value: 'x' });
    },
    severity: 'warning',
    code: 'FIELD_COUNT',
  },
  // Relevance
  {
    rule: 'locations limit',
    fixture: 'generic',
    mutate: (p) => {
      p.locations = Array.from({ length: 11 }, () => ({ latitude: 1, longitude: 1 }));
    },
    severity: 'error',
    code: 'LOCATIONS',
  },
  {
    rule: 'latitude range',
    fixture: 'generic',
    mutate: (p) => {
      p.locations[0].latitude = 91;
    },
    severity: 'error',
    code: 'LOCATION',
  },
  {
    rule: 'longitude missing',
    fixture: 'generic',
    mutate: (p) => {
      delete p.locations[0].longitude;
    },
    severity: 'error',
    code: 'LOCATION',
  },
  {
    rule: 'relevantText org name',
    fixture: 'generic',
    mutate: (p) => {
      p.locations[0].relevantText = 'Welcome to Acme';
    },
    severity: 'warning',
    code: 'RELEVANT_TEXT',
  },
  {
    rule: 'root maxDistance not a number',
    fixture: 'generic',
    mutate: (p) => {
      p.maxDistance = '100';
    },
    severity: 'error',
    code: 'MAX_DISTANCE',
  },
  {
    rule: 'location maxDistance <= 0',
    fixture: 'coupon',
    mutate: (p) => {
      p.locations[0].maxDistance = 0;
    },
    severity: 'error',
    code: 'MAX_DISTANCE',
  },
  {
    rule: 'root maxDistance ignored',
    fixture: 'generic',
    mutate: (p) => {
      p.maxDistance = 100;
    },
    severity: 'warning',
    code: 'ROOT_MAX_DISTANCE',
  },
  {
    rule: 'beacon limit',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.beacons = Array.from({ length: 11 }, () => ({
        proximityUUID: '8DEEFBB9-F738-4297-8040-96668BB44281',
      }));
    },
    severity: 'error',
    code: 'BEACONS',
  },
  {
    rule: 'beacon uuid',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.beacons[0].proximityUUID = 'abc';
    },
    severity: 'error',
    code: 'BEACON',
  },
  {
    rule: 'beacon major range',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.beacons[0].major = 70000;
    },
    severity: 'error',
    code: 'BEACON',
  },
  {
    rule: 'relevantDates range > 24h',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.relevantDates = [{ startDate: '2026-12-01T00:00:00Z', endDate: '2026-12-03T00:00:00Z' }];
    },
    severity: 'error',
    code: 'RELEVANT_DATE_RANGE',
  },
  {
    rule: 'relevantDates end before start',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.relevantDates = [{ startDate: '2026-12-01T10:00:00Z', endDate: '2026-12-01T09:00:00Z' }];
    },
    severity: 'error',
    code: 'RELEVANT_DATES',
  },
  {
    rule: 'relevantDates endDate required',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.relevantDates = [{ startDate: '2026-12-01T10:00:00Z' }];
    },
    severity: 'error',
    code: 'RELEVANT_DATES',
  },
  {
    rule: 'relevantDates mixed forms',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.relevantDates = [
        {
          startDate: '2026-12-01T10:00:00Z',
          endDate: '2026-12-01T11:00:00Z',
          date: '2026-12-01T10:00:00Z',
        },
      ];
    },
    severity: 'error',
    code: 'RELEVANT_DATES',
  },
  {
    rule: 'relevantDates single form compat',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.relevantDates = [{ date: '2026-12-01T10:00:00Z' }];
    },
    severity: 'warning',
    code: 'RELEVANT_DATE_COMPAT',
  },
  {
    rule: 'relevantDates date format',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.relevantDates = [{ date: 'soon', relevantDate: 'soon' }];
    },
    severity: 'error',
    code: 'DATE',
  },
  {
    rule: 'generic date and location',
    fixture: 'generic',
    mutate: (p) => {
      p.relevantDates = [{ date: '2026-12-01T10:00:00Z', relevantDate: '2026-12-01T10:00:00Z' }];
    },
    severity: 'warning',
    code: 'RELEVANT_DATE_LOCATION',
  },
  {
    rule: 'poster date and location',
    fixture: poster,
    mutate: (p) => {
      p.relevantDate = '2026-12-01T10:00:00Z';
    },
    severity: 'warning',
    code: 'RELEVANT_DATE_LOCATION',
  },
  {
    rule: 'coupon date relevance',
    fixture: 'coupon',
    mutate: (p) => {
      p.relevantDate = '2026-12-01T10:00:00Z';
    },
    severity: 'warning',
    code: 'RELEVANT_DATE_STYLE',
  },
];

checkRules('rules-relevance', RULES);
