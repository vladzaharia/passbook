import * as asn1 from 'asn1js';
import * as pki from 'pkijs';

/** Samsung's certificate is the public certificate received through partner onboarding. */
interface SamsungCallbackCredentials {
  partnerId: string;
  certificateId: string;
  cardId: string;
  samsungCertificatePem: string;
}

export interface SamsungPartnerCredentials extends SamsungCallbackCredentials {
  partnerPrivateKeyPem: string;
  partnerCertificatePem: string;
}

export interface ValidatedSamsungCallbackCredentials {
  readonly partnerId: string;
  readonly certificateId: string;
  readonly cardId: string;
  readonly samsungVerificationKey: CryptoKey;
  readonly samsungCertificatePem: string;
  readonly validFrom: number;
  readonly validUntil: number;
}

export interface ValidatedSamsungCredentials extends ValidatedSamsungCallbackCredentials {
  readonly partnerSigningKey: CryptoKey;
}

export class SamsungCredentialError extends Error {
  constructor() {
    super('Invalid or expired Samsung Wallet credentials.');
    this.name = 'SamsungCredentialError';
  }
}

const rsa = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const validatedAccounts = new WeakSet<ValidatedSamsungCredentials>();
const validatedCallbackAccounts = new WeakSet<ValidatedSamsungCallbackCredentials>();

function pemDer(pem: string, label: 'PRIVATE KEY' | 'CERTIFICATE'): ArrayBuffer {
  if (typeof pem !== 'string') throw new SamsungCredentialError();
  const match = new RegExp(
    `^\\s*-----BEGIN ${label}-----\\s+([A-Za-z0-9+/=\\s]+?)\\s+-----END ${label}-----\\s*$`,
  ).exec(pem);
  if (!match?.[1]) throw new SamsungCredentialError();
  const text = match[1].replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw new SamsungCredentialError();
  try {
    return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0)).buffer;
  } catch {
    throw new SamsungCredentialError();
  }
}

async function certificate(
  pem: string,
  now: number,
): Promise<{
  publicKey: CryptoKey;
  notBefore: number;
  notAfter: number;
}> {
  const der = pemDer(pem, 'CERTIFICATE');
  try {
    const parsed = asn1.fromBER(der);
    if (parsed.offset !== der.byteLength) throw new SamsungCredentialError();
    const cert = new pki.Certificate({ schema: parsed.result });
    const notBefore = cert.notBefore.value.getTime();
    const notAfter = cert.notAfter.value.getTime();
    if (
      !Number.isFinite(notBefore) ||
      !Number.isFinite(notAfter) ||
      now < notBefore ||
      now >= notAfter
    )
      throw new SamsungCredentialError();
    const publicKey = await crypto.subtle.importKey(
      'spki',
      cert.subjectPublicKeyInfo.toSchema().toBER(false),
      rsa,
      false,
      ['verify'],
    );
    const algorithm = publicKey.algorithm;
    if (
      algorithm.name !== 'RSASSA-PKCS1-v1_5' ||
      !('modulusLength' in algorithm) ||
      typeof algorithm.modulusLength !== 'number' ||
      algorithm.modulusLength < 2048
    )
      throw new SamsungCredentialError();
    return { publicKey, notBefore, notAfter };
  } catch {
    throw new SamsungCredentialError();
  }
}

function validateCallbackIdentity(input: SamsungCallbackCredentials, now: number): void {
  if (
    !input ||
    !Number.isSafeInteger(now) ||
    typeof input.partnerId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(input.partnerId) ||
    typeof input.certificateId !== 'string' ||
    !/^[A-Za-z0-9]{4}$/.test(input.certificateId) ||
    typeof input.cardId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(input.cardId)
  )
    throw new SamsungCredentialError();
}

/** The caller must retrieve the exact trusted historical certificate from onboarding, not the request. */
export async function validateSamsungCallbackCredentials(
  input: SamsungCallbackCredentials,
  now = Date.now(),
): Promise<ValidatedSamsungCallbackCredentials> {
  validateCallbackIdentity(input, now);
  const samsung = await certificate(input.samsungCertificatePem, now);
  const account = Object.freeze({
    partnerId: input.partnerId,
    certificateId: input.certificateId,
    cardId: input.cardId,
    samsungVerificationKey: samsung.publicKey,
    samsungCertificatePem: input.samsungCertificatePem,
    validFrom: samsung.notBefore,
    validUntil: samsung.notAfter,
  });
  validatedCallbackAccounts.add(account);
  return account;
}

/**
 * Validates key material, not partner/card approval or the origin of the pinned Samsung certificate.
 * The account service must supply the genuine Samsung certificate obtained during onboarding.
 */
export async function validateSamsungCredentials(
  input: SamsungPartnerCredentials,
  now = Date.now(),
): Promise<ValidatedSamsungCredentials> {
  validateCallbackIdentity(input, now);

  try {
    const [partner, samsung, partnerSigningKey] = await Promise.all([
      certificate(input.partnerCertificatePem, now),
      certificate(input.samsungCertificatePem, now),
      crypto.subtle.importKey(
        'pkcs8',
        pemDer(input.partnerPrivateKeyPem, 'PRIVATE KEY'),
        rsa,
        false,
        ['sign'],
      ),
    ]);
    const algorithm = partnerSigningKey.algorithm;
    if (
      algorithm.name !== 'RSASSA-PKCS1-v1_5' ||
      !('modulusLength' in algorithm) ||
      typeof algorithm.modulusLength !== 'number' ||
      algorithm.modulusLength < 2048
    )
      throw new SamsungCredentialError();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign(rsa, partnerSigningKey, challenge);
    if (!(await crypto.subtle.verify(rsa, partner.publicKey, signature, challenge)))
      throw new SamsungCredentialError();
    const account = Object.freeze({
      partnerId: input.partnerId,
      certificateId: input.certificateId,
      cardId: input.cardId,
      partnerSigningKey,
      samsungVerificationKey: samsung.publicKey,
      samsungCertificatePem: input.samsungCertificatePem,
      validFrom: Math.max(partner.notBefore, samsung.notBefore),
      validUntil: Math.min(partner.notAfter, samsung.notAfter),
    });
    validatedAccounts.add(account);
    validatedCallbackAccounts.add(account);
    return account;
  } catch {
    throw new SamsungCredentialError();
  }
}

export function assertSamsungCredentialsCurrent(
  account: ValidatedSamsungCredentials,
  now: number,
): void {
  if (
    !account ||
    !validatedAccounts.has(account) ||
    !Number.isSafeInteger(now) ||
    now < account.validFrom ||
    now >= account.validUntil
  )
    throw new SamsungCredentialError();
}

export function assertSamsungCallbackCredentialsCurrent(
  account: ValidatedSamsungCallbackCredentials,
  now: number,
): void {
  if (
    !account ||
    !validatedCallbackAccounts.has(account) ||
    !Number.isSafeInteger(now) ||
    now < account.validFrom ||
    now >= account.validUntil
  )
    throw new SamsungCredentialError();
}
