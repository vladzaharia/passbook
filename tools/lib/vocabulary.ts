import type { SdkNames } from './openapi-ratchet.ts';

/** Leading verbs of SDK method names. A new verb is a decision: add it here with the rule that needs it. */
export const METHOD_VERBS: ReadonlySet<string> = new Set(
  `accept act add apply approve archive assign attach bind bulk callback cancel check clear clone close commit
  complete confirm connect consume count create current decline delete detach diff disable download enable end
  ensure export hold import inspect join list lookup make mark match migrate offboard open override pair pause
  personalize preview promote reassign rebind receive reenroll refresh release remove renew reopen replace
  replay report request resend reset resolve restore retire retrieve retry reveal revoke rollback rotate save
  search send set setup share sign stage start stop submit sync test unassign undo unlock unpair unvoid update
  upload upsert use verify void`.split(/\s+/),
);

/** UK spellings the API docs avoid; the docs use US English. */
const UK_SPELLINGS =
  /colour|organis|enrolment|behaviour|centre|licence|personalis|authoris|initialis|favour|catalogue|grey/i;

/** Reasons a name or a reference description breaks the vocabulary; empty when it is clean. */
export function vocabularyFailures(
  names: SdkNames,
  descriptions: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [id, n] of Object.entries(names)) {
    const verb = n.method.match(/^[a-z]+/)?.[0] ?? '';
    if (!METHOD_VERBS.has(verb))
      out.push(`${id}: method ${n.method} starts with ${verb}, which is not in METHOD_VERBS`);
    const bad = `${n.resource}.${n.method}`.match(UK_SPELLINGS);
    if (bad) out.push(`${id}: ${bad[0]} in the SDK name; use US spelling`);
  }
  for (const [id, text] of Object.entries(descriptions)) {
    const bad = text.match(UK_SPELLINGS);
    if (bad) out.push(`${id}: description spells ${bad[0]} the UK way; use US spelling`);
    if (!/^[A-Z`]/.test(text)) out.push(`${id}: description starts with a capital letter`);
    if (!/[.`]$/.test(text)) out.push(`${id}: description ends with a period`);
  }
  return out;
}
