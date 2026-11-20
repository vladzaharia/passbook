// The APPLE service binding reaches the App Store Connect key. Only the provisioning workflow and
// its client may name it. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const ALLOWED =
  /^src\/worker\/(workflows\/identity-provision|modules\/identities\/asc-client)(\.test)?\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

/** Lines naming `.APPLE`, `['APPLE']` or a destructured `APPLE`. */
export function findAppleBinding(rel: string, text: string): string[] {
  if (ALLOWED.test(rel)) return [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const hit =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'APPLE') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'APPLE') ||
      (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(sf) === 'APPLE');
    if (hit) found.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

if (import.meta.main) {
  const bad = [...sources(join(root, 'src'))].flatMap((f) =>
    findAppleBinding(relative(root, f), readFileSync(f, 'utf8')),
  );
  if (bad.length > 0) {
    process.stderr.write(
      `env.APPLE outside workflows/identity-provision.ts and modules/identities/asc-client.ts:\n${bad.join('\n')}\n`,
    );
    process.exit(1);
  }
}
