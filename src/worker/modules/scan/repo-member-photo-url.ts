import type { OutputPredicate } from './repo-output-predicates.ts';

export function photoUrlTemplateScopePredicate(
  templateFence: OutputPredicate,
): OutputPredicate | null {
  if (templateFence.sql === '0') return null;
  return {
    sql: `EXISTS (SELECT 1 FROM passes scope WHERE scope.id=p.id AND (${templateFence.sql}))`,
    params: templateFence.params,
  };
}
