/** One context, made inside a tap; later taps resume it. */
export function createUnlock() {
  let a: { ctx: AudioContext; master: GainNode } | null = null;
  return {
    get: () => a,
    unlock() {
      if (!a && typeof AudioContext === 'function') {
        const s = (navigator as { audioSession?: { type: string } }).audioSession;
        if (s) s.type = 'playback';
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        const master = ctx.createGain();
        master.gain.value = 0.8;
        master.connect(ctx.destination);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') void ctx.suspend();
        });
        a = { ctx, master };
      }
      if (a && a.ctx.state !== 'running') void a.ctx.resume();
    },
  };
}
