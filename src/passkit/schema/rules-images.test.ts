import { checkRules, poster, type Rule } from './rules-helpers.ts';

const RULES: Rule[] = [
  // Images
  {
    rule: 'missing icon',
    fixture: 'generic',
    mutate: (_p, a) => a.filter((x) => !x.name.startsWith('icon')),
    severity: 'error',
    code: 'MISSING_ICON',
  },
  {
    rule: 'icon size',
    fixture: 'generic',
    mutate: (_p, a) =>
      a.map((x) => (x.name === 'icon@2x.png' ? { ...x, width: 100, height: 100 } : x)),
    severity: 'error',
    code: 'IMAGE_SIZE',
  },
  {
    rule: 'logo too large',
    fixture: 'generic',
    mutate: (_p, a) => a.map((x) => (x.name === 'logo.png' ? { ...x, width: 400 } : x)),
    severity: 'error',
    code: 'IMAGE_SIZE',
  },
  {
    rule: 'thumbnail aspect',
    fixture: 'generic',
    mutate: (_p, a) =>
      a.map((x) => (x.name === 'thumbnail.png' ? { ...x, width: 30, height: 90 } : x)),
    severity: 'error',
    code: 'IMAGE_SIZE',
  },
  {
    rule: 'artwork size',
    fixture: poster,
    mutate: (_p, a) => a.map((x) => (x.name === 'artwork@3x.png' ? { ...x, height: 1000 } : x)),
    severity: 'error',
    code: 'IMAGE_SIZE',
  },
  {
    rule: 'unused slot',
    fixture: 'generic',
    mutate: (_p, a) => [...a, { name: 'footer.png', width: 268, height: 15 }],
    severity: 'warning',
    code: 'UNUSED_IMAGE',
  },
  {
    rule: 'unused background on poster',
    fixture: poster,
    mutate: (_p, a) => [...a, { name: 'background.png', width: 345, height: 505 }],
    severity: 'warning',
    code: 'UNUSED_IMAGE',
  },
  {
    rule: 'unknown image',
    fixture: 'generic',
    mutate: (_p, a) => [...a, { name: 'banner.png' }],
    severity: 'warning',
    code: 'UNKNOWN_IMAGE',
  },
  {
    rule: 'unexpected file',
    fixture: 'generic',
    mutate: (_p, a) => [...a, { name: 'notes.txt' }],
    severity: 'warning',
    code: 'ASSET_NAME',
  },
  {
    rule: 'strip conflict',
    fixture: 'eventTicket',
    mutate: (_p, a) => [...a, { name: 'thumbnail.png', width: 90, height: 90 }],
    severity: 'warning',
    code: 'IMAGE_CONFLICT',
  },
  {
    rule: 'poster artwork',
    fixture: poster,
    mutate: (_p, a) => a.filter((x) => !x.name.startsWith('artwork')),
    severity: 'warning',
    code: 'MISSING_IMAGE',
  },
  // Localized images
  {
    rule: 'localized resolutions differ',
    fixture: 'generic',
    mutate: (_p, a) => [
      ...a,
      { name: 'en.lproj/logo.png' },
      { name: 'en.lproj/logo@2x.png' },
      { name: 'fr.lproj/logo.png' },
    ],
    severity: 'error',
    code: 'LOCALIZED_IMAGES',
  },
  {
    rule: 'localized image missing in a locale',
    fixture: 'generic',
    mutate: (_p, a) => [...a, { name: 'en.lproj/strip.png' }, { name: 'fr.lproj/pass.strings' }],
    severity: 'warning',
    code: 'LOCALIZED_IMAGES',
  },
  {
    rule: 'top-level overrides localized',
    fixture: 'generic',
    mutate: (_p, a) => [
      ...a,
      { name: 'en.lproj/logo.png' },
      { name: 'en.lproj/logo@2x.png' },
      { name: 'en.lproj/logo@3x.png' },
    ],
    severity: 'warning',
    code: 'LOCALIZED_IMAGES',
  },
  {
    rule: 'locale folder name',
    fixture: 'generic',
    mutate: (_p, a) => [...a, { name: 'english.lproj/logo.png' }],
    severity: 'warning',
    code: 'LOCALE_NAME',
  },
];

checkRules('rules-images', RULES);
