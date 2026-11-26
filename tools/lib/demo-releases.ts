// Org templates issue passes only from a live Apple release. The owner authors each candidate and
// the second demo reviewer approves it (an author approves alone only in a one-reviewer org), then
// the owner publishes it. Skips templates that have one.
import type { Session } from './demo-client.ts';

type Template = {
  id: string;
  name: string;
  orgId: string | null;
  status: string;
  activeVersion: string | null;
};

export async function releaseTemplates(
  owner: Session,
  templates: Template[],
  reviewer: Session,
): Promise<void> {
  for (const t of templates) {
    // The seeded failed import never gets a version; waiting for it would only stall the run.
    if (t.status !== 'active' || !t.orgId || t.activeVersion || t.name === 'Broken Badge') continue;
    let version: string | undefined;
    // An upload or blueprint copy imports asynchronously; its version appears when the build is done.
    for (let attempt = 0; attempt < 90 && !version; attempt++) {
      version = (await owner.get(`/api/v1/templates/${t.id}?orgId=${t.orgId}`)).versions?.[0]
        ?.version;
      if (!version) await new Promise((done) => setTimeout(done, 1000));
    }
    if (!version) {
      console.warn(`- ${t.name} has no version yet; not released`);
      continue;
    }
    const scope = { orgId: t.orgId, mode: 'live', provider: 'apple' };
    const base = `/api/v1/templates/${t.id}`;
    const candidate = await owner.send('POST', `${base}/candidates`, { ...scope, version });
    const approval = await reviewer.send('POST', `${base}/candidates/${candidate.id}/approve`, {
      ...scope,
      candidateHash: candidate.candidateHash,
    });
    await owner.send('POST', `${base}/releases`, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    console.log(`- released ${t.name} (${version})`);
  }
}
