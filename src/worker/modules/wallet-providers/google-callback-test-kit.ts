import { toBase64 } from '../../platform/ids.ts';

const sender = 'GooglePayPasses';
const protocol = 'ECv2SigningOnly';
const encoder = new TextEncoder();

type Pair = CryptoKeyPair;
export interface CallbackSigningKeys {
  root: Pair;
  intermediate: Pair;
  other: Pair;
}

/** Real independent P-256 keys; there is no production trust-key override. */
export async function makeCallbackSigningKeys(): Promise<CallbackSigningKeys> {
  const generate = async (): Promise<Pair> => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    if (!('privateKey' in pair)) throw new Error('Expected an ECDSA key pair');
    return pair;
  };
  const [root, intermediate, other] = await Promise.all([generate(), generate(), generate()]);
  return { root, intermediate, other };
}

export async function callbackPublicKey(pair: Pair): Promise<string> {
  const exported = await crypto.subtle.exportKey('spki', pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error('Expected an SPKI key export');
  return toBase64(new Uint8Array(exported));
}

function framed(...fields: string[]): Uint8Array {
  const pieces = fields.map((field) => encoder.encode(field));
  const buffer = new Uint8Array(pieces.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(buffer.buffer);
  let offset = 0;
  for (const piece of pieces) {
    view.setUint32(offset, piece.length, true);
    buffer.set(piece, offset + 4);
    offset += 4 + piece.length;
  }
  return buffer;
}

/** WebCrypto returns P1363; Google/Tink messages use ASN.1 DER ECDSA signatures. */
async function sign(pair: Pair, ...fields: string[]): Promise<string> {
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      framed(...fields) as BufferSource,
    ),
  );
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const value = bytes.slice(start);
    return (value[0] ?? 0) & 0x80 ? new Uint8Array([0, ...value]) : value;
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return toBase64(
    new Uint8Array([0x30, 4 + r.length + s.length, 2, r.length, ...r, 2, s.length, ...s]),
  );
}

export async function callbackKeyset(pair: Pair, expiresAt: number) {
  return {
    keys: [
      {
        protocolVersion: protocol,
        keyValue: await callbackPublicKey(pair),
        keyExpiration: String(expiresAt),
      },
    ],
  };
}

export async function signedGoogleEvent(
  keys: CallbackSigningKeys,
  issuerId: string,
  event: Record<string, unknown>,
  options: {
    keyExpiration: number;
    sender?: string;
    recipient?: string;
    rootSigner?: Pair;
    messageSigner?: Pair;
    extraRootSigner?: Pair;
  },
): Promise<string> {
  const signedKey = JSON.stringify({
    keyValue: await callbackPublicKey(keys.intermediate),
    keyExpiration: String(options.keyExpiration),
  });
  // Preserve whitespace to exercise signature verification of the actual serialized string.
  const signedMessage = JSON.stringify(event, null, 2);
  const actualSender = options.sender ?? sender;
  const signatures = [
    await sign(options.rootSigner ?? keys.root, actualSender, protocol, signedKey),
  ];
  if (options.extraRootSigner)
    signatures.unshift(await sign(options.extraRootSigner, actualSender, protocol, signedKey));
  return JSON.stringify({
    protocolVersion: protocol,
    intermediateSigningKey: { signedKey, signatures },
    signature: await sign(
      options.messageSigner ?? keys.intermediate,
      actualSender,
      options.recipient ?? issuerId,
      protocol,
      signedMessage,
    ),
    signedMessage,
  });
}
