const DAY_MS = 86_400_000;

export function daysRemaining(notAfter: number | null, now: number): number | null {
  return notAfter === null ? null : Math.floor((notAfter - now) / DAY_MS);
}
