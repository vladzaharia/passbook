import { behaviorPlugins } from '../../../generated/behaviors.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import { planPass } from '../../../passkit/plan.ts';
import { FIELD_GROUPS } from '../../../passkit/schema/constants.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import { PASS_STYLES, type PassJson, type Personalization } from '../../../passkit/types.ts';

/** Fixed, so two builds of the same templates are the same bytes, and an edit moves only what it changes. */
export const PREVIEW_NOW = new Date(Date.UTC(2026, 0, 1));
const IDENTITY = { passTypeIdentifier: 'pass.preview', teamIdentifier: 'PREVIEW000' };
const SLOT = /^(contact|pass-service)(-poster)?$/;

const behaviors = createBehaviorRegistry([...behaviorPlugins]);

/** Planning reads no files: the bytes of a preview are never asked for. */
const noRegistry: TemplateRegistry = {
  list: async () => [],
  resolve: async () => {
    throw new Error('No registry for a preview.');
  },
  openAsset: async () => {
    throw new Error('No assets for a preview.');
  },
};

/**
 * What the preview endpoint does for an org with no contacts (modules/passes/contacts.ts,
 * `withBackContacts`): the `pass-service` back field gets the site, the empty `contact` is dropped.
 */
function withPassService(base: PassJson, passService: string): PassJson {
  const pass = structuredClone(base);
  for (const style of PASS_STYLES) {
    const dict = pass[style] as Record<string, unknown> | undefined;
    for (const group of FIELD_GROUPS) {
      const list = dict?.[group];
      if (!dict || !Array.isArray(list)) continue;
      dict[group] = list.flatMap((field: { key?: string; value?: unknown }) => {
        const slot = SLOT.exec(typeof field?.key === 'string' ? field.key : '')?.[1];
        if (!slot || field.value !== '') return [field];
        return slot === 'contact' ? [] : [{ ...field, value: passService }];
      });
    }
  }
  return pass;
}

/**
 * The pass a blueprint's values make, as the preview endpoint plans it minus signing and the
 * database: the one planner for the deploy-time previews and for the live, signed-out Design page.
 */
export function planPreview(args: {
  template: ResolvedTemplate;
  input: Personalization;
  origin: string;
}): PassJson {
  const { template, input, origin } = args;
  const plan = planPass({
    template,
    registry: noRegistry,
    input,
    server: {
      serial: 'preview',
      authToken: 'preview-token-000000000000000000',
      webServiceURL: `${origin}/wallet`,
      organizationName: 'Your organization',
      identity: IDENTITY,
      scanCode: 'PREVIEW2PASS3SCAN4CODE5XYZ',
    },
    behaviors,
    now: PREVIEW_NOW,
  });
  const { authenticationToken: _token, ...built } = plan.passJson;
  return withPassService(built as PassJson, origin);
}
