import { describe, expect, it } from 'vitest';
import { SETUP_GUIDES } from '../../../worker/connectors/webhook-push/recipes/index.ts';
import { outboundSetup } from '../../../worker/modules/webhooks/setup-guide.ts';
import { parseGuide } from './parse.ts';
import { expandSetupDirective, SETUP_GUIDE_LIST, setupGuidesMarkdown } from './webhook-setup.ts';

const md = setupGuidesMarkdown();
const doc = parseGuide(`---\nid: x\ntitle: X\nline: X\nstatus: ready\n---\n${md}`, 'x.md');

describe('the webhook setup guide page', () => {
  it('covers every guide the API serves, and the outbound one', () => {
    const served = [...Object.values(SETUP_GUIDES), outboundSetup];
    expect(SETUP_GUIDE_LIST.map((g) => g.guide)).toEqual(expect.arrayContaining(served));
    expect(SETUP_GUIDE_LIST).toHaveLength(served.length);
  });

  it('carries every step title, topic and docs link', () => {
    for (const { guide: g } of SETUP_GUIDE_LIST) {
      for (const s of g.steps) expect(md).toContain(s.title);
      for (const t of g.subscriptions.topics) expect(md).toContain(`\`${t.id}\``);
      for (const d of g.provider.docs) expect(md).toContain(d.url);
    }
  });

  it('flags unconfirmed steps with "Labels may differ"', () => {
    for (const { guide: g } of SETUP_GUIDE_LIST)
      for (const s of g.steps.filter((x) => !x.verified))
        expect(md).toContain(
          `${s.side === 'passbook' ? 'In PassBook' : `At ${g.provider.name}`}. Labels may differ.`,
        );
  });

  it('has unique anchors and no secret values', () => {
    const ids = doc.blocks.flatMap((b) => (b.kind === 'h2' || b.kind === 'h3' ? [b.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(md).not.toMatch(/whsec_[A-Za-z0-9]{8}/);
  });

  it('expands only its directive', () => {
    expect(expandSetupDirective('a\n{{webhook-setup}}\nb')).toContain('## Shopify orders');
    expect(expandSetupDirective('plain')).toBe('plain');
  });
});
