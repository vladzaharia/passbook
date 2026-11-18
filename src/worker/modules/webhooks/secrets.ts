import type { Mode } from '../../../shared/contracts/common.ts';
import {
  credentialAad,
  decryptSecretText,
  type Envelope,
  encryptSecret,
  type KekRing,
} from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export interface SecretBinding {
  secretId: string;
  orgId: string;
  endpointId: string;
  mode: Mode;
}

/** Shown once, in the create and rotate responses. */
export function newEndpointSecret(ctx: ServiceContext): string {
  return `whsec_${ctx.ids.token(32)}`;
}

/** The AAD pins a secret to its endpoint and mode: a row copied to another endpoint cannot decrypt. */
export function secretAad(b: SecretBinding): string {
  return credentialAad(b.secretId, b.orgId, `webhook_endpoint:${b.endpointId}:${b.mode}`);
}

export function sealSecret(ring: KekRing, value: string, b: SecretBinding): Promise<Envelope> {
  return encryptSecret(ring, value, secretAad(b));
}

export function openSecret(ring: KekRing, envelope: Envelope, b: SecretBinding): Promise<string> {
  return decryptSecretText(ring, envelope, secretAad(b));
}
