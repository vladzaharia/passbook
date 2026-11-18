/** The screen wake lock: asked at Start, let go on pause, hide and dispose. */
export function createWakeLock(notice: (text: string) => void) {
  let lock: WakeLockSentinel | null = null;
  return {
    request() {
      if (navigator.wakeLock)
        void navigator.wakeLock
          .request('screen')
          .then((next) => {
            lock = next;
          })
          .catch(() => notice('Screen lock unavailable.'));
    },
    release() {
      void lock?.release();
      lock = null;
    },
  };
}
