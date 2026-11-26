/** A span read in its largest whole unit: 45 s, 12 min, 6 h, 2 d. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/** 0:18, 1:12, 1:02:03: a clock that counts up. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0
    ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** `40 s`, `12 min`, `1 h 32 min`, `7 d 15 h`: a stay in the unit a person would say; days drop the minutes. */
export function formatStay(ms: number): string {
  const min = 60_000;
  if (ms < min) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const total = Math.round(ms / min);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours === 0 ? `${days} d` : `${days} d ${hours} h`;
  if (hours === 0) return `${mins} min`;
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`;
}
