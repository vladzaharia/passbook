import { type Fixtures, makePass, type PassRow } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { ScanDisplayDoc } from '../../../passkit/template/scan-display/schema.ts';
import type { PassJson } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { AppEnv } from '../../platform/env.ts';
import { previewPassIdentity, updatePreviewPass } from './repo-routes-display-test-fixtures.ts';

export const ORIGIN = 'https://wallet.test';
export const SECRET = '<copper&"7">';
export const ESCAPED_SECRET = '&lt;copper&amp;&quot;7&quot;&gt;';
export const ENCODED_SECRET = encodeURIComponent(SECRET);
export const HIDDEN = 'private member instruction';
export const NESTED_HIDDEN = 'private nested instruction';
export const NESTED_EMAIL = 'nested-contact@example.test';
export const MANAGER_HINT = 'Balcony host';
export const EMAIL = 'preview-holder@example.test';
export const PHONE = '+447911123456';
export const SITE = 'https://private.example.test/member';
export const BARCODE = 'BARCODE-PRIVATE-6743';
export const COUNT = 918273645;
export const EXTERNAL_ID = 'MEMBER-349';

export const display: ScanDisplayDoc = {
  v: 1,
  holder: '{{inputs.memberName}}',
  header: {},
  panels: [
    {
      id: 'p_details',
      rows: [
        { id: 'r_seat', type: 'field', label: 'Seat', value: '{{fields.seat}}' },
        {
          id: 'r_tier',
          type: 'field',
          label: 'Tier',
          value: '{{inputs.tier}}',
          minRole: 'desk',
        },
        {
          id: 'r_lounge',
          type: 'field',
          label: 'Lounge',
          value: '{{inputs.lounge}}',
          minRole: 'manager',
        },
      ],
    },
  ],
};

export async function seedPreviewRoutePasses(
  env: AppEnv,
  f: Fixtures,
  template: ResolvedTemplate,
  orgId: string,
) {
  let liveScanCode = '';
  const seed = async (mode: Mode, memberName: string): Promise<PassRow> => {
    const scanCode = `SCAN-${mode}-${f.ids.token(16)}`;
    if (mode === 'live') liveScanCode = scanCode;
    const pass = await makePass(f, {
      orgId,
      template,
      mode,
      scanCode,
      holderEmail: EMAIL,
      personalization: {
        memberName,
        seat: 'C12',
        tier: 'Gold',
        lounge: 'Roof lounge',
        canVisit: true,
        profile: {
          publicLabel: 'Atrium access',
          managerHint: MANAGER_HINT,
          insideNote: NESTED_HIDDEN,
          contactEmail: NESTED_EMAIL,
        },
        privateNotes: HIDDEN,
        locked: true,
        secretCount: COUNT,
        wifiPassword: SECRET,
        contact: EMAIL,
        callback: PHONE,
        website: SITE,
        ticketNumber: BARCODE,
        unfinished: 'unresolved {{inputs.memberName}}',
      },
    });
    const identity = await previewPassIdentity(env.DB, pass.id);
    if (!identity) throw new Error('Missing pass signing identity');
    const snapshot: PassJson = {
      ...template.passJson,
      passTypeIdentifier: identity.pass_type_identifier,
      teamIdentifier: identity.team_identifier,
      serialNumber: pass.serial,
      authenticationToken: pass.authToken,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: BARCODE, messageEncoding: 'utf-8' }],
      generic: {
        primaryFields: [{ key: 'name', value: memberName }],
        secondaryFields: [
          { key: 'seat', value: 'C12' },
          { key: 'tier', value: 'Gold' },
          { key: 'lounge', value: 'Roof lounge' },
          { key: 'nested_manager', value: MANAGER_HINT },
        ],
        backFields: [
          { key: 'notes', value: HIDDEN },
          { key: 'nested_note', value: NESTED_HIDDEN },
          { key: 'locked', value: true },
          { key: 'count', value: COUNT },
          { key: 'secret_a', value: SECRET },
          { key: 'secret_b', value: SECRET },
          { key: 'secret_html', value: ESCAPED_SECRET },
          {
            key: 'mirror',
            value: `Copied: ${SECRET} / ${SECRET} / ${ESCAPED_SECRET} / ${ENCODED_SECRET}`,
          },
          { key: 'contact', value: EMAIL },
          { key: 'phone', value: PHONE },
          { key: 'site', value: SITE },
          { key: 'barcode_copy', value: BARCODE },
          { key: 'scan_ref', value: scanCode },
          { key: 'unresolved', value: '{{inputs.privateNotes}}' },
          { key: 'attributed', value: 'Public field', attributedValue: SECRET },
        ],
      },
    };
    await updatePreviewPass(
      env.DB,
      pass.id,
      `${memberName}: ${SECRET} / ${SECRET}`,
      `Note: ${HIDDEN}`,
      EXTERNAL_ID,
      snapshot,
    );
    return pass;
  };
  const live = await seed('live', 'Alice Morgan');
  const sandbox = await seed('test', 'Tessa Rivera');
  return { live, sandbox, liveScanCode };
}
