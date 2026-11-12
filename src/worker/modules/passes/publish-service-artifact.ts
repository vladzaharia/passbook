import type { Personalization } from '../../../passkit/types.ts';
import type { Artifact } from './builder.ts';
import { credentialReferences } from './credential-references.ts';
import type { AppleRelease } from './publish-service-release.ts';
import type { Pass } from './repo.ts';
import type { PublishPassSnapshot } from './repo-write-publish-snapshot.ts';
import { lookupValueOf, primaryBarcodeMessage } from './scan-code.ts';

export interface PublishAttempt {
  current: Pass;
  next: Pick<
    Pass,
    'personalization' | 'fieldSources' | 'templateVersion' | 'status' | 'externalId'
  >;
  artifact: Artifact;
  expectedPass: PublishPassSnapshot & Pick<Pass, 'id' | 'version'>;
  release: AppleRelease | undefined;
  requireNoReleaseHistory: boolean;
  scanCode: string;
  credentialKeysetCommitment: string;
}

export async function artifactCredentialRefs(
  credentialEnv: object,
  pass: Pass,
  artifact: Artifact,
  personalization: Personalization,
  scanCode: string,
): Promise<string[]> {
  const lookupInput = artifact.template.manifest.scan?.lookup?.input;
  const refs = await credentialReferences(credentialEnv, pass.orgId, pass.mode, {
    serial: pass.serial,
    scanCode,
    barcodeHash: artifact.barcodeHash,
    barcodeMessage: primaryBarcodeMessage(artifact.passJson),
    lookupHash: artifact.lookupHash,
    lookupValue: lookupInput ? lookupValueOf(personalization, lookupInput) : null,
  });
  return [...new Set(refs.map((ref) => ref.ref))];
}
