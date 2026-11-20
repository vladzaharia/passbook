import { CHANNEL_COPY, CHANNEL_LABEL } from '../../../shared/copy/channels.ts';
import type { PassEmailNotice } from './binding.ts';

/** The subject, heading and line of a pass email that tells the holder a copy or code changed. */
export function holderNoticeCopy(n: PassEmailNotice): {
  subject: string;
  title: string;
  line: string;
} {
  if (n.reason === 'codes_replaced')
    return {
      subject: CHANNEL_COPY.codesReplacedTitle,
      title: CHANNEL_COPY.codesReplacedTitle,
      line: CHANNEL_COPY.codesReplaced,
    };
  const names = (n.channels ?? []).map((c) => CHANNEL_LABEL[c]).join(', ') || 'A';
  return {
    subject: 'A copy of your pass stopped working',
    title: 'A copy stopped working',
    line: CHANNEL_COPY.holderNotice.replace('{channel}', names).replace('{link}', 'your pass'),
  };
}
