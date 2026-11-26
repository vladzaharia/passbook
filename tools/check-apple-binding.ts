// The APPLE service binding reaches the App Store Connect key. Only the provisioning workflow and
// its client may name it, or import the client. `asc-ledger.ts` is read-only: it may name the binding but
// no provisioner method except `calls`, and may not import the client. Run in `npm run check:rules`.
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

/** The read-only ledger reader; routes may import it. */
const READ_ONLY = /^src\/worker\/modules\/identities\/asc-ledger(\.test)?\.ts$/;
/** Provisioner methods the read-only file must never name. */
const WRITE_METHODS = new Set([
  'createPassType',
  'createCertificate',
  'listCertificates',
  'revokeCertificate',
  'findPassType',
]);

const CLIENT_SPECIFIER = /(^|\/)asc-client(\.ts)?$/;

/** Lines of the read-only file that import the client or name any provisioner method but `calls`. */
function findReadOnlyViolations(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : undefined;
    const bad =
      (ts.isIdentifier(node) && WRITE_METHODS.has(node.text)) ||
      (spec && ts.isStringLiteralLike(spec) && CLIENT_SPECIFIER.test(spec.text));
    if (bad) found.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Names holding a copy of the env: `const { DB, ...rest } = env`, `const copy = { ...env }`. */
const copies = new Set<string>();

const isEnvLike = (n: ts.Node): boolean =>
  (ts.isIdentifier(n) && (/^(env|bindings)$/i.test(n.text) || copies.has(n.text))) ||
  (ts.isPropertyAccessExpression(n) && n.name.text === 'env') ||
  ((ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) &&
    isEnvLike(n.expression)) ||
  (ts.isObjectLiteralExpression(n) &&
    n.properties.some((p) => ts.isSpreadAssignment(p) && isEnvLike(p.expression)));

/**
 * Files reviewed to read env bindings by a computed key or as a whole (key rings, binding-name lookups).
 * None may reach APPLE: a name from outside must not select a binding. Tests never ship, so they are exempt.
 */
const DYNAMIC_ENV_OK = new RegExp(
  `(\\.test\\.tsx?|test-fixtures\\.ts|test-kit\\.ts)$|^(${[
    'src/worker/jobs/query-counter',
    'src/worker/modules/connections/webhook-key-context',
    'src/worker/modules/delivery/apns',
    'src/worker/modules/identities/db-resolver',
    'src/worker/modules/passes/credential-keyset',
    'src/worker/modules/scan/credential-input',
    'src/worker/modules/scan/credential-keyset-authority',
    'src/worker/modules/scan/scan-retention-proof',
    'src/worker/modules/status/security-checks',
    'src/worker/modules/wallet-providers/account-credential-material',
    'src/worker/platform/crypto',
    'src/worker/platform/env',
    'src/worker/platform/mac-roots',
    'src/worker/platform/rate-limit',
  ].join('|')})\\.ts$`,
);

const ENV_TYPE = /\b(Env|Bindings|Cloudflare\.Env)\b/;
/** Whole-object readers: they hand over every binding, APPLE included. */
const ENUMERATORS =
  /^(Object\.(values|entries|keys|assign|getOwnPropertyNames|getOwnPropertyDescriptors?|fromEntries)|Reflect\.(get|ownKeys|getOwnPropertyDescriptor|has))$/;

/** String value of a literal, a template without substitutions, a `+` of those, or a file-level const of them. */
function constString(n: ts.Node, consts: Map<string, string>): string | null {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isParenthesizedExpression(n)) return constString(n.expression, consts);
  if (ts.isIdentifier(n)) return consts.get(n.text) ?? null;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const [a, b] = [constString(n.left, consts), constString(n.right, consts)];
    return a !== null && b !== null ? a + b : null;
  }
  return null;
}

/** Records the names that receive the env or its rest, so later access through them is checked too. */
function trackCopy(node: ts.Node, sf: ts.SourceFile): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (node.initializer && isEnvLike(node.initializer)) copies.add(node.name.text);
    return;
  }
  if (!ts.isBindingElement(node) || !node.dotDotDotToken || !ts.isIdentifier(node.name)) return;
  const owner = node.parent.parent;
  const fromEnv = ts.isVariableDeclaration(owner)
    ? owner.initializer !== undefined && isEnvLike(owner.initializer)
    : ts.isParameter(owner) && owner.type !== undefined && ENV_TYPE.test(owner.type.getText(sf));
  if (fromEnv) copies.add(node.name.text);
}

/** Lines naming `.APPLE`, `['APPLE']`, a destructured `APPLE`, or reaching it indirectly. */
export function findAppleBinding(rel: string, text: string): string[] {
  if (ALLOWED.test(rel)) return [];
  if (READ_ONLY.test(rel)) return findReadOnlyViolations(rel, text);
  return findBinding('APPLE', rel, text, CLIENT_SPECIFIER);
}

/**
 * Lines naming the service binding `name` (`.name`, `['name']`, a destructured `name`) or reaching it
 * indirectly; with `clientSpecifier`, also lines importing that client. Shared with check-idp-binding.ts.
 */
export function findBinding(
  name: string,
  rel: string,
  text: string,
  clientSpecifier?: RegExp,
): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const consts = new Map<string, string>();
  for (const stmt of sf.statements)
    if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const)
      for (const d of stmt.declarationList.declarations) {
        const v = d.initializer ? constString(d.initializer, consts) : null;
        if (ts.isIdentifier(d.name) && v !== null) consts.set(d.name.text, v);
      }
  copies.clear();
  const visit = (node: ts.Node): void => {
    trackCopy(node, sf);
    const direct =
      (ts.isPropertyAccessExpression(node) && node.name.text === name) ||
      (ts.isElementAccessExpression(node) &&
        constString(node.argumentExpression, consts) === name) ||
      (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(sf) === name);
    // Reading the env by a computed key or whole: needs a name to be safe, so only reviewed files may.
    const indirect =
      !DYNAMIC_ENV_OK.test(rel) &&
      ((ts.isElementAccessExpression(node) &&
        isEnvLike(node.expression) &&
        constString(node.argumentExpression, consts) === null) ||
        (ts.isCallExpression(node) &&
          ENUMERATORS.test(node.expression.getText(sf)) &&
          // `Object.assign(env, patch)` writes; every other argument position reads.
          node.arguments
            .slice(node.expression.getText(sf) === 'Object.assign' ? 1 : 0)
            .some(isEnvLike)));
    const hit = direct || indirect;
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    const clientImport =
      clientSpecifier && spec && ts.isStringLiteralLike(spec) && clientSpecifier.test(spec.text);
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
