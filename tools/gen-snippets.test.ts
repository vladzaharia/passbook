import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { drift, generate, OUT } from './gen-snippets.ts';

const root = resolve(import.meta.dirname, '..');

describe('snippets', () => {
  it('match what the generator writes, so a changed contract or sample cannot leave one stale', () => {
    expect(drift(generate(root), resolve(root, OUT))).toEqual([]);
  });

  it('typecheck against the SDK: the generated and the hand-written TypeScript', () => {
    const file = resolve(root, 'docs/developers/snippets/tsconfig.json');
    const config = ts.getParsedCommandLineOfConfigFile(
      file,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        },
      },
    );
    if (!config) throw new Error('docs/developers/snippets/tsconfig.json did not load');
    expect(config.fileNames.length).toBeGreaterThan(150);
    const program = ts.createProgram(config.fileNames, config.options);
    const errors = ts.getPreEmitDiagnostics(program).map((d) => {
      const at = d.file?.fileName.replace(`${root}/`, '') ?? '';
      return `${at}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
    expect(errors).toEqual([]);
  }, 90_000);
});
