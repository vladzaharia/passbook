-- Keep all passless source checks while bounding D1's expression-tree depth.
DROP TRIGGER scan_passless_insert_guard;
CREATE TRIGGER scan_passless_insert_guard BEFORE INSERT ON scan_passless_proofs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM scan_passless_proofs WHERE scan_id=NEW.scan_id) OR NEW.invalidated<>0 OR NOT EXISTS (
    SELECT 1 FROM scans s WHERE (
      s.id=NEW.scan_id AND s.org_id=NEW.org_id AND s.mode=NEW.mode
      AND s.state='done' AND s.outcome='refused' AND s.reason IN ('not_found','ambiguous')
      AND s.pass_id IS NULL AND s.template_id IS NULL AND s.pass_version IS NULL
    ) AND (
      s.action_id IS NULL AND s.action_kind IS NULL AND s.direction IS NULL
      AND s.amount IS NULL AND s.before_value IS NULL AND s.after_value IS NULL
      AND s.override_of IS NULL AND s.approved_by IS NULL AND s.group_id IS NULL
      AND s.offline=0 AND s.notified=0 AND s.undoes IS NULL AND s.undone_by IS NULL
      AND s.undone_at IS NULL AND s.presence_scope IS NULL
    ) AND (
      ((s.event_id IS NULL AND json_type(NEW.scope_json,'$.eventRevision')='null')
        OR (s.event_id IS NOT NULL AND json_type(NEW.scope_json,'$.eventRevision')='integer'
          AND EXISTS(SELECT 1 FROM scan_events e WHERE e.id=s.event_id AND e.org_id=s.org_id
            AND e.mode=s.mode AND e.archived_at IS NULL
            AND e.updated_at=json_extract(NEW.scope_json,'$.eventRevision'))))
      AND ((s.scanner_id IS NULL AND json_type(NEW.scope_json,'$.scannerRevision')='null')
        OR (s.scanner_id IS NOT NULL AND json_type(NEW.scope_json,'$.scannerRevision')='integer'
          AND EXISTS(SELECT 1 FROM scanners sc WHERE sc.id=s.scanner_id AND sc.org_id=s.org_id
            AND sc.mode=s.mode AND sc.updated_at=json_extract(NEW.scope_json,'$.scannerRevision'))))
      AND ((s.staff_id IS NULL AND json_type(NEW.scope_json,'$.staffRevision')='null')
        OR (s.staff_id IS NOT NULL AND json_type(NEW.scope_json,'$.staffRevision')='integer'
          AND EXISTS(SELECT 1 FROM scan_staff st WHERE st.id=s.staff_id AND st.org_id=s.org_id
            AND st.updated_at=json_extract(NEW.scope_json,'$.staffRevision'))))
    ) AND (
      NOT EXISTS(SELECT 1 FROM scan_retention_proofs r WHERE r.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_retention_delete_intents i WHERE i.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_retained_gates g WHERE g.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_quarantine_exclusions q WHERE q.scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM pass_events l WHERE (CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.scanId') END)=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_gates g WHERE g.last_scan_id=s.id OR g.prev_scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scan_presence p WHERE p.last_scan_id=s.id OR p.prev_scan_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM scans x WHERE x.override_of=s.id OR x.undoes=s.id OR x.undone_by=s.id)
    ) AND (
      json_extract(NEW.scope_json,'$.v')=1 AND json_type(NEW.scope_json,'$.noPassSelected')='true'
      AND json_extract(NEW.scope_json,'$.scanId')=s.id AND json_extract(NEW.scope_json,'$.orgId')=s.org_id
      AND json_extract(NEW.scope_json,'$.mode')=s.mode AND json_extract(NEW.scope_json,'$.eventId') IS s.event_id
      AND json_extract(NEW.scope_json,'$.scannerId') IS s.scanner_id AND json_extract(NEW.scope_json,'$.staffId') IS s.staff_id
      AND json_extract(NEW.scope_json,'$.actorType')=s.actor_type AND json_extract(NEW.scope_json,'$.actorId')=s.actor_id
      AND json_extract(NEW.scope_json,'$.actorKey')=s.actor_key AND json_extract(NEW.scope_json,'$.method')=s.method
      AND json_extract(NEW.scope_json,'$.at')=s.at AND json_extract(NEW.scope_json,'$.outcome')=s.outcome
      AND json_extract(NEW.scope_json,'$.reason')=s.reason
    ) AND (
      json_type(NEW.scope_json,'$.credentialKeysetCommitment')='text'
      AND length(json_extract(NEW.scope_json,'$.credentialKeysetCommitment'))=64
      AND json_extract(NEW.scope_json,'$.credentialKeysetCommitment') NOT GLOB '*[^0-9a-f]*'
      AND ((s.actor_type='scanner' AND json_type(NEW.scope_json,'$.tenantRef')='null')
        OR (s.actor_type='user' AND json_type(NEW.scope_json,'$.tenantRef')='text'
          AND length(json_extract(NEW.scope_json,'$.tenantRef'))=64
          AND json_extract(NEW.scope_json,'$.tenantRef') NOT GLOB '*[^0-9a-f]*'))
      AND ((json_type(NEW.scope_json,'$.sessionId')='null'
          AND json_type(NEW.scope_json,'$.sessionRevision')='null')
        OR (json_type(NEW.scope_json,'$.sessionId')='text'
          AND json_type(NEW.scope_json,'$.sessionRevision')='integer'
          AND EXISTS(SELECT 1 FROM scanning_devices d JOIN scanning_sessions w
            ON w.id=d.session_id AND w.org_id=d.org_id AND w.mode=d.mode
            WHERE d.scanner_id=s.scanner_id AND d.session_id=json_extract(NEW.scope_json,'$.sessionId')
              AND d.org_id=s.org_id AND d.mode=s.mode AND w.status='active'
              AND w.updated_at=json_extract(NEW.scope_json,'$.sessionRevision'))))
    )
  ) THEN RAISE(ABORT,'invalid passless proof source') END;
END;

-- Restore the original insert-trigger order so malformed commitments get the same error.
DROP TRIGGER scan_passless_credential_keyset_guard;
CREATE TRIGGER scan_passless_credential_keyset_guard
BEFORE INSERT ON scan_passless_proofs
WHEN json_type(NEW.scope_json, '$.credentialKeysetCommitment') IS NOT 'text'
  OR length(json_extract(NEW.scope_json, '$.credentialKeysetCommitment')) <> 64
  OR json_extract(NEW.scope_json, '$.credentialKeysetCommitment') GLOB '*[^0-9a-f]*'
  OR NOT EXISTS (SELECT 1 FROM credential_ref_keyset
    WHERE id = 1 AND commitment = json_extract(NEW.scope_json, '$.credentialKeysetCommitment'))
BEGIN SELECT RAISE(ABORT, 'invalid passless credential keyset'); END;

-- These keyset-bound views are expanded inside provider lifecycle triggers. Keep the
-- retirement evidence in the same views, but bound each conjunction's expression depth.
DROP VIEW wallet_provider_retirement_complete;
CREATE VIEW wallet_provider_retirement_complete AS
SELECT i.id FROM wallet_provider_instances i
WHERE i.lifecycle = 'retired'
  AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = i.credential_keyset_commitment)
  AND (
  (i.retirement_reason = 'not_issued' AND i.account_id IS NULL AND i.identity_projection_release_id IS NULL
    AND i.desired_version = 0 AND i.desired_operation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs o WHERE o.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings b WHERE b.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events e WHERE e.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts r WHERE r.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts r WHERE r.instance_id = i.id))
  OR (i.provider = 'samsung' AND i.retirement_reason IS NULL AND i.retirement_requested_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
      AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
    AND EXISTS (SELECT 1 FROM template_releases projection_release
      JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
      JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
      JOIN wallet_provider_projection_evidence_history evidence ON evidence.candidate_id = candidate.id
      WHERE (
        projection_release.id = i.identity_projection_release_id AND projection_release.org_id = i.org_id
        AND projection_release.mode = i.mode AND projection_release.provider = 'samsung' AND projection_release.source = 'approved'
        AND candidate.provider_account_id = i.account_id
        AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = 'samsung'
      ) AND (
        projection_release.candidate_hash = candidate.candidate_hash AND approval.candidate_hash = candidate.candidate_hash
        AND approval.reviewer_id != candidate.author_id
        AND (candidate.version_author_id IS NULL OR approval.reviewer_id != candidate.version_author_id)
        AND projection_release.credential_keyset_commitment = i.credential_keyset_commitment
        AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
        AND approval.credential_keyset_commitment = i.credential_keyset_commitment
        AND evidence.credential_keyset_commitment = i.credential_keyset_commitment
      ) AND (
        evidence.org_id = i.org_id AND evidence.mode = i.mode AND evidence.account_id = i.account_id
        AND evidence.account_revision = candidate.provider_account_revision AND evidence.candidate_hash = candidate.candidate_hash
        AND evidence.provider_identity_hash = candidate.provider_identity_hash
        AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
        AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
        AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
        AND evidence.testing_mode_off = 'Y' AND evidence.verified_at <= projection_release.created_at
        AND projection_release.created_at < evidence.expires_at
      ))
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
      WHERE op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
        AND op.kind = 'revoke' AND op.state = 'succeeded'
        AND op.credential_keyset_commitment = i.credential_keyset_commitment)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
      WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
        JOIN template_releases r ON r.id = i.identity_projection_release_id
        JOIN template_candidates c ON c.id = r.candidate_id
        WHERE (
          ref.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.ref_hash = ref.ref_hash AND t.org_id = i.org_id AND t.mode = i.mode
          AND t.account_id = i.account_id AND t.release_id = r.id AND t.candidate_id = c.id
        ) AND (
          r.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.provider_account_id = i.account_id AND t.account_revision = c.provider_account_revision
          AND t.provider_identity_hash = c.provider_identity_hash
        )
      )
    )
  )
);

DROP VIEW wallet_provider_unissued_placeholder;
CREATE VIEW wallet_provider_unissued_placeholder AS
SELECT i.id FROM wallet_provider_instances i
WHERE (
  i.account_id IS NULL AND i.identity_projection_release_id IS NULL
  AND i.desired_version = 0 AND i.desired_operation_id IS NULL
  AND i.retired_at IS NULL AND i.revoked_at IS NULL
) AND (
  NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs o WHERE o.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings b WHERE b.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events e WHERE e.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts r WHERE r.instance_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts r WHERE r.instance_id = i.id)
);

DROP VIEW wallet_provider_pinned_desired;
CREATE VIEW wallet_provider_pinned_desired AS
SELECT i.id FROM wallet_provider_instances i
JOIN wallet_provider_instance_operations op ON op.id = i.desired_operation_id
  AND op.instance_id = i.id AND op.version = i.desired_version
JOIN template_releases projection_release ON projection_release.id = i.identity_projection_release_id
JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = i.credential_keyset_commitment
WHERE (
  op.credential_keyset_commitment = i.credential_keyset_commitment
  AND projection_release.credential_keyset_commitment = i.credential_keyset_commitment
  AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
  AND approval.credential_keyset_commitment = i.credential_keyset_commitment
) AND (
  projection_release.org_id = i.org_id AND projection_release.mode = i.mode
  AND projection_release.provider = i.provider AND projection_release.source = 'approved'
  AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = i.provider
  AND candidate.provider_account_id = i.account_id AND projection_release.candidate_hash = candidate.candidate_hash
  AND approval.candidate_hash = candidate.candidate_hash
);

-- Separate target authority and prior-retirement checks to avoid expanding both views into
-- one deep expression. Both checks still execute atomically before the lifecycle update.
DROP TRIGGER wallet_provider_generation_ready_guard;
CREATE TRIGGER wallet_provider_generation_ready_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'blocked' AND NEW.lifecycle = 'ready'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM passes p JOIN pass_credential_transfers t ON t.pass_id = p.id
    JOIN wallet_provider_unissued_placeholder empty ON empty.id = OLD.id
    JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = OLD.credential_keyset_commitment
    WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = OLD.mode
      AND p.credential_generation = OLD.credential_generation AND OLD.retirement_requested_at IS NULL
      AND t.org_id = p.org_id AND t.mode = p.mode AND t.target_generation = OLD.credential_generation
      AND t.state = 'completed'
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pending
        WHERE pending.pass_id = p.id AND pending.state = 'pending')
  ) THEN RAISE(ABORT, 'provider generation is blocked') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM passes p JOIN wallet_provider_instances previous ON previous.pass_id = p.id
    WHERE p.id = OLD.pass_id AND previous.credential_generation < OLD.credential_generation
      AND (previous.org_id != p.org_id OR previous.mode != p.mode
        OR NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = previous.id))
  ) THEN RAISE(ABORT, 'provider generation is blocked') END;
END;
