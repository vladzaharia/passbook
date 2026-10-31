import { checkRules, pet, poster, type Rule, sbp } from './rules-helpers.ts';

const RULES: Rule[] = [
  // Required keys and identity
  {
    rule: 'formatVersion',
    fixture: 'generic',
    mutate: (p) => {
      p.formatVersion = 2;
    },
    severity: 'error',
    code: 'FORMAT_VERSION',
  },
  {
    rule: 'required description',
    fixture: 'generic',
    mutate: (p) => {
      delete p.description;
    },
    severity: 'error',
    code: 'REQUIRED',
  },
  {
    rule: 'required organizationName',
    fixture: 'generic',
    mutate: (p) => {
      p.organizationName = '';
    },
    severity: 'error',
    code: 'REQUIRED',
  },
  {
    rule: 'identity mismatch',
    fixture: 'generic',
    mutate: (p) => {
      p.teamIdentifier = 'X';
    },
    severity: 'error',
    code: 'IDENTITY_MISMATCH',
  },
  {
    rule: 'passTypeIdentifier prefix',
    fixture: 'generic',
    mutate: (p) => {
      p.passTypeIdentifier = 'x';
    },
    severity: 'warning',
    code: 'PASS_TYPE_FORMAT',
  },
  {
    rule: 'unknown key',
    fixture: 'generic',
    mutate: (p) => {
      p.futureKey = 1;
    },
    severity: 'warning',
    code: 'UNKNOWN_KEY',
  },
  {
    rule: 'unknown field key',
    fixture: 'generic',
    mutate: (p) => {
      p.generic.primaryFields[0].extra = 1;
    },
    severity: 'warning',
    code: 'UNKNOWN_KEY',
  },
  {
    rule: 'key type',
    fixture: 'generic',
    mutate: (p) => {
      p.voided = 'yes';
    },
    severity: 'error',
    code: 'KEY_TYPE',
  },
  // Styles
  {
    rule: 'no style',
    fixture: 'generic',
    mutate: (p) => {
      delete p.generic;
    },
    severity: 'error',
    code: 'NO_STYLE',
  },
  {
    rule: 'style type',
    fixture: 'generic',
    mutate: (p) => {
      p.generic = [];
    },
    severity: 'error',
    code: 'STYLE_TYPE',
  },
  {
    rule: 'two legacy styles',
    fixture: 'generic',
    mutate: (p) => {
      p.coupon = { primaryFields: [] };
    },
    severity: 'error',
    code: 'MULTIPLE_STYLES',
  },
  {
    rule: 'poster without fallback',
    fixture: poster,
    mutate: (p) => {
      delete p.generic;
    },
    severity: 'error',
    code: 'POSTER_FALLBACK',
  },
  {
    rule: 'boardingPass transitType',
    fixture: 'boardingPass',
    mutate: (p) => {
      delete p.boardingPass.transitType;
    },
    severity: 'error',
    code: 'TRANSIT_TYPE',
  },
  {
    rule: 'scheme needs eventTicket',
    fixture: 'generic',
    mutate: (p) => {
      p.preferredStyleSchemes = ['posterEventTicket'];
    },
    severity: 'error',
    code: 'PREFERRED_SCHEMES',
  },
  {
    rule: 'semantic scheme needs air',
    fixture: sbp,
    mutate: (p) => {
      p.boardingPass.transitType = 'PKTransitTypeTrain';
    },
    severity: 'error',
    code: 'PREFERRED_SCHEMES',
  },
  {
    rule: 'unknown scheme',
    fixture: pet,
    mutate: (p) => {
      p.preferredStyleSchemes.push('mystery');
    },
    severity: 'warning',
    code: 'PREFERRED_SCHEMES',
  },
  {
    rule: 'groupingIdentifier style',
    fixture: 'generic',
    mutate: (p) => {
      p.groupingIdentifier = 'g';
    },
    severity: 'warning',
    code: 'STYLE_MISMATCH',
  },
  {
    rule: 'PET key on plain eventTicket',
    fixture: 'eventTicket',
    mutate: (p) => {
      p.eventLogoText = 'x';
    },
    severity: 'warning',
    code: 'STYLE_MISMATCH',
  },
  // Colors, dates, lifecycle
  {
    rule: 'hex color',
    fixture: 'generic',
    mutate: (p) => {
      p.backgroundColor = '#fff';
    },
    severity: 'error',
    code: 'COLOR',
  },
  {
    rule: 'rgb channel range',
    fixture: 'generic',
    mutate: (p) => {
      p.labelColor = 'rgb(0, 0, 256)';
    },
    severity: 'error',
    code: 'COLOR',
  },
  {
    rule: 'expirationDate',
    fixture: 'generic',
    mutate: (p) => {
      p.expirationDate = '2026-12-01';
    },
    severity: 'error',
    code: 'DATE',
  },
  {
    rule: 'impossible date',
    fixture: 'generic',
    mutate: (p) => {
      p.expirationDate = '2026-02-31T10:00:00Z';
    },
    severity: 'error',
    code: 'DATE',
  },
  {
    rule: 'webServiceURL needs token',
    fixture: 'generic',
    mutate: (p) => {
      delete p.authenticationToken;
    },
    severity: 'error',
    code: 'AUTH_TOKEN',
  },
  {
    rule: 'short token',
    fixture: 'generic',
    mutate: (p) => {
      p.authenticationToken = 'short';
    },
    severity: 'error',
    code: 'AUTH_TOKEN',
  },
  {
    rule: 'http web service',
    fixture: 'generic',
    mutate: (p) => {
      p.webServiceURL = 'http://x.example';
    },
    severity: 'warning',
    code: 'URL_SCHEME',
  },
  {
    rule: 'web service URL',
    fixture: 'generic',
    mutate: (p) => {
      p.webServiceURL = 'nope';
    },
    severity: 'error',
    code: 'URL',
  },
  {
    rule: 'appLaunchURL',
    fixture: 'generic',
    mutate: (p) => {
      p.appLaunchURL = 'app://x';
    },
    severity: 'warning',
    code: 'APP_LAUNCH_URL',
  },
  {
    rule: 'store ids',
    fixture: 'generic',
    mutate: (p) => {
      p.associatedStoreIdentifiers = ['a'];
    },
    severity: 'error',
    code: 'KEY_TYPE',
  },
  // Sharing
  {
    rule: 'sharing method',
    fixture: 'generic',
    mutate: (p) => {
      p.sharing = { method: 'x' };
    },
    severity: 'error',
    code: 'SHARING',
  },
  {
    rule: 'sharing url',
    fixture: 'generic',
    mutate: (p) => {
      p.sharing = { method: 'PKPassSharingMethodURL' };
    },
    severity: 'error',
    code: 'SHARING',
  },
  {
    rule: 'sharing ignored',
    fixture: 'generic',
    mutate: (p) => {
      Object.assign(p, {
        sharing: { method: 'PKPassSharingMethodPass' },
        sharingProhibited: true,
      });
    },
    severity: 'warning',
    code: 'SHARING',
  },
];

checkRules('rules-package', RULES);
