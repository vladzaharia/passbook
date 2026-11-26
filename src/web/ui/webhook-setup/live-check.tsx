import { ListenCheck, type ListenProps } from './listen-check.tsx';
import { SendCheck, type SendProps } from './send-check.tsx';

export type LiveCheckProps = ListenProps | SendProps;

/**
 * The proof that setup worked. `listen` waits on what PassBook saw arrive from the provider (the
 * arrival ledger, polled); `send` posts a test event to your server and reads the answer. One panel:
 * the buddy, a polite live region, the steps and, when something is wrong, what to do about it.
 */
export function LiveCheck(props: LiveCheckProps) {
  return props.mode === 'listen' ? <ListenCheck {...props} /> : <SendCheck {...props} />;
}

export type { ListenProps, SendProps };
