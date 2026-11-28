/** "1 pass", "12 passes": the count with thousands separators, then the singular or plural noun. */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
