import { isApiError } from '../../lib/errors.ts';
import { toast } from '../../ui/index.ts';

export type EmailState = 'sent' | 'retrying' | 'failed' | 'unknown';

/** What a failed send request says about the email, and what to do next. */
export function classifyEmailError(error: unknown): {
  state: Exclude<EmailState, 'sent'>;
  action: string;
} {
  if (!isApiError(error) || error.status === 0 || error.status === 504 || error.status === 408)
    return { state: 'unknown', action: 'Check the Delivery tab before sending again.' };
  if (error.status === 429 || error.status === 503)
    return { state: 'retrying', action: 'Wait a minute, then send again.' };
  if (error.status >= 500)
    return { state: 'unknown', action: 'Check the Delivery tab before sending again.' };
  return { state: 'failed', action: 'Fix the cause and send again.' };
}

/** One toast per outcome; `prefix` leads with what else happened ("Holder changed. "). */
export function reportEmailError(error: unknown, prefix = ''): void {
  const { state, action } = classifyEmailError(error);
  if (state === 'failed') toast.error(error, `${prefix}Could not send the email`);
  else if (state === 'retrying') toast.info(`${prefix}Email service is busy. ${action}`);
  else toast.info(`${prefix}Email status unknown. ${action}`);
}
