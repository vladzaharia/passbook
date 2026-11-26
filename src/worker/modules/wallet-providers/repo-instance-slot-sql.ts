/** SQL fragments for the instance insert; both use the new row's alias `i`. */

/** No older row of the pass and provider may hold the slot, except a settled channel-off predecessor. */
export const slotFreeSql = `NOT EXISTS (SELECT 1 FROM wallet_provider_instances old WHERE old.pass_id = i.pass_id
  AND old.provider = i.provider AND (old.credential_generation > i.credential_generation
    OR (old.credential_generation = i.credential_generation AND (old.channel_epoch >= i.channel_epoch
      OR old.retirement_cause IS NOT 'channel_off' OR old.lifecycle NOT IN ('revoked', 'retired')))
    OR (old.credential_generation < i.credential_generation AND old.lifecycle != 'retired')
    OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
      WHERE busy.instance_id = old.id AND busy.state IN ('claimed', 'uncertain'))))`;

/**
 * A successor needs the channel on, the enrolment On and not held, and a revoke that has succeeded
 * with nothing queued. The 0226 trigger refuses the rest with an error; this keeps a lost race a no-op.
 */
export const successorGuardSql = `AND NOT EXISTS (SELECT 1 FROM pass_channels retired WHERE retired.pass_id = i.pass_id
    AND retired.channel = i.provider AND retired.retired_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM wallet_provider_accounts enrolment WHERE enrolment.id = i.account_id
    AND enrolment.enabled_at IS NOT NULL AND enrolment.platform_hold_at IS NULL)
  AND EXISTS (SELECT 1 FROM wallet_provider_instances pred WHERE pred.pass_id = i.pass_id
    AND pred.provider = i.provider AND pred.credential_generation = i.credential_generation
    AND pred.channel_epoch = i.channel_epoch - 1
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations settled
      WHERE settled.id = pred.desired_operation_id AND settled.instance_id = pred.id
        AND settled.kind = 'revoke' AND settled.state = 'succeeded')
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations queued
      WHERE queued.instance_id = pred.id AND queued.state IN ('pending', 'retry')))`;
