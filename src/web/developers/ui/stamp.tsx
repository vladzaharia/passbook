/** Status as a rotated outlined stamp. The words carry the meaning; the colour only agrees. */
export function Stamp({ status, tone = 'ok' }: { status: string; tone?: 'ok' | 'bad' }) {
  return <span className={`stamp ${tone}`}>{status}</span>;
}
