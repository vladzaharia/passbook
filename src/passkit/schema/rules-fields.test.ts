import { checkRules, pet, poster, type Rule, sbp } from './rules-helpers.ts';

const RULES: Rule[] = [
  // Fields
  {
    rule: 'duplicate key',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.backFields[0].key = 'g-p';
    },
    severity: 'error',
    code: 'DUPLICATE_FIELD_KEY',
  },
  {
    rule: 'missing key',
    fixture: 'generic',
    mutate: (p) => {
      delete p.generic.primaryFields[0].key;
    },
    severity: 'error',
    code: 'FIELD_KEY',
  },
  {
    rule: 'missing value',
    fixture: 'generic',
    mutate: (p) => {
      delete p.generic.primaryFields[0].value;
    },
    severity: 'error',
    code: 'FIELD_VALUE',
  },
  {
    rule: 'header count',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.headerFields.push(...[1, 2, 3].map((i) => ({ key: `h${i}`, value: 'x' })));
    },
    severity: 'warning',
    code: 'FIELD_COUNT',
  },
  {
    rule: 'poster footer count',
    fixture: poster,
    mutate: (p) => {
      p.posterGeneric.footerFields.push({ key: 'f2', value: 'x' });
    },
    severity: 'warning',
    code: 'FIELD_COUNT',
  },
  {
    rule: 'poster secondary not shown',
    fixture: poster,
    mutate: (p) => {
      p.posterGeneric.secondaryFields = [{ key: 's', value: 'x' }];
    },
    severity: 'warning',
    code: 'FIELD_NOT_SHOWN',
  },
  {
    rule: 'footerFields on generic',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.footerFields = [{ key: 'f', value: 'x' }];
    },
    severity: 'warning',
    code: 'FIELD_GROUP_STYLE',
  },
  {
    rule: 'additionalInfoFields on coupon',
    fixture: 'coupon',
    mutate: (p) => {
      p.coupon.additionalInfoFields = [{ key: 'f', value: 'x' }];
    },
    severity: 'warning',
    code: 'FIELD_GROUP_STYLE',
  },
  {
    rule: 'changeMessage without %@',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.headerFields[0].changeMessage = 'changed';
    },
    severity: 'error',
    code: 'CHANGE_MESSAGE',
  },
  {
    rule: 'date value needs zone',
    fixture: 'generic',
    mutate: (p) => {
      Object.assign(p.generic.primaryFields[0], {
        value: '2026-12-01T10:00',
        dateStyle: 'PKDateStyleShort',
        timeStyle: 'PKDateStyleShort',
      });
    },
    severity: 'error',
    code: 'FIELD_DATE',
  },
  {
    rule: 'date keys on text',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.primaryFields[0].dateStyle = 'PKDateStyleShort';
    },
    severity: 'warning',
    code: 'FIELD_DATE_KEYS',
  },
  {
    rule: 'dateStyle without timeStyle',
    fixture: 'generic',
    mutate: (p) => {
      Object.assign(p.generic.primaryFields[0], {
        value: '2026-12-01T10:00:00-08:00',
        dateStyle: 'PKDateStyleShort',
      });
    },
    severity: 'warning',
    code: 'FIELD_DATE_STYLE',
  },
  {
    rule: 'dateStyle enum',
    fixture: 'generic',
    mutate: (p) => {
      Object.assign(p.generic.primaryFields[0], {
        value: '2026-12-01T10:00:00Z',
        dateStyle: 'x',
        timeStyle: 'PKDateStyleShort',
      });
    },
    severity: 'error',
    code: 'FIELD_ENUM',
  },
  {
    rule: 'numberStyle with currencyCode',
    fixture: 'generic',
    mutate: (p) => {
      Object.assign(p.generic.primaryFields[0], {
        value: 5,
        numberStyle: 'PKNumberStyleDecimal',
        currencyCode: 'USD',
      });
    },
    severity: 'warning',
    code: 'FIELD_NUMBER_FORMAT',
  },
  {
    rule: 'numberStyle on text',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.primaryFields[0].numberStyle = 'PKNumberStyleDecimal';
    },
    severity: 'warning',
    code: 'FIELD_NUMBER_FORMAT',
  },
  {
    rule: 'currencyCode format',
    fixture: 'generic',
    mutate: (p) => {
      Object.assign(p.generic.primaryFields[0], { value: 5, currencyCode: 'usd' });
    },
    severity: 'error',
    code: 'FIELD_ENUM',
  },
  {
    rule: 'textAlignment on primary',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.primaryFields[0].textAlignment = 'PKTextAlignmentLeft';
    },
    severity: 'warning',
    code: 'FIELD_TEXT_ALIGNMENT',
  },
  {
    rule: 'dataDetectorTypes enum',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.backFields[0].dataDetectorTypes = ['nope'];
    },
    severity: 'error',
    code: 'FIELD_ENUM',
  },
  {
    rule: 'dataDetectorTypes off back',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.primaryFields[0].dataDetectorTypes = [];
    },
    severity: 'warning',
    code: 'FIELD_DATA_DETECTORS',
  },
  {
    rule: 'row off eventTicket',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.secondaryFields[0].row = 1;
    },
    severity: 'warning',
    code: 'FIELD_ROW',
  },
  {
    rule: 'row value',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.eventTicket.auxiliaryFields[1].row = 2;
    },
    severity: 'error',
    code: 'FIELD_ROW',
  },
  {
    rule: 'attributedValue link scheme',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.backFields[1].attributedValue = '<a href="javascript:alert(1)">x</a>';
    },
    severity: 'error',
    code: 'LINK',
  },
  {
    rule: 'attributedValue relative link',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.backFields[1].attributedValue = '<a href="/x">x</a>';
    },
    severity: 'error',
    code: 'LINK',
  },
  {
    rule: 'attributedValue obfuscated scheme',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.backFields[1].attributedValue = '<a href="java\tscript:alert(1)">x</a>';
    },
    severity: 'error',
    code: 'LINK',
  },
  {
    rule: 'attributedValue tags',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.backFields[1].attributedValue = '<b>x</b>';
    },
    severity: 'warning',
    code: 'ATTRIBUTED_TAGS',
  },
  // Semantics value types
  {
    rule: 'semantic string',
    fixture: pet,
    mutate: (p) => {
      p.semantics.eventName = 5;
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic number',
    fixture: sbp,
    mutate: (p) => {
      p.semantics.flightNumber = '123';
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic date',
    fixture: sbp,
    mutate: (p) => {
      p.semantics.originalDepartureDate = '09:00';
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic time zone',
    fixture: sbp,
    mutate: (p) => {
      p.semantics.departureLocationTimeZone = 'Mars/Base';
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic enum',
    fixture: pet,
    mutate: (p) => {
      p.semantics.eventType = 'concert';
    },
    severity: 'error',
    code: 'SEMANTICS_ENUM',
  },
  {
    rule: 'semantic enum array',
    fixture: sbp,
    mutate: (p) => {
      p.semantics.passengerCapabilities = ['Flying'];
    },
    severity: 'error',
    code: 'SEMANTICS_ENUM',
  },
  {
    rule: 'semantic open enum',
    fixture: sbp,
    mutate: (p) => {
      p.semantics.passengerServiceSSRs = ['ZZZZ'];
    },
    severity: 'warning',
    code: 'SEMANTICS_ENUM',
  },
  {
    rule: 'semantic location',
    fixture: 'generic',
    mutate: (p) => {
      p.semantics = { venueLocation: { latitude: 1 } };
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic currency',
    fixture: 'storeCard',
    mutate: (p) => {
      p.semantics.balance = { amount: 5, currencyCode: 'USD' };
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic seat color',
    fixture: pet,
    mutate: (p) => {
      p.semantics.seats[0].seatSectionColor = '#f00';
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic wifi',
    fixture: 'generic',
    mutate: (p) => {
      p.semantics = { wifiAccess: [{ ssid: 'x' }] };
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic person',
    fixture: sbp,
    mutate: (p) => {
      p.semantics.passengerName = 'Alex';
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
  {
    rule: 'semantic unknown tag',
    fixture: 'generic',
    mutate: (p) => {
      p.semantics = { madeUp: 1 };
    },
    severity: 'warning',
    code: 'UNKNOWN_SEMANTIC_TAG',
  },
  {
    rule: 'balance outside store cards',
    fixture: 'generic',
    mutate: (p) => {
      p.semantics = { balance: { amount: '1', currencyCode: 'USD' } };
    },
    severity: 'warning',
    code: 'SEMANTICS_STYLE',
  },
  {
    rule: 'field-level semantics',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.primaryFields[0].semantics = { eventName: 1 };
    },
    severity: 'error',
    code: 'SEMANTICS_TYPE',
  },
];

checkRules('rules-fields', RULES);
