import { describe, expect, it } from 'vitest';
import type { ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import { ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { buildDisplay } from './display.ts';
import { createDisplayFixture, ctx } from './display-split-fixture.ts';

const { fixture, inputOf } = createDisplayFixture();

describe('scan display photo URL', () => {
  // A UUIDv7 pass id with two all-digit groups ("-7134-8435-") matches the privacy filter's
  // phone-number pattern; the URL is server-built, so the filter must not drop it.
  it.each([
    '/api/v1/scan/passes/01a1cb28-5eef-7134-8435-08a2d8a1361f/assets/member.png?g=abc',
    '/api/v1/scan/passes/01a1cb2a-1a16-7671-8928-1a566ce95b23/assets/member.png?g=abc',
  ])('keeps %s', (photoUrl) => {
    const found = fixture();
    found.pass.id = photoUrl.split('/passes/')[1]?.split('/')[0] ?? found.pass.id;
    const display: ScanDisplayDoc = {
      v: 1,
      holder: '{{inputs.memberName}}',
      photo: {},
      header: { chips: [{ id: 'c_priority', text: 'Priority', tone: 'teal' }] },
    };
    found.template.manifest.scan!.display = display;
    found.scan.display = display;
    const shown = ScanDisplaySchema.parse(
      buildDisplay(ctx, { ...inputOf(found, 'manager'), photoUrl }),
    );
    expect(shown.identity.photo?.url).toBe(photoUrl);
  });
});
