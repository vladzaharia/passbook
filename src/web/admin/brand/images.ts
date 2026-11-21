import { WEB_LOGO } from '@/shared/contracts/brand.ts';
import { ImageInputError, pngSize, prepareImage, toBase64 } from '../orgs/branding.ts';
import { stageBrandAsset } from './api.ts';
import type { ImageSlot, StagedImage } from './draft.ts';

/** Checks a web logo in the browser, so the common mistakes never leave the page. */
async function webLogoPng(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = pngSize(bytes);
  if (!size) throw new ImageInputError('Choose a PNG file.');
  if (bytes.length > WEB_LOGO.maxBytes) throw new ImageInputError('The logo is over 512 KB.');
  if (size.w > WEB_LOGO.maxWidth || size.h > WEB_LOGO.maxHeight)
    throw new ImageInputError(
      `The logo is ${size.w} × ${size.h} px; use at most ${WEB_LOGO.maxWidth} × ${WEB_LOGO.maxHeight}.`,
    );
  if (size.w < WEB_LOGO.minSide || size.h < WEB_LOGO.minSide)
    throw new ImageInputError(`Use at least ${WEB_LOGO.minSide} px on each side.`);
  return toBase64(bytes);
}

/** A data URL, because a pass preview only draws https, same-origin or data images. */
function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Checks a PNG, stages it on the server, and returns it with a local URL to draw until the save. */
export async function stageImage(orgId: string, slot: ImageSlot, file: File): Promise<StagedImage> {
  const body =
    slot === 'webLogo'
      ? { slot, png: await webLogoPng(file) }
      : await prepareImage(slot, file).then((p) => ({
          slot,
          png: p.x3,
          ...(p.x2 ? { x2: p.x2 } : {}),
        }));
  const staged = await stageBrandAsset(orgId, body);
  return { sha: staged.sha, w: staged.w, h: staged.h, url: await dataUrl(file) };
}
