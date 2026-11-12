import { type Check, exactlyOne, rawCheck, rowIs } from '../../platform/authority-checks.ts';

/** The authority facts of a pass that a delivery compares; content fields are deliberately absent. */
export interface LineageFacts {
  id: string;
  holderEmail: string | null;
  ownerUserId: string | null;
  identityId: string;
  credentialGeneration: number;
  lifecycleGeneration: number;
  linkGeneration: number;
  templateId: string;
  status: 'active' | 'voided';
  removedAt: number | null;
}

/**
 * What must still hold for a pass email to go out: the pass is the recipient's, in this lineage
 * (credential, lifecycle and link generation), not removed, deleted or quarantined, and no
 * transfer is pending. Version, revision, object key, token and release are content: the send
 * reads them fresh, so a publish or refresh does not cancel mail (authority-epochs.md F12).
 */
export function passLineageChecks(pass: LineageFacts): Check[] {
  return [
    rowIs('passes', pass.id, {
      holder_email: pass.holderEmail,
      owner_user_id: pass.ownerUserId,
      identity_id: pass.identityId,
      credential_generation: pass.credentialGeneration,
      lifecycle_generation: pass.lifecycleGeneration,
      link_generation: pass.linkGeneration,
      template_id: pass.templateId,
      status: pass.status,
      removed_at: pass.removedAt,
      deleted_at: null,
      test_data_quarantined: 0,
    }),
    noPendingTransfer(pass.id),
  ];
}

export function noPendingTransfer(passId: string): Check {
  return rawCheck(
    'lineage',
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')`,
    [passId],
  );
}

/**
 * The durable issuance (F13): either the pass still in the lineage it was issued in, or exactly
 * the completed verified attach the delivery row names. A created pass may still be sent after its
 * release is withdrawn (owner answer 4), so no release is compared.
 */
export function issuanceLineageCheck(passId: string): Check {
  return rawCheck(
    'lineage',
    `EXISTS (SELECT 1 FROM pass_issuance_deliveries i JOIN passes p ON p.id = i.pass_id
      LEFT JOIN pass_credential_transfers t ON t.id = i.transfer_id
      WHERE i.pass_id = ?
        AND p.identity_id = i.identity_id AND p.lifecycle_generation = i.source_lifecycle_generation
        AND p.holder_email = i.recipient AND p.template_id = i.template_id
        AND p.status = 'active' AND p.removed_at IS NULL AND p.deleted_at IS NULL
        AND p.test_data_quarantined = 0
        AND p.connection_id IS i.connection_id AND p.external_ref IS i.connection_ref
        AND ((i.transfer_id IS NULL AND p.credential_generation = i.source_generation
            AND p.link_generation = i.source_link_generation
            AND p.owner_user_id IS i.source_owner_user_id)
          OR (i.transfer_id IS NOT NULL AND i.source_owner_user_id IS NULL
            AND t.pass_id = i.pass_id AND t.state = 'completed'
            AND t.source_generation = i.source_generation
            AND t.target_generation = p.credential_generation
            AND t.source_link_generation = i.source_link_generation + 1
            AND p.link_generation = t.source_link_generation
            AND t.target_holder_email = i.recipient AND t.target_owner_user_id IS NOT NULL
            AND p.owner_user_id = t.target_owner_user_id)))`,
    [passId],
  );
}

/** The queued delivery row still names this outbox row (a transfer START detaches it). */
export function queuedDeliveryCheck(passId: string, outboxId: string): Check {
  return exactlyOne('pass_issuance_deliveries', {
    pass_id: passId,
    state: 'queued',
    outbox_id: outboxId,
  });
}

/** The connection that issued the pass is still enabled at the generation the issuance captured. */
export function connectionCheck(connection: {
  connectionId: string;
  generation: number;
  mode?: string | null;
}): Check {
  return exactlyOne(
    'connections',
    {
      id: connection.connectionId,
      enabled: 1,
      generation: connection.generation,
      ...(connection.mode ? { mode: connection.mode } : {}),
    },
    undefined,
    'lineage',
  );
}
