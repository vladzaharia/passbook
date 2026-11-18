import type { UseBlueprintRequest } from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { forkTemplate } from './fork.ts';
import { imagesFromBinding } from './images-binding.ts';
import type { ImageTools } from './package/images.ts';

export { checkBlueprintDraft } from './fork.ts';

/** "Use blueprint": a tracked copy of an offered blueprint in an org. */
export function useBlueprint(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: UseBlueprintRequest,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
) {
  return forkTemplate(ctx, auth, id, body, { blueprintOnly: true, images });
}
