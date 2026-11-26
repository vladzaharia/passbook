import { type AscResponse, failure } from './asc-http.ts';
import { AscError, type CertificateInfo, type PassTypeRef } from './types.ts';

export type Resource = {
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: unknown;
};

export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function passType(r: Resource): PassTypeRef {
  const ascId = str(r.id);
  const identifier = str(r.attributes?.identifier);
  if (!ascId || !identifier)
    throw new AscError('ASC_UPSTREAM', 'Apple returned an unexpected pass type.');
  return { ascId, identifier, name: str(r.attributes?.name) };
}

export function certificate(r: Resource): CertificateInfo {
  const ascId = str(r.id);
  if (!ascId) throw new AscError('ASC_UPSTREAM', 'Apple returned an unexpected certificate.');
  const content = str(r.attributes?.certificateContent);
  const expires = Date.parse(str(r.attributes?.expirationDate) ?? '');
  return {
    ascId,
    certificateType: str(r.attributes?.certificateType) ?? '',
    serialNumber: str(r.attributes?.serialNumber),
    expiresAt: Number.isNaN(expires) ? null : expires,
    der: content ? fromBase64(content) : null,
  };
}

export const one = (res: AscResponse): Resource => {
  if (res.status < 200 || res.status >= 300) throw failure(res);
  const data = res.body?.data;
  if (!data || Array.isArray(data))
    throw new AscError('ASC_UPSTREAM', 'Apple returned no resource.');
  return data as Resource;
};
export const many = (res: AscResponse): Resource[] => {
  if (res.status < 200 || res.status >= 300) throw failure(res);
  return Array.isArray(res.body?.data) ? (res.body.data as Resource[]) : [];
};
