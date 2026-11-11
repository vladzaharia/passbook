/** Lexes just enough SQL to find keywords, parentheses and term boundaries. */
export interface SqlToken {
  start: number;
  end: number;
  /** Upper-cased keyword, or one of `( ) , *`; empty for anything else. */
  word: string;
}

function skipQuoted(sql: string, from: number, close: string): number {
  let at = from + 1;
  while (at < sql.length) {
    if (sql[at] !== close) at++;
    else if (close !== ']' && sql[at + 1] === close) at += 2;
    else return at + 1;
  }
  return -1;
}

/** Returns null for input it cannot lex safely (an unterminated string or comment). */
export function tokenizeSql(sql: string): SqlToken[] | null {
  const tokens: SqlToken[] = [];
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] as string;
    if (/\s/.test(char)) {
      at++;
    } else if (char === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at);
      at = end < 0 ? sql.length : end + 1;
    } else if (char === '/' && sql[at + 1] === '*') {
      const end = sql.indexOf('*/', at + 2);
      if (end < 0) return null;
      // A marker comment must stay attached to its placeholder, so it joins the previous token.
      const previous = tokens[tokens.length - 1];
      if (previous?.end === at) previous.end = end + 2;
      at = end + 2;
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      const end = skipQuoted(sql, at, char === '[' ? ']' : char);
      if (end < 0) return null;
      tokens.push({ start: at, end, word: '' });
      at = end;
    } else if (/[A-Za-z_]/.test(char)) {
      let end = at + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end] as string)) end++;
      const dotted = sql[at - 1] === '.' || sql[end] === '.';
      let word = dotted ? '' : sql.slice(at, end).toUpperCase();
      // `IS [NOT] DISTINCT FROM` is an operator, not a FROM clause.
      const [before, earlier] = [tokens[tokens.length - 1]?.word, tokens[tokens.length - 2]?.word];
      if (word === 'FROM' && before === 'DISTINCT' && (earlier === 'IS' || earlier === 'NOT'))
        word = '';
      tokens.push({ start: at, end, word });
      at = end;
    } else {
      tokens.push({ start: at, end: at + 1, word: '(),*'.includes(char) ? char : '' });
      at++;
    }
  }
  return tokens;
}

/** Maps each `(` token index to its `)`; null when the parentheses do not balance. */
export function matchParens(tokens: SqlToken[]): number[] | null {
  const partner: number[] = [];
  const stack: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.word === '(') stack.push(index);
    else if (token.word === ')') {
      const open = stack.pop();
      if (open === undefined) return null;
      partner[open] = index;
    }
  }
  return stack.length > 0 ? null : partner;
}
