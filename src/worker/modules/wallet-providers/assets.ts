import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import {
  type ArtOutput,
  type ArtRule,
  artOutput,
  artRule,
  type WalletTarget,
} from '../../../passkit/template/wallets/art-rules.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { parsePng } from '../templates/package/png.ts';

/** Template art slots a provider may show. Personal images never live in a template version. */
const TEMPLATE_SLOTS = new Set(['icon', 'logo', 'primaryLogo', 'strip', 'thumbnail', 'artwork']);
const IMAGE_PREFIX = 'wallet-art/';
const KIND = 'template-art';

/** Crop (`cover`) or downscale (`scale-down`, never enlarges) to PNG. Null: backend unavailable. */
export type ArtTransform = (
  bytes: Uint8Array,
  size: { width: number; height?: number; fit: 'cover' | 'scale-down' },
) => Promise<Uint8Array | null>;

export function artTransformFromBinding(images: ImagesBinding | undefined): ArtTransform {
  return async (bytes, { width, height, fit }) => {
    if (!images) return null;
    const result = await images
      .input(new Response(bytes as BufferSource).body as ReadableStream<Uint8Array>)
      .transform({ width, ...(height === undefined ? {} : { height }), fit })
      .output({ format: 'image/png' });
    return new Uint8Array(await new Response(result.image()).arrayBuffer());
  };
}

export interface DerivedArt {
  sha256: string;
  /** Path on the public origin; the caller prefixes it. */
  path: string;
  width: number;
  height: number;
}

export interface ArtRequest {
  target: WalletTarget;
  /** Provider slot, such as `logo` or `hero`. */
  slot: string;
  /** A template version asset: `wallets/<target>/<slot>.png` or a template art slot. */
  asset: string;
}

const isTemplateArt = (template: ResolvedTemplate, request: ArtRequest): boolean => {
  const entry = template.assets.find((a) => a.name === request.asset);
  if (!entry) return false;
  return request.asset.startsWith(`wallets/${request.target}/`) || TEMPLATE_SLOTS.has(entry.slot);
};

interface ArtPlan {
  source: Uint8Array;
  rule: ArtRule;
  out: ArtOutput;
  png: { width: number; height: number };
}

/** What a request would be cut to, or null (not template art, no rule, unreadable, below minimum). */
async function planWalletArt(
  registry: TemplateRegistry,
  template: ResolvedTemplate,
  request: ArtRequest,
): Promise<ArtPlan | null> {
  const rule = artRule(request.target, request.slot);
  if (!rule || !isTemplateArt(template, request)) return null;
  const source = new Uint8Array(
    await new Response(await registry.openAsset(template, request.asset)).arrayBuffer(),
  );
  const png = parsePng(source);
  if ('error' in png) return null;
  const out = artOutput(rule, png.width, png.height);
  if (!out) return null;
  // A copy that needs no cut is the source itself: its size is known now, the same as at publication.
  const uncut = out.width === png.width && out.height === png.height;
  if (uncut && rule.maxBytes !== undefined && source.length > rule.maxBytes) return null;
  return { source, rule, out, png };
}

/**
 * The size `deriveWalletArt` would produce, without cutting or storing anything. Reads use this:
 * only a release publication writes to the public image prefix.
 */
export async function sizeWalletArt(
  registry: TemplateRegistry,
  template: ResolvedTemplate,
  request: ArtRequest,
): Promise<{ width: number; height: number } | null> {
  const plan = await planWalletArt(registry, template, request);
  return plan ? { width: plan.out.width, height: plan.out.height } : null;
}

/**
 * Cuts one template art file to the target's size and stores it under its hash. Returns null when
 * the asset is not template art, has no rule for the slot, or is below the target minimum (the
 * caller omits the image). Only this function writes to the public image prefix.
 */
export async function deriveWalletArt(
  env: AppEnv,
  registry: TemplateRegistry,
  template: ResolvedTemplate,
  request: ArtRequest,
  transform: ArtTransform,
): Promise<DerivedArt | null> {
  const plan = await planWalletArt(registry, template, request);
  if (!plan) return null;
  const { source, rule, out } = plan;
  let bytes: Uint8Array = source;
  let { width, height } = plan.png;
  if (out.width !== width || out.height !== height) {
    // A downscale gives the width alone: both sides of a box that is a pixel off the source's aspect shrink the
    // width too (1125x432 into 1032x396 comes out 1031 wide), and publication would then refuse its own plan.
    const cut = await transform(source, {
      width: out.width,
      ...(out.crop ? { height: out.height } : {}),
      fit: out.crop ? 'cover' : 'scale-down',
    });
    const cutPng = cut && parsePng(cut);
    if (!cut || !cutPng || 'error' in cutPng) return null;
    bytes = cut;
    ({ width, height } = cutPng);
  }
  if (rule.maxBytes !== undefined && bytes.length > rule.maxBytes) return null;
  const sha256 = await sha256Hex(bytes);
  await env.BUCKET.put(`${IMAGE_PREFIX}${sha256}`, bytes, {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { kind: KIND },
  });
  return { sha256, path: `/w/i/${sha256}.png`, width, height };
}

/** The derived copy for a hash, or null when there is none or it is not template art. */
export async function openWalletArt(env: AppEnv, sha256: string): Promise<R2ObjectBody | null> {
  const object = await env.BUCKET.get(`${IMAGE_PREFIX}${sha256}`);
  return object?.customMetadata?.kind === KIND ? object : null;
}

/** Removes a derived copy; anything that is not template art is left alone. */
export async function deleteWalletArt(env: AppEnv, sha256: string): Promise<void> {
  const head = await env.BUCKET.head(`${IMAGE_PREFIX}${sha256}`);
  if (head?.customMetadata?.kind === KIND) await env.BUCKET.delete(`${IMAGE_PREFIX}${sha256}`);
}

/** Whether the public copy for a hash is stored; a claim checks this instead of cutting the image again. */
export async function walletArtExists(env: AppEnv, sha256: string): Promise<boolean> {
  const head = await env.BUCKET.head(`${IMAGE_PREFIX}${sha256}`);
  return head?.customMetadata?.kind === KIND;
}
