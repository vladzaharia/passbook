// Which error codes each route can reach: from its `register(...)` handler, through the functions it calls
// (the TypeScript call graph under src/worker), to the `new XError(...)` sites. Written to
// docs/api/operation-codes.json by `npm run gen`; platform/openapi-codes.ts reads it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../..');
const WORKER = `${resolve(root, 'src/worker')}/`;
const CODE = /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g;

/** The key `register` writes on the operation (`x-route`) and this table is keyed by. */
export const routeKey = (tag: string, method: string, path: string): string =>
  `${tag} ${method.toLowerCase()} ${path}`;

function program(): ts.Program {
  const file = resolve(root, 'tsconfig.worker.json');
  const cfg = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (!cfg) throw new Error('tsconfig.worker.json did not parse');
  const names = cfg.fileNames.filter((f) => f.startsWith(WORKER) && !/\.test\.tsx?$/.test(f));
  return ts.createProgram(names, { ...cfg.options, noEmit: true });
}

const strOf = (n: ts.Node | undefined): string | undefined =>
  n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** Codes written in a piece of source: the literal codes of `new XError(...)` calls, class defaults, `codes: { reason: 'X' }`. */
export function codesIn(node: ts.Node, defaults: (cls: ts.Expression) => string[]): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && /Error$/.test(n.expression.getText())) {
      const found = [
        ...(n.arguments ?? [])
          .map((a) => a.getText())
          .join(',')
          .matchAll(CODE),
      ];
      if (found.length) for (const m of found) out.add(m[1] as string);
      else for (const c of defaults(n.expression)) out.add(c);
    }
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText() === 'codes' &&
      ts.isObjectLiteralExpression(n.initializer)
    )
      for (const m of n.initializer.getText().matchAll(/\w+:\s*'([A-Z][A-Z0-9_]+)'/g))
        out.add(m[1] as string);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...out];
}

/** Route key to codes, for every `register` call with literal tag, method and path. */
export function buildOpCodes(known: ReadonlySet<string>): Record<string, string[]> {
  const prog = program();
  const checker = prog.getTypeChecker();
  const cache = new Map<ts.Node, Set<string>>();

  const classDefault = (expr: ts.Expression): string[] => {
    const sym = checker.getSymbolAtLocation(expr);
    const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const decl = target?.declarations?.find(ts.isClassDeclaration);
    const m = decl ? /code = '([A-Z][A-Z0-9_]+)'/.exec(decl.getText()) : null;
    return m ? [m[1] as string] : [];
  };

  /** The string values an expression can have: a literal, a const, or a union of literals (a loop over a tuple of paths). */
  const literals = (n: ts.Expression | undefined): string[] => {
    if (!n) return [];
    const direct = strOf(n);
    if (direct !== undefined) return [direct];
    const t = checker.getTypeAtLocation(n);
    return (t.isUnion() ? t.types : [t]).flatMap((x) => (x.isStringLiteral() ? [x.value] : []));
  };

  const fnBody = (d: ts.Node): ts.Node[] => {
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d.body ? [d.body] : [];
    if (
      ts.isVariableDeclaration(d) &&
      d.initializer &&
      (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
    )
      return [d.initializer];
    if (
      ts.isPropertyAssignment(d) &&
      (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
    )
      return [d.initializer];
    return [];
  };

  /** Declarations in src/worker an identifier or call points at, with a body worth walking. */
  const bodies = (n: ts.Node): ts.Node[] => {
    const sym = checker.getSymbolAtLocation(n);
    if (!sym) return [];
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const own = (target.declarations ?? []).flatMap((d): ts.Node[] =>
      d.getSourceFile().fileName.startsWith(WORKER) ? fnBody(d) : [],
    );
    if (own.length || !ts.isIdentifier(n)) return own;
    // A function passed in (a parameter): every function its type admits.
    const t = checker.getTypeAtLocation(n);
    return (t.isUnion() ? t.types : [t]).flatMap((x) =>
      (x.symbol?.declarations ?? []).flatMap((d) =>
        d.getSourceFile().fileName.startsWith(WORKER) ? fnBody(d) : [],
      ),
    );
  };

  const reach = (start: ts.Node): Set<string> => {
    const seen = new Set<ts.Node>();
    const out = new Set<string>();
    const stack: ts.Node[] = [start];
    while (stack.length) {
      const node = stack.pop() as ts.Node;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const c of codesIn(node, classDefault)) out.add(c);
      // A function tagged `@absorbs` catches what it calls and throws its own code: the callees' codes stop here.
      const owner = node.parent;
      if (owner && ts.getJSDocTags(owner).some((t) => t.tagName.text === 'absorbs')) continue;
      const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n))
          for (const b of bodies(ts.isPropertyAccessExpression(n) ? n.name : n)) stack.push(b);
        ts.forEachChild(n, walk);
      };
      walk(node);
    }
    return out;
  };

  const table = new Map<string, Set<string>>();
  for (const sf of prog.getSourceFiles()) {
    if (!sf.fileName.startsWith(WORKER)) continue;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText() === 'register' &&
        n.arguments.length >= 4
      ) {
        const [, tagArg, spec, handler] = n.arguments as unknown as [
          ts.Expression,
          ts.Expression,
          ts.Expression,
          ts.Expression,
        ];
        if (ts.isObjectLiteralExpression(spec) && handler) {
          const codes = cache.get(handler) ?? reach(handler);
          cache.set(handler, codes);
          const extra = prop(spec, 'codes');
          for (const tag of literals(tagArg))
            for (const method of literals(prop(spec, 'method')))
              for (const path of literals(prop(spec, 'path'))) {
                const key = routeKey(tag, method, path);
                const set = table.get(key) ?? new Set<string>();
                for (const c of codes) set.add(c);
                if (extra) for (const m of extra.getText().matchAll(CODE)) set.add(m[1] as string);
                table.set(key, set);
              }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return Object.fromEntries(
    [...table.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, [...v].filter((c) => known.has(c)).sort()]),
  );
}

export const opCodesFile = (known: ReadonlySet<string>): string =>
  `${JSON.stringify(buildOpCodes(known), null, 2)}\n`;

/** Codes the catalog lists with a client-facing status: an internal 500 is not part of an operation's contract. */
export const knownCodes = (): Set<string> =>
  new Set(
    (
      JSON.parse(readFileSync(resolve(root, 'docs/api/errors.json'), 'utf8')) as {
        codes: { code: string; statuses: number[] }[];
      }
    ).codes
      .filter((c) => c.statuses.some((s) => s < 500))
      .map((c) => c.code),
  );
