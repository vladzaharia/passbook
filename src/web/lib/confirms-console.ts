import type { ConfirmCopy } from './confirms.ts';

/** A Console run that changes Test data: it names the call, since the person may not have written it. */
export function consoleRunConfirm(method: string, path: string): ConfirmCopy {
  return {
    title: `Run ${method} ${path}?`,
    confirmLabel: `Run ${method}`,
    description: 'It changes Test data.',
    typed: false,
  };
}
