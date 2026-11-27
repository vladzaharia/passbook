import type { RecipeId, RecipeInfo } from '@/shared/contracts/connections.ts';
import { type MappingRow, toRows } from '../mapping/mapping.ts';

/** Config keys a sender other than Custom does not use: its own scheme fixes them. */
const CUSTOM_ONLY = [
  'recordsPointer',
  'refPointer',
  'recordPointer',
  'deletedPointer',
  'eventIdPointer',
  'signatureHeader',
  'timestampHeader',
];

/** Fields the config form leaves out for the chosen sender. */
export function recipeHidden(recipe: RecipeId | undefined, offered: boolean): Set<string> {
  if (!offered) return new Set();
  const hidden = new Set(['recipe']);
  if (recipe && recipe !== 'custom') for (const k of CUSTOM_ONLY) hidden.add(k);
  if (!recipe?.startsWith('stripe-')) hidden.add('acceptTestEvents');
  if (recipe !== 'woocommerce-orders') hidden.add('passPer');
  return hidden;
}

/** The mapping, holder email and void rules a sender starts with; all stay editable. */
export function recipeSeed(recipe: RecipeInfo | undefined): {
  rows: MappingRow[];
  holderEmailField: string;
  voidWhen: RecipeInfo['voidWhen'];
} {
  return {
    rows: toRows(recipe?.mapping),
    holderEmailField: recipe?.holderEmailField ?? '',
    voidWhen: recipe?.voidWhen ?? [],
  };
}

/** A pasted signing secret: the guide's length and prefix. */
export function signingSecretError(
  secret: { prefix: string | null; minLength: number },
  value: string,
  provider: string,
): string | undefined {
  const v = value.trim();
  if (!v) return 'Paste the signing secret.';
  if (v.length < secret.minLength) return 'Too short. Copy the whole secret.';
  if (secret.prefix && !v.startsWith(secret.prefix))
    return `A ${provider} signing secret starts with ${secret.prefix}.`;
  return undefined;
}
