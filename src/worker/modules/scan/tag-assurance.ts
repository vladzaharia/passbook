import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ScanTag } from '../../../shared/contracts/nfc-tags.ts';
import type { Candidate } from './repo-lookup.ts';
import { resolveCandidateReadTemplates } from './template-read-snapshot.ts';

type Assurance = ScanTag['assurance'];

const RANK: Record<Assurance, number> = { basic: 0, secure: 1 };

/** Only Basic (UID) tags exist today; Secure (SUN) tags come with their own read path. */
export const TAG_ASSURANCE: Assurance = 'basic';

/** The weakest tag a template accepts: `basic` unless it asks for more. */
export const templateMinAssurance = (manifest: TemplateManifest | undefined): Assurance =>
  manifest?.scan?.tags?.min ?? 'basic';

export const meetsAssurance = (tag: Assurance, min: Assurance): boolean => RANK[tag] >= RANK[min];

/** Whether a tag of this assurance may admit on the candidate, by its active release. */
export const candidateTakesTag = (c: Candidate, tag: Assurance = TAG_ASSURANCE): boolean =>
  meetsAssurance(tag, templateMinAssurance(resolveCandidateReadTemplates(c)?.active.manifest));
