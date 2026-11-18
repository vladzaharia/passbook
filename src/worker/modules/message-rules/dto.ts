import { InputMatchSchema } from '../../../shared/contracts/broadcasts.ts';
import type {
  MessageRuleDto,
  RuleAnchor,
  RuleOffset,
  RulePausedCode,
} from '../../../shared/contracts/message-rules.ts';
import type { RuleRow } from './repo.ts';

export const anchorOf = (row: RuleRow): RuleAnchor =>
  row.anchor_kind === 'input'
    ? { kind: 'input', input: row.anchor_input ?? '' }
    : { kind: 'lastScan' };

export const offsetOf = (row: RuleRow): RuleOffset => ({
  amount: row.offset_amount,
  unit: row.offset_unit,
  when: row.offset_when,
});

export function toRuleDto(row: RuleRow): MessageRuleDto {
  return {
    id: row.id,
    orgId: row.org_id,
    mode: row.mode,
    name: row.name,
    templateIds: JSON.parse(row.template_ids) as string[],
    ...(row.match ? { match: InputMatchSchema.parse(JSON.parse(row.match)) } : {}),
    anchor: anchorOf(row),
    offset: offsetOf(row),
    yearly: row.yearly === 1,
    sendAt: row.send_at,
    timeZone: row.time_zone,
    message: row.message,
    clearAfter: row.clear_after,
    on: row.state === 'on',
    state: row.state,
    pausedCode: row.paused_code as RulePausedCode | null,
    nextCheckAt: row.next_check_at,
    sent: row.sent,
    skipped: row.skipped,
    createdAt: row.created_at,
    updatedAt: row.edited_at,
    version: row.version,
  };
}
