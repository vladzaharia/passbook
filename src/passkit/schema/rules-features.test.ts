import { describe, expect, it } from 'vitest';
import { NFC_KEY } from './fixtures.ts';
import { checkRules, has, pet, poster, type Rule, run, sbp } from './rules-helpers.ts';

const RULES: Rule[] = [
  // Featured actions
  {
    rule: 'three actions',
    fixture: poster,
    mutate: (p) => {
      p.featuredActions.push({ identifier: 'c', type: 'call', url: 'tel:+1555' });
    },
    severity: 'error',
    code: 'FEATURED_ACTIONS',
  },
  {
    rule: 'place needs placeIdentifier',
    fixture: poster,
    mutate: (p) => {
      delete p.featuredActions[1].placeIdentifier;
    },
    severity: 'error',
    code: 'FEATURED_ACTIONS',
  },
  {
    rule: 'place with url',
    fixture: poster,
    mutate: (p) => {
      p.featuredActions[1].url = 'https://x.example';
    },
    severity: 'error',
    code: 'FEATURED_ACTIONS',
  },
  {
    rule: 'duplicate action id',
    fixture: poster,
    mutate: (p) => {
      p.featuredActions[1].identifier = 'portal';
    },
    severity: 'error',
    code: 'FEATURED_ACTIONS',
  },
  {
    rule: 'action url scheme',
    fixture: poster,
    mutate: (p) => {
      p.featuredActions[0].url = 'javascript:alert(1)';
    },
    severity: 'error',
    code: 'FEATURED_ACTIONS',
  },
  {
    rule: 'call needs tel',
    fixture: poster,
    mutate: (p) => {
      Object.assign(p.featuredActions[0], { type: 'call', url: 'https://x.example' });
    },
    severity: 'error',
    code: 'FEATURED_ACTIONS',
  },
  {
    rule: 'unknown action type',
    fixture: poster,
    mutate: (p) => {
      p.featuredActions[0].type = 'viewMembership';
    },
    severity: 'warning',
    code: 'FEATURED_ACTION_TYPE',
  },
  {
    rule: 'actions on PET',
    fixture: pet,
    mutate: (p) => {
      p.featuredActions = [{ identifier: 'a', type: 'call', url: 'tel:+1555' }];
    },
    severity: 'warning',
    code: 'FEATURED_ACTIONS_STYLE',
  },
  // NFC and personalization
  {
    rule: 'nfc without entitlement',
    fixture: 'generic',
    mutate: (p) => {
      p.nfc = { message: 'x', encryptionPublicKey: NFC_KEY };
    },
    severity: 'error',
    code: 'NFC_NOT_ENTITLED',
  },
  {
    rule: 'nfc message length',
    fixture: pet,
    mutate: (p) => {
      p.nfc.message = 'x'.repeat(65);
    },
    severity: 'error',
    code: 'NFC',
  },
  {
    rule: 'nfc key',
    fixture: pet,
    mutate: (p) => {
      p.nfc.encryptionPublicKey = 'AAAA';
    },
    severity: 'error',
    code: 'NFC',
  },
  {
    rule: 'nfc auth needs sharingProhibited',
    fixture: pet,
    mutate: (p) => {
      delete p.sharingProhibited;
    },
    severity: 'error',
    code: 'NFC',
  },
  {
    rule: 'personalization needs nfc identity',
    fixture: 'generic',
    mutate: (_p, a) => [...a, { name: 'personalizationLogo.png', width: 150, height: 40 }],
    severity: 'error',
    code: 'NFC_NOT_ENTITLED',
    options: {
      personalization: {
        requiredPersonalizationFields: ['PKPassPersonalizationFieldName'],
        description: 'x',
      },
    },
  },
  {
    rule: 'personalization logo',
    fixture: pet,
    mutate: () => undefined,
    severity: 'error',
    code: 'MISSING_IMAGE',
    options: {
      personalization: {
        requiredPersonalizationFields: ['PKPassPersonalizationFieldName'],
        description: 'x',
      },
    },
  },
  {
    rule: 'personalization fields',
    fixture: pet,
    mutate: (_p, a) => [...a, { name: 'personalizationLogo.png', width: 150, height: 40 }],
    severity: 'error',
    code: 'PERSONALIZATION',
    options: { personalization: { requiredPersonalizationFields: [], description: 'x' } },
  },
  {
    rule: 'personalization description',
    fixture: pet,
    mutate: (_p, a) => [...a, { name: 'personalizationLogo.png', width: 150, height: 40 }],
    severity: 'error',
    code: 'PERSONALIZATION',
    options: {
      personalization: { requiredPersonalizationFields: ['PKPassPersonalizationFieldName'] },
    },
  },
  {
    rule: 'personalization in returned pass',
    fixture: pet,
    mutate: (_p, a) => [...a, { name: 'personalization.json' }],
    severity: 'error',
    code: 'PERSONALIZATION',
    options: { personalized: true },
  },
  // URL keys and PET
  {
    rule: 'event url',
    fixture: pet,
    mutate: (p) => {
      p.accessibilityURL = 'nope';
    },
    severity: 'error',
    code: 'URL',
  },
  {
    rule: 'event guide count',
    fixture: pet,
    mutate: (p) => {
      delete p.directionsInformationURL;
    },
    severity: 'warning',
    code: 'EVENT_GUIDE',
  },
  {
    rule: 'airline url on non-SBP',
    fixture: 'boardingPass',
    mutate: (p) => {
      p.changeSeatURL = 'https://x.example';
    },
    severity: 'warning',
    code: 'STYLE_MISMATCH',
  },
  {
    rule: 'PET required semantics',
    fixture: pet,
    mutate: (p) => {
      delete p.semantics.venueRoom;
    },
    severity: 'warning',
    code: 'SEMANTICS_REQUIRED',
  },
  {
    rule: 'PET without nfc',
    fixture: pet,
    mutate: (p) => {
      delete p.nfc;
    },
    severity: 'warning',
    code: 'PET_NFC',
  },
  {
    rule: 'PET sports semantics',
    fixture: pet,
    mutate: (p) => {
      p.semantics.eventType = 'PKEventTypeSports';
    },
    severity: 'warning',
    code: 'SEMANTICS_REQUIRED',
  },
  {
    rule: 'SBP required semantics',
    fixture: sbp,
    mutate: (p) => {
      delete p.semantics.airlineCode;
    },
    severity: 'warning',
    code: 'SEMANTICS_REQUIRED',
  },
  {
    rule: 'PET needs artwork',
    fixture: pet,
    mutate: (_p, a) => a.filter((x) => !x.name.startsWith('artwork')),
    severity: 'error',
    code: 'MISSING_IMAGE',
  },
  {
    rule: 'upcoming identifier',
    fixture: pet,
    mutate: (p) => {
      delete p.upcomingPassInformation[0].identifier;
    },
    severity: 'error',
    code: 'UPCOMING',
  },
  {
    rule: 'upcoming type',
    fixture: pet,
    mutate: (p) => {
      p.upcomingPassInformation[0].type = 'x';
    },
    severity: 'error',
    code: 'UPCOMING',
  },
  {
    rule: 'upcoming image https',
    fixture: pet,
    mutate: (p) => {
      p.upcomingPassInformation[0].images.headerImage.URLs[0].URL = 'http://x.example/a.png';
    },
    severity: 'error',
    code: 'UPCOMING',
  },
  {
    rule: 'upcoming image size',
    fixture: pet,
    mutate: (p) => {
      p.upcomingPassInformation[0].images.headerImage.URLs[0].size = 3 * 1024 * 1024;
    },
    severity: 'error',
    code: 'UPCOMING',
  },
  {
    rule: 'upcoming image sha',
    fixture: pet,
    mutate: (p) => {
      p.upcomingPassInformation[0].images.headerImage.URLs[0].SHA256 = 'abc';
    },
    severity: 'error',
    code: 'UPCOMING',
  },
  {
    rule: 'upcoming date',
    fixture: pet,
    mutate: (p) => {
      p.upcomingPassInformation[0].dateInformation.date = 'soon';
    },
    severity: 'error',
    code: 'DATE',
  },
  {
    rule: 'upcoming back field',
    fixture: pet,
    mutate: (p) => {
      delete p.upcomingPassInformation[0].backFields;
    },
    severity: 'warning',
    code: 'UPCOMING',
  },
  {
    rule: 'upcoming on non-PET',
    fixture: 'generic',
    mutate: (p) => {
      p.upcomingPassInformation = [];
    },
    severity: 'warning',
    code: 'STYLE_MISMATCH',
  },
];

checkRules('rules-features', RULES);

describe('semantics placement', () => {
  it('counts field-level semantics toward the required layout tags', () => {
    const report = run(pet, (p) => {
      const room = p.semantics.venueRoom;
      delete p.semantics.venueRoom;
      p.eventTicket.primaryFields[0].semantics = { venueRoom: room };
    });
    expect(has(report, 'warning', 'SEMANTICS_REQUIRED')).toBe(false);
  });
});
