export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Line diff by longest common subsequence. Fine for pass JSON and settings; not for huge files. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'del', text: a[i++] ?? '' });
    } else {
      out.push({ kind: 'add', text: b[j++] ?? '' });
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] ?? '' });
  while (j < m) out.push({ kind: 'add', text: b[j++] ?? '' });
  return out;
}
