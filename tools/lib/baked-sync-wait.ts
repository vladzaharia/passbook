// After a promote the baked sync creates the releases of baked templates. These helpers drive and check it.

/** The SQL of a ```sql <name> block in a markdown file, with list indentation removed. */
export function runbookSql(markdown: string, name: string): string | null {
  const block = new RegExp(`\`\`\`sql ${name}\\n([\\s\\S]*?)\`\`\``).exec(markdown);
  return block?.[1] ? block[1].replace(/^ {3}/gm, '').trim() : null;
}

export interface MissingHead {
  id: string;
  origin: string;
  status: string;
  org_id: string;
  passes: number;
}

/**
 * Live passes with no release head, from `wrangler d1 execute --json` output, minus archived and
 * other inactive templates (they never get a head; see the runbook).
 */
export function activeMissingHeads(output: string): MissingHead[] {
  const parsed: unknown = JSON.parse(output);
  const rows = (parsed as { results?: MissingHead[] }[])[0]?.results ?? [];
  return rows.filter((row) => row.status === 'active');
}

export interface WaitOptions {
  trigger: () => Promise<void>;
  missing: () => Promise<MissingHead[]>;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  attempts: number;
}

/** Triggers the sync, then polls until every live pass has a head. Returns what is still missing. */
export async function waitForBakedHeads(options: WaitOptions): Promise<MissingHead[]> {
  let missing: MissingHead[] = [];
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    await options.trigger();
    missing = await options.missing();
    if (missing.length === 0) return [];
    await options.sleep(options.intervalMs);
  }
  return missing;
}
