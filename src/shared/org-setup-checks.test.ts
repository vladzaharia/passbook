import { describe, expect, it } from 'vitest';
import { CHANNELS } from './contracts/channels.ts';
import {
  type PassSetup,
  PassSetupSchema,
  SETUP_CHECK_CODES,
  type SetupCheckCode,
} from './contracts/pass-setup.ts';
import {
  checksForTemplate,
  orgSetupChecks,
  PLATFORM_BRANDING_CHECK,
  type SetupFacts,
  todoCount,
} from './org-setup-checks.ts';
import {
  channelOf,
  enrolmentOf,
  identityOf,
  NOW,
  newOrgFacts,
  readyFacts,
  templateOf,
  viewOf,
} from './pass-setup-test-fixtures.ts';

const DAY = 86_400_000;
const codes = (f: SetupFacts, now = NOW) => orgSetupChecks(f, now).map((c) => c.code);
const one = (f: SetupFacts, code: SetupCheckCode) =>
  orgSetupChecks(f, NOW).find((c) => c.code === code);
const edit = (fn: (f: SetupFacts) => void): SetupFacts => {
  const f = readyFacts();
  fn(f);
  return f;
};
const unset = { value: null, source: 'passbook' as const };

describe('orgSetupChecks', () => {
  it('a set-up org is Ready', () => {
    expect(codes(readyFacts())).toEqual([]);
  });

  it('a new org has the B2 rows, to-dos first', () => {
    const checks = orgSetupChecks(newOrgFacts(), NOW);
    expect(checks.map((c) => c.code)).toEqual([
      'BRAND_LOGO',
      'BRAND_ICON',
      'SUPPORT_MISSING',
      'BRAND_COLORS',
      'APPLE_SHARED_ID',
    ]);
    expect(todoCount(checks)).toBe(3);
    expect(checks[0]).toMatchObject({
      level: 'warn',
      area: 'brand',
      message: 'No logo. Passes show the placeholder.',
      templateIds: ['tpl_gym'],
      fix: { action: 'upload_logo' },
    });
  });

  // One row per code: the change that raises it, and what the row must say.
  const table: [SetupCheckCode, SetupFacts, Record<string, unknown>][] = [
    [
      'BRAND_LOGO',
      edit((f) => {
        f.brand.logo = { ...unset, templatesOwn: 0 };
        f.templates = [templateOf('tpl_a', { placeholders: ['logo'] }), templateOf('tpl_b')];
      }),
      { level: 'warn', templateIds: ['tpl_a'], fix: { action: 'upload_logo' } },
    ],
    [
      'BRAND_ICON',
      edit((f) => {
        f.brand.icon = { ...unset, templatesOwn: 0 };
        f.templates = [];
      }),
      { level: 'warn', fix: { action: 'upload_icon' } },
    ],
    [
      'BRAND_COLORS',
      edit((f) => {
        f.brand.passColors = { ...unset, templatesOwn: 0 };
      }),
      { level: 'info', fix: { action: 'use_logo_colors' } },
    ],
    [
      'BRAND_CONTRAST',
      edit((f) => {
        f.brand.passColors.value = {
          background: '#ffffff',
          foreground: '#eeeeee',
          label: '#000000',
        };
      }),
      { level: 'warn', fix: { action: 'fix_contrast' } },
    ],
    [
      'ACCENT_CONTRAST',
      edit((f) => {
        f.brand.accent.value = '#f0f4ff';
      }),
      {
        level: 'warn',
        message: 'The accent is too faint on light pages, so holders see the default.',
        fix: { action: 'fix_accent' },
      },
    ],
    [
      'SUPPORT_MISSING',
      edit((f) => {
        f.brand.support.email = unset;
      }),
      { level: 'warn', area: 'support', fix: { action: 'edit_support' } },
    ],
    [
      'APPLE_SHARED_ID',
      edit((f) => {
        f.apple.identity = null;
      }),
      { level: 'info', area: 'channels', channel: 'apple', fix: { action: 'start_apple_managed' } },
    ],
    [
      'APPLE_ID_FAILED',
      edit((f) => {
        f.apple.identity = null;
        f.apple.run = run('failed');
      }),
      { level: 'error', fix: { action: 'retry_identity_run', target: 'run_1' } },
    ],
    [
      'APPLE_ID_EXPIRING',
      edit((f) => {
        f.apple.identity = identityOf({ notAfter: NOW + 20 * DAY });
      }),
      {
        level: 'warn',
        message: 'The Apple certificate expires in 20 days.',
        fix: { action: 'renew_identity', target: 'idn_1' },
      },
    ],
    [
      'APPLE_PUSH',
      edit((f) => {
        f.apple.push = 'failing';
      }),
      { level: 'warn', fix: { action: 'check_push', target: 'idn_1' } },
    ],
    [
      'WALLET_ACCOUNT',
      edit((f) => {
        f.channels.google = channelOf(
          { level: 'org', reason: 'not_enrolled' },
          { account: enrolmentOf('google', { platformAvailable: true }) },
        );
      }),
      {
        level: 'warn',
        channel: 'google',
        message: 'Google Wallet needs an account.',
        fix: { action: 'setup_wallet_account', target: 'google' },
      },
    ],
    [
      'NO_CHANNEL',
      edit((f) => {
        for (const c of CHANNELS) if (f.channels[c].on) f.channels[c] = blocked();
      }),
      { level: 'error', fix: { action: 'allow_channel', target: 'apple' } },
    ],
    [
      'TEMPLATE_BRAND_OWN',
      edit((f) => {
        f.templates = [templateOf('tpl_a', { ownBrand: ['colors'] }), templateOf('tpl_b')];
      }),
      {
        level: 'info',
        message: '1 template uses its own brand.',
        templateIds: ['tpl_a'],
        fix: { action: 'review_template', target: 'tpl_a' },
      },
    ],
  ];

  it('the table covers every code', () => {
    expect(table.map(([code]) => code).sort()).toEqual([...SETUP_CHECK_CODES].sort());
  });

  it.each(table)('%s', (code, facts, row) => {
    expect(codes(facts)).toEqual([code]);
    expect(one(facts, code)).toMatchObject({ code, ...row });
  });

  it('does not ask for a logo when every template has its own', () => {
    const f = edit((x) => {
      x.brand.logo = { ...unset, templatesOwn: 0 };
      x.templates = [templateOf('tpl_a', { placeholders: ['logo'], ownBrand: ['logo'] })];
    });
    expect(codes(f)).toEqual(['TEMPLATE_BRAND_OWN']);
  });

  it('offers colour picking when there is no logo to take colours from', () => {
    expect(one(newOrgFacts(), 'BRAND_COLORS')?.fix).toEqual({ action: 'edit_colors' });
  });

  it('flags a faint label alone', () => {
    const f = edit((x) => {
      x.brand.passColors.value = { background: '#ffffff', foreground: '#000000', label: '#dddddd' };
    });
    expect(codes(f)).toEqual(['BRAND_CONTRAST']);
  });

  it('checks the accent on dark pages and ignores a PassBook default', () => {
    const dark = edit((f) => {
      f.brand.accent.value = '#111827';
    });
    expect(one(dark, 'ACCENT_CONTRAST')?.message).toBe(
      'The accent is too faint on dark pages, so holders see the default.',
    );
    const passbook = edit((f) => {
      f.brand.accent = { value: '#111827', source: 'passbook' };
    });
    expect(codes(passbook)).toEqual([]);
  });

  it('is satisfied by a support link alone', () => {
    const f = edit((x) => {
      x.brand.support = { email: unset, url: { value: 'https://acme.test/help', source: 'org' } };
    });
    expect(codes(f)).toEqual([]);
  });

  it('stays quiet about the shared ID while a run is going or the plan has no managed ID', () => {
    const running = edit((f) => {
      f.apple.identity = null;
      f.apple.run = run('waiting');
    });
    expect(codes(running)).toEqual([]);
    const noPlan = edit((f) => {
      f.apple.identity = null;
      f.apple.managedAllowed = false;
    });
    expect(codes(noPlan)).toEqual([]);
  });

  it.each([
    [31, []],
    [30, ['warn', 'The Apple certificate expires in 30 days.']],
    [14, ['error', 'The Apple certificate expires in 14 days.']],
    [1, ['error', 'The Apple certificate expires in 1 day.']],
    [-3, ['error', 'The Apple certificate has expired. Passes stop updating.']],
  ] as const)('an identity %i days from expiry', (days, want) => {
    const f = edit((x) => {
      x.apple.identity = identityOf({ notAfter: NOW + days * DAY });
    });
    const row = one(f, 'APPLE_ID_EXPIRING');
    expect(row ? [row.level, row.message] : []).toEqual(want);
  });

  it('an own identity is fixed by a new certificate', () => {
    const f = edit((x) => {
      x.apple.identity = identityOf({ kind: 'own', notAfter: NOW + 5 * DAY });
    });
    expect(one(f, 'APPLE_ID_EXPIRING')?.fix).toEqual({
      action: 'replace_certificate',
      target: 'idn_1',
    });
  });

  it('asks for no account while the provider is dark, the plan lacks it or the org blocks it', () => {
    for (const stop of [
      { level: 'passbook', reason: 'not_released' },
      { level: 'plan', reason: 'not_included' },
      { level: 'org', reason: 'blocked' },
    ] as const) {
      const f = edit((x) => {
        x.channels.samsung = channelOf(stop);
      });
      expect(codes(f)).toEqual([]);
    }
  });

  it('NO_CHANNEL offers the first channel the org stops', () => {
    const f = edit((x) => {
      for (const c of CHANNELS) if (x.channels[c].on) x.channels[c] = blocked();
      x.channels.apple = channelOf({ level: 'plan', reason: 'not_included' });
    });
    expect(one(f, 'NO_CHANNEL')?.fix).toEqual({ action: 'allow_channel', target: 'mobile' });
  });

  it('counts several templates that keep their own brand', () => {
    const f = edit((x) => {
      x.templates = [
        templateOf('a', { ownBrand: ['logo'] }),
        templateOf('b', { ownBrand: ['icon'] }),
      ];
    });
    expect(one(f, 'TEMPLATE_BRAND_OWN')).toMatchObject({
      message: '2 templates use their own brand.',
      fix: { action: 'review_template' },
    });
    expect(one(f, 'TEMPLATE_BRAND_OWN')?.fix.target).toBeUndefined();
  });
});

describe('the view', () => {
  it('parses as the contract, checks included', () => {
    const view: PassSetup = viewOf(newOrgFacts());
    expect(PassSetupSchema.parse(view)).toEqual(view);
  });

  it('a pass shows the checks for its template and those for every template', () => {
    const f = newOrgFacts();
    f.templates = [templateOf('tpl_a', { placeholders: ['logo'] }), templateOf('tpl_b')];
    const forB = checksForTemplate(orgSetupChecks(f, NOW), 'tpl_b').map((c) => c.code);
    expect(forB).not.toContain('BRAND_LOGO');
    expect(forB).toContain('SUPPORT_MISSING');
    expect(checksForTemplate(orgSetupChecks(f, NOW), 'tpl_a').map((c) => c.code)).toContain(
      'BRAND_LOGO',
    );
  });

  it('maps the PLATFORM_BRANDING lint slot to its check', () => {
    expect(PLATFORM_BRANDING_CHECK).toEqual({ logo: 'BRAND_LOGO', icon: 'BRAND_ICON' });
  });
});

function run(state: 'failed' | 'waiting') {
  return {
    id: 'run_1',
    orgId: 'org_1',
    kind: 'provision' as const,
    targetType: 'org' as const,
    targetId: 'org_1',
    state,
    step: 'certificate',
    attempt: 1,
    waitingFor: null,
    errorCode: state === 'failed' ? 'ASC_UNAVAILABLE' : null,
    createdAt: NOW - DAY,
    updatedAt: NOW,
    finishedAt: state === 'failed' ? NOW : null,
  };
}

function blocked() {
  return channelOf({ level: 'org', reason: 'blocked' });
}
