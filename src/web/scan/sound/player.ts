import type { Tone } from '../machine/types.ts';
import { createUnlock } from './audio-unlock.ts';
import { GARNISH, type Garnish, type Note, TONES } from './tones.ts';

const KEY = 'passbook-scan-sound';

export function createPlayer() {
  const audio = createUnlock();
  const live = new Set<{ g: AudioParam; o: OscillatorNode }>();
  let on: boolean | undefined;
  const enabled = () => {
    if (on === undefined)
      try {
        on = localStorage.getItem(KEY) !== '0';
      } catch {
        on = true;
      }
    return on;
  };

  const note = ([wave, from, to, at, len, peak]: Note, when: number) => {
    const a = audio.get();
    if (!a) return;
    const t = when + at / 1000;
    const end = t + len / 1000;
    const o = a.ctx.createOscillator();
    const low = a.ctx.createBiquadFilter();
    const amp = a.ctx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(from, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + 0.06);
    low.type = 'lowpass';
    low.frequency.value = wave === 'square' ? 6000 : 2400;
    const g = amp.gain;
    g.setValueAtTime(1e-4, t);
    g.linearRampToValueAtTime(peak, t + 0.005);
    g.exponentialRampToValueAtTime(1e-4, end);
    o.connect(low).connect(amp).connect(a.master);
    o.start(t);
    o.stop(end + 0.02);
    const e = { g, o };
    live.add(e);
    o.onended = () => live.delete(e);
  };

  const player = {
    enabled,
    unlock: audio.unlock,
    play(tone: Tone, opts: { garnish?: Garnish; at?: number } = {}) {
      const a = enabled() ? audio.get() : null;
      if (!a) return;
      const { ctx } = a;
      if (ctx.state !== 'running') void ctx.resume();
      for (const n of TONES[tone]) note(n, ctx.currentTime);
      if (opts.garnish) {
        const lead = (opts.at ?? 350) / 1000 - (ctx.outputLatency || ctx.baseLatency);
        note(GARNISH[opts.garnish], ctx.currentTime + Math.max(0, lead));
      }
    },
    cut() {
      const now = audio.get()?.ctx.currentTime ?? 0;
      for (const { g, o } of live) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.01);
        o.stop(now + 0.02);
      }
      live.clear();
    },
    setEnabled(next: boolean) {
      const was = enabled();
      on = next;
      try {
        localStorage.setItem(KEY, next ? '1' : '0');
      } catch {
        // Unsaved: the choice holds for this visit.
      }
      if (next && !was) {
        audio.unlock();
        player.play('ok');
      }
    },
  };
  return player;
}

export const sound = createPlayer();
