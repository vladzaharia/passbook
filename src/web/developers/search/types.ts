/** The ⌘K index: one record per thing a reader can open. Built by search/build.ts, read by the island. */
export interface ErrorDoc {
  code: string;
  status: number | null;
  title: string;
  when: string;
  fix: string;
  retryable: boolean | null;
  href: string;
}

export interface OpDoc {
  /** The operationId, which the console opens by. */
  id: string;
  method: string;
  /** Without `/api/v1`. */
  path: string;
  title: string;
  /** `pb.passes.create`. */
  sdk: string;
  desc: string;
  idempotent: boolean;
  scopes: string[];
  href: string;
}

export interface GuideDoc {
  id: string;
  title: string;
  line: string;
  kind: 'guide' | 'page' | 'reference';
  href: string;
}

/** A guide snippet the Console can load: `?op=<op>&sample=<id>`. */
export interface SampleDoc {
  /** The snippet's file stem under `docs/developers/snippets/guides/` (`create-order-pass`): unique across guides. */
  id: string;
  /** The one operationId the snippet calls. */
  op: string;
  /** The guide it belongs to. */
  guide: string;
}

export interface EventDoc {
  type: string;
  summary: string;
  href: string;
}

export interface ActionDoc {
  id: string;
  label: string;
  line: string;
  /** Needs a sandbox, so the row says so. */
  sandbox: boolean;
  /** Extra words that find it. */
  words: string;
  href: string;
}

/** A word that finds nothing here but has an answer: "refund" is voiding or removing. */
export interface HintDoc {
  terms: string[];
  text: string;
  links: { label: string; href: string }[];
}

export interface SearchIndex {
  v: 1;
  errors: ErrorDoc[];
  ops: OpDoc[];
  guides: GuideDoc[];
  events: EventDoc[];
  samples: SampleDoc[];
  actions: ActionDoc[];
  hints: HintDoc[];
  /** Ids to offer beside the warning when a secret is pasted: a guide or page and an action. */
  secretHelp: string[];
}
