import type { ServiceContext } from '../../platform/service-context.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import type { Pass } from '../passes/repo-map.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import type { Candidate } from './repo-lookup.ts';
import type { Found } from './resolve.ts';

/** Pin the keyring without losing environment-scoped registry and service overrides. */
export function snapshotActionContext(ctx: ServiceContext): ServiceContext {
  const env = snapshotCredentialEnv(ctx.env);
  overrideDeps(env, depsOf(ctx.env));
  return { ...ctx, env };
}

/** Preserve the verified CSRF scalars while sampling expiry at the final transaction. */
export function actionCsrfAt(actor: ScanActor, snapshot: ActorCsrfSnapshot, now: number) {
  const current = snapshot.session
    ? { ...snapshot, session: { ...snapshot.session, now } }
    : snapshot;
  return actorCsrfSnapshotFence(actor, current);
}

/** Snapshot nonsecret pass state while keeping credentials in request-local scalar closures. */
export function snapshotActionPass(pass: Pass): Pass {
  const {
    authToken,
    downloadToken,
    serial,
    scanCode,
    barcodeHash,
    objectKey,
    webServiceUrl,
    personalization: input,
    fieldSources: sources,
    ...other
  } = pass;
  const personalization = JSON.stringify(input);
  const fieldSources = JSON.stringify(sources);
  const captured = structuredClone(other) as Pass;
  Object.defineProperties(captured, {
    authToken: { enumerable: true, get: () => authToken },
    downloadToken: { enumerable: true, get: () => downloadToken },
    serial: { enumerable: true, get: () => serial },
    scanCode: { enumerable: true, get: () => scanCode },
    barcodeHash: { enumerable: true, get: () => barcodeHash },
    objectKey: { enumerable: true, get: () => objectKey },
    webServiceUrl: { enumerable: true, get: () => webServiceUrl },
    personalization: { enumerable: true, get: () => JSON.parse(personalization) },
    fieldSources: { enumerable: true, get: () => JSON.parse(fieldSources) },
  });
  return captured;
}

/** Never structured-clone Wallet or pass credential material with policy metadata. */
export function snapshotActionCandidate(candidate: Candidate): Candidate {
  const {
    pass,
    passJson,
    passJsonSnapshot,
    versionPersonalization,
    passPersonalizationSnapshot,
    fieldSourcesSnapshot,
    assetPhoto,
    lookupHash,
    templateSnapshot,
    ...other
  } = candidate;
  return {
    ...structuredClone(other),
    pass: snapshotActionPass(pass),
    passJson,
    passJsonSnapshot,
    versionPersonalization,
    passPersonalizationSnapshot,
    fieldSourcesSnapshot,
    lookupHash,
    assetPhoto: assetPhoto ? { ...assetPhoto } : null,
    templateSnapshot: templateSnapshot ? { raw: templateSnapshot.raw } : null,
  };
}

/** The grant plan stays request-local; no bearer grant or pass credential is cloned. */
export function snapshotActionFound(found: Found): Found {
  const {
    pass,
    liveCandidate,
    passJson,
    passJsonSnapshot,
    versionPersonalization,
    passPersonalizationSnapshot,
    fieldSourcesSnapshot,
    assetPhoto,
    ...other
  } = found;
  if (!passJson || passJsonSnapshot === null) throw new Error('Missing evaluated Wallet snapshot');
  const walletJson = passJsonSnapshot;
  const captured = {
    ...structuredClone(other),
    pass: snapshotActionPass(pass),
    ...(liveCandidate ? { liveCandidate: snapshotActionCandidate(liveCandidate) } : {}),
    passJsonSnapshot,
    versionPersonalization,
    passPersonalizationSnapshot,
    fieldSourcesSnapshot,
    assetPhoto: assetPhoto ? { ...assetPhoto } : null,
  } as Found;
  Object.defineProperty(captured, 'passJson', {
    enumerable: true,
    get: () => JSON.parse(walletJson),
  });
  return captured;
}
