import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { FeatureNotIncludedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** The plan's allow-list item: `type`, or `type/recipe` for a connector that fixes a recipe. */
export const connectorItem = (type: string, config: { recipe?: unknown }): string =>
  typeof config.recipe === 'string' ? `${type}/${config.recipe}` : type;

/** Refuses (403 `FEATURE_NOT_INCLUDED`) unless the org's plan names the connector (and recipe). */
export async function requireConnectorEntitled(
  ctx: ServiceContext,
  orgId: string,
  item: string,
): Promise<void> {
  if (!isEntitled(await entitlementsOf(ctx, orgId), 'connectors', item))
    throw new FeatureNotIncludedError('connectors', featureNotIncluded('connectors'));
}
