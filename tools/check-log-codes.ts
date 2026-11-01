// Fails when a log.warn or log.error call in src/worker has neither a stable `code` nor an error.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield path;
  }
}

const LOGGER = /(^|\.)(log|logger)$/;

export function findUncodedLogs(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const target = node.expression.expression.getText(sf).replace(/\?/g, '');
      if ((method === 'warn' || method === 'error') && LOGGER.test(target)) {
        const data = node.arguments[1];
        const ok =
          data === undefined
            ? false
            : !ts.isObjectLiteralExpression(data) ||
              data.properties.some(
                (p) =>
                  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                  ['code', 'error'].includes(p.name.getText(sf)),
              );
        if (!ok) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          found.push(`${relative(root, file)}:${line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

if (import.meta.main) {
  const bad = [...sources(join(root, 'src/worker'))].flatMap((f) =>
    findUncodedLogs(f, readFileSync(f, 'utf8')),
  );
  if (bad.length > 0) {
    process.stderr.write(`log.warn/log.error without code or error:\n${bad.join('\n')}\n`);
    process.exit(1);
  }
}
