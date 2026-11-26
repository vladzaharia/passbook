import type { SdkNames } from './openapi-ratchet.ts';

/** Leading verbs of SDK method names. A new verb is a decision: add it here with the rule that needs it. */
export const METHOD_VERBS: ReadonlySet<string> = new Set(
  `accept add apply approve archive assign attach bind cancel check clear clone close commit complete confirm connect
  consume count create decline delete detach diff disable download enable end ensure export hold import inspect join
  list mark match migrate offboard open override pair pause personalize preview probe promote reassign rebind receive
  reenroll refresh release remove renew reopen replace replay report request resend reset resolve restore retire
  retrieve retry reveal revoke rollback rotate save search send set share stage start stop submit sync unassign undo unlock
  unpair unvoid update upload upsert verify void`.split(/\s+/),
);

/** Method prefixes that are not verbs, each with the naming rule that allows it (docs/api/sdk-names.json is frozen). */
export const NOUN_PREFIXES: Readonly<Record<string, string>> = {
  act: 'terminal.act: the till API names its three calls resolve, act and undo',
  bulk: 'bulk<Verb> acts on many of the resource at once (passes.bulkReissue)',
  callback: 'a provider redirect lands here (callback, receiveCallback)',
  current: 'a singleton read of the live one (bulkRuns.current)',
  lookup: 'terminal.lookup reads a code without acting on it',
  make: 'passes.makePrimary: the path says make-primary',
  setup: 'one-shot setup of a whole area (scanSetups.setup)',
  sign: 'auth.signIn and signOut, as the UI says',
  test: 'a probe of a configuration, not a verb on the record (connections.test)',
  use: 'blueprints.use: the path says use',
};

/** UK spellings the API docs avoid; the docs use US English. Matched on whole words, camelCase split first. */
const UK_SPELLINGS =
  /\b(?:colour\w*|enrol(?!l)\w*|behaviour\w*|centre\w*|licence\w*|favour\w*|honour\w*|neighbour\w*|catalogue\w*|programme\w*|artefact\w*|ageing|judgement|whilst|grey|cancell(?:ed|ing)|labell(?:ed|ing)|travell\w+|(?:organ|personal|author|initial|custom|synchron|normal|serial|final|minim|priorit|util|recogn|summar|anonym|categor|optim|standard|sanit|visual|real|capital|emphas|general|local|memor)is(?:e|es|ed|ing|ation|ations)|analys(?:e|ed|ing))\b/i;

/** Spaces between camelCase words; code spans (`cancelled`) are wire values, not prose, and are left out. */
const words = (text: string): string =>
  text.replace(/`[^`]*`/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');

/** The UK spelling in a piece of prose or a name, if any. */
export function ukSpelling(text: string): string | undefined {
  return words(text).match(UK_SPELLINGS)?.[0];
}

/** Reasons a name or description breaks the vocabulary; empty when it is clean. Each is one specific violation. */
export function vocabularyFailures(
  names: SdkNames,
  descriptions: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [id, n] of Object.entries(names)) {
    const verb = n.method.match(/^[a-z]+/)?.[0] ?? '';
    if (!METHOD_VERBS.has(verb) && !(verb in NOUN_PREFIXES))
      out.push(
        `${id}: method ${n.method} starts with "${verb}"; add it to METHOD_VERBS or NOUN_PREFIXES`,
      );
    const bad = ukSpelling(`${n.resource}.${n.method}`);
    if (bad) out.push(`${id}: the SDK name has the UK spelling "${bad}"; use the US spelling`);
  }
  for (const [id, text] of Object.entries(descriptions)) {
    const bad = ukSpelling(text);
    if (bad) out.push(`${id}: the text has the UK spelling "${bad}"; use the US spelling`);
    if (!/^[A-Z`]/.test(text))
      out.push(`${id}: a description must start with a capital letter or a backtick`);
    if (!/[.`)?!"]$/.test(text))
      out.push(`${id}: a description must end with a period or a closing mark`);
  }
  return out;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

/** Every `summary` and `description` string of the OpenAPI document, by where it sits. Enum values are not prose. */
export function documentProse(doc: Json): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) for (const [i, v] of node.entries()) walk(v, `${at}[${i}]`);
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(obj(node))) {
        if ((k === 'summary' || k === 'description') && typeof v === 'string')
          out[`${at}.${k}`] = v;
        else if (k !== 'enum' && k !== 'example' && k !== 'examples') walk(v, `${at}.${k}`);
      }
  };
  walk(doc.paths, 'paths');
  walk(doc.components, 'components');
  return out;
}

/** UK spelling in the document's own prose. Only the spelling rule: generated text has its own sentence forms. */
export function proseFailures(doc: Json): string[] {
  const out: string[] = [];
  for (const [at, text] of Object.entries(documentProse(doc))) {
    const bad = ukSpelling(text);
    if (bad) out.push(`${at}: the text has the UK spelling "${bad}"; use the US spelling`);
  }
  return out;
}
