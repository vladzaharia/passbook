/** What Remove from Wallet does. Apple has no call that deletes a pass from a device. */
export const REMOVAL_LIMIT =
  'Once the removal update reaches Wallet, the pass moves to Expired passes and the holder can delete it there.';
export const REMOVAL_LIMIT_MANY =
  'Once the removal update reaches Wallet, each pass moves to Expired passes and its holder can delete it there.';
export const REMOVAL_UNDO = 'You can restore it later.';
export const REMOVAL_UNDO_MANY = 'You can restore them later.';

export const removedOnDevices = (done: number, total: number) =>
  total === 0
    ? 'No registered devices recorded for removal'
    : `Removal update fetched or registration ended on ${done} of ${total} ${total === 1 ? 'device' : 'devices'}`;
