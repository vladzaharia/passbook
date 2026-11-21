// The APPLE service binding reaches the App Store Connect key. Only the provisioning workflow, its
// client and the two admin calls that use it (the call ledger, certificate revoke) may name it or import the client. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const ALLOWED =
  /^src\/worker\/(workflows\/identity-provision|modules\/identities\/(asc-client|apple-calls|cert-admin))(\.test)?\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

const CLIENT_SPECIFIER = /(^|\/)asc-client(\.ts)?$/;

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
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    const clientImport = spec && ts.isStringLiteralLike(spec) && CLIENT_SPECIFIER.test(spec.text);
    if (hit || clientImport)
      found.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
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
