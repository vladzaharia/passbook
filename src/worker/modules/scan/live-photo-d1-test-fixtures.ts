import { liveRecipient } from './live-auth.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { liveDisclosureCsrfStmts } from './repo-live-authority.ts';
import { candidateById } from './repo-lookup.ts';
import { hub, kit, photoFixture } from './scan-hub-test-fixtures.ts';

/** A genuine original source proof, recipient observation, candidate and both CSRF reads. */
export async function liveGateFixture() {
  const fixture = await photoFixture();
  const sealed = await hub().sourceProof(fixture.event.id);
  const proof = sealed && (await openLiveSourceProof(kit.env, sealed));
  const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
  const loaded = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
  if (!proof || !recipient || !loaded) throw new Error('Missing live gate fixture.');
  const candidate = { ...loaded, ...proof.credentialContext };
  const csrf = liveDisclosureCsrfStmts(kit.env.DB, proof.actor, recipient.actor);
  if (!csrf.source || !csrf.recipient) throw new Error('Missing source or recipient CSRF read.');
  const [sourceResult, recipientResult] = await kit.env.DB.batch([csrf.source, csrf.recipient]);
  return {
    fixture,
    proof,
    recipient,
    candidate,
    input: {
      source: proof.actor,
      recipient,
      credentialContext: proof.credentialContext,
      candidate,
      requirePhoto: true,
    },
    results: { sourceResult, recipientResult },
  };
}
