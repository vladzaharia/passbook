import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import {
  type ArtOutput,
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
  size: { width: number; height: number; fit: 'cover' | 'scale-down' },
) => Promise<Uint8Array | null>;

export function artTransformFromBinding(images: ImagesBinding | undefined): ArtTransform {
  return async (bytes, { width, height, fit }) => {
    if (!images) return null;
    const result = await images
      .input(new Response(bytes as BufferSource).body as ReadableStream<Uint8Array>)
      .transform({ width, height, fit })
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
  const rule = artRule(request.target, request.slot);
  if (!rule || !isTemplateArt(template, request)) return null;
  const source = new Uint8Array(
    await new Response(await registry.openAsset(template, request.asset)).arrayBuffer(),
  );
  const png = parsePng(source);
  if ('error' in png) return null;
  const out: ArtOutput | null = artOutput(rule, png.width, png.height);
  if (!out) return null;
  let bytes: Uint8Array = source;
  let { width, height } = png;
  if (out.width !== png.width || out.height !== png.height) {
    const cut = await transform(source, {
      width: out.width,
      height: out.height,
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
