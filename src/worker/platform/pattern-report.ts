import { onUnsupportedPattern } from '../../shared/safe-pattern.ts';
import { createLogger } from './log.ts';

/** A stored template whose `pattern` RE2 cannot run still validates: the pattern is advisory, logged once. */
export function reportUnsupportedPatterns(): void {
  const log = createLogger();
  onUnsupportedPattern((pattern) =>
    log.warn('template.pattern_unsupported', {
      code: 'TEMPLATE_PATTERN_UNSUPPORTED',
      length: pattern.length,
    }),
  );
}
