import { describe, expect, it } from 'vitest';
import type { ChannelReason } from '../contracts/channels.ts';
import { channelBlocked, channelReasonText } from './channels.ts';

const STAYS = 'Copies stay as they are.';

describe('channel reason lines', () => {
  const cases: [string, ChannelReason, string, boolean][] = [
    ['org block', 'blocked', 'Blocked for this organization', true],
    ['not enrolled', 'not_enrolled', 'Organization not enrolled', true],
    ['tags off', 'tags_off', 'Tags off', true],
    ['platform printing off', 'printing_off', 'Printing off for all organizations', false],
    ['not released', 'not_released', 'Not available yet', false],
    ['no design', 'no_design', 'No design for this template', false],
  ];
  it.each(cases)('%s', (_name, reason, text, stays) => {
    expect(channelReasonText(reason)).toBe(text);
    expect(channelBlocked(reason)).toBe(stays ? `${text}. ${STAYS}` : text);
  });
});
