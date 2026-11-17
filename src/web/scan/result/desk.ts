import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanEvent, ScanState } from '../machine/types.ts';

/** What the result card's desk regions need from the machine: the open picker and the PIN's managers. */
export function deskOf(
  loop: ScanState['loop'],
  staffList: ScanSession['staffList'],
  dispatch: (event: ScanEvent) => void,
) {
  return {
    picker: loop.s === 'member' ? loop.picker : null,
    onAmount: (value: number) => dispatch({ type: 'amount', value }),
    onConfirm: () => dispatch({ type: 'confirm' }),
    onCancel: () => dispatch({ type: 'cancel' }),
    managers: (staffList ?? []).filter((m) => m.role === 'manager'),
    onApprove: (staffId: string, pin: string) => dispatch({ type: 'approve', staffId, pin }),
  };
}
