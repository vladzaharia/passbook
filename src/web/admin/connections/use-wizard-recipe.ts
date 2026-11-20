import type { Dispatch, SetStateAction } from 'react';
import type { z } from 'zod';
import type { ConnectorInfoSchema, RecipeId } from '@/shared/contracts/connections.ts';
import type { MappingRow } from '../mapping/mapping.ts';
import type { Lifecycle } from './lifecycle-fields.tsx';
import { recipeSeed, signingSecretError } from './recipe-copy.ts';
import type { ConfigDraft } from './wizard-steps.tsx';

/** The sender chosen in the wizard: picking one seeds the mapping, holder email and void rules. */
export function useWizardRecipe({
  info,
  draft,
  setDraft,
  setRows,
  setLife,
}: {
  info: z.infer<typeof ConnectorInfoSchema> | undefined;
  draft: ConfigDraft;
  setDraft: Dispatch<SetStateAction<ConfigDraft>>;
  setRows: (rows: MappingRow[]) => void;
  setLife: Dispatch<SetStateAction<Lifecycle>>;
}) {
  const id = (draft.config.recipe as RecipeId | undefined) ?? 'custom';
  const recipe = info?.recipes.find((r) => r.id === id);
  return {
    recipe,
    /** Shopify and Stripe make the secret; it is pasted, so the created page has none to show. */
    pasted: recipe?.pasteSecret === true,
    secretError: recipe?.pasteSecret
      ? signingSecretError(id, draft.signingSecret ?? '')
      : undefined,
    pick(next: RecipeId) {
      const seed = recipeSeed(info?.recipes.find((r) => r.id === next));
      setDraft((d) => ({ ...d, config: { ...d.config, recipe: next }, signingSecret: '' }));
      setRows(seed.rows);
      setLife((l) => ({ ...l, holderEmailField: seed.holderEmailField, voidWhen: seed.voidWhen }));
    },
  };
}
