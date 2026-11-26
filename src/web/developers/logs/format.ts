const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** `14:02:11` today, `Nov 19 14:02` before; the browser's local time. */
export function clock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${time}:${two(d.getSeconds())}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** `1,234`. */
export const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The pill tone of a status: 2xx success, 3xx info, 4xx warning, 5xx danger. */
export const flavour = (status: number): 'success' | 'info' | 'warning' | 'danger' =>
  status >= 500 ? 'danger' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success';
