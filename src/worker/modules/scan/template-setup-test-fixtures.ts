import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { ScanManifest, TemplateManifest } from '../../../passkit/types.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { approveScanReleases, type ScanKit } from './test-kit.ts';

const text = { type: 'string' } as const;
const when = { type: 'string', format: 'date-time' } as const;

/** A scan template whose passes each name their own event, as the starter event and timed tickets do. */
export async function eventTemplate(
  kit: ScanKit,
  name: string,
  over: { scan?: ScanManifest; behaviors?: TemplateManifest['behaviors'] } = {},
): Promise<string> {
  const id = `tpl-ev-${kit.fx.ids.token(5)}`;
  const base = kit.template;
  const manifest: TemplateManifest = {
    ...base.manifest,
    name,
    inputs: {
      type: 'object',
      required: ['memberName'],
      properties: {
        memberName: { type: 'string', minLength: 1 },
        eventName: text,
        startsAt: when,
        endsAt: when,
        doorsAt: when,
        venueName: text,
        venueRegion: text,
        venueTimeZone: text,
        upcomingEvents: { type: 'array', items: { type: 'object' } },
      },
    },
    // The preview values a starter ships: they must never become events or hours.
    sample: {
      memberName: 'Sam Reed',
      eventName: 'Ocean Light',
      startsAt: '2030-11-21T14:00:00-05:00',
      endsAt: '2030-11-21T14:30:00-05:00',
      venueTimeZone: 'America/New_York',
    },
    bindings: [
      ...base.manifest.bindings,
      { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
    ],
    scan: over.scan ?? {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
      window: { from: 'startsAt', until: 'endsAt', earlyMinutes: 30, lateMinutes: 30 },
    },
    ...(over.behaviors ? { behaviors: over.behaviors } : {}),
  };
  const resolved = kit.registry.add({
    id,
    orgId: kit.org.id,
    manifest,
    passJson: {
      ...base.passJson,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'utf-8' }],
    },
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  await approveScanReleases(kit, id, { orgId: kit.org.id, version: resolved.version });
  return id;
}
