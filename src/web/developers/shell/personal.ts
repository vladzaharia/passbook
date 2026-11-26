import { loadSession } from '../../workbench/console/session.ts';
import { type ExampleKind, type Personal, personalize } from '../model/ids.ts';

interface Sandbox {
  orgId: string;
  templateId: string | null;
}

/** The signed-in reader's sandbox, or null: signed out, or no sandbox yet. */
async function mySandbox(): Promise<Personal | null> {
  try {
    // Signed out or no sandbox: nothing to ask for, and no 401 in the console.
    if ((await loadSession()).kind !== 'ready') return null;
    const res = await fetch('/api/v1/developer/sandbox', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const { sandbox } = (await res.json()) as { sandbox: Sandbox | null };
    if (!sandbox) return null;
    const ids: Partial<Record<ExampleKind, string>> = { orgId: sandbox.orgId };
    if (sandbox.templateId) ids.templateId = sandbox.templateId;
    return ids;
  } catch {
    // Offline or blocked: the examples stay as written.
    return null;
  }
}

/** Swaps the example ids in every sample for the reader's own. The key is never touched: it is `$PASSBOOK_KEY`. */
export async function mount(): Promise<void> {
  const ids = await mySandbox();
  if (!ids) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('[data-samples]')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.nodeValue) node.nodeValue = personalize(node.nodeValue, ids);
}
