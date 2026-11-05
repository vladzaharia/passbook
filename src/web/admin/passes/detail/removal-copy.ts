/** What Remove from Wallet does. Apple has no call that deletes a pass from a device. */
export const REMOVAL_LIMIT =
  'The pass moves to Expired passes in Wallet, and the holder can delete it there.';
export const REMOVAL_LIMIT_MANY =
  'Each pass moves to Expired passes in Wallet, and its holder can delete it there.';
export const REMOVAL_UNDO = 'You can restore it later.';
export const REMOVAL_UNDO_MANY = 'You can restore them later.';

export const removedOnDevices = (done: number, total: number) =>
  total === 0
    ? 'No device had the pass'
    : `Removed on ${done} of ${total} ${total === 1 ? 'device' : 'devices'}`;
