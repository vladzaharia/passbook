/** `1,234`. */
export const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The pill tone of a status: 2xx success, 3xx info, 4xx warning, 5xx danger. */
export const flavour = (status: number): 'success' | 'info' | 'warning' | 'danger' =>
  status >= 500 ? 'danger' : status >= 400 ? 'warning' : status >= 300 ? 'info' : 'success';
