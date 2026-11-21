import type { ReactNode } from 'react';

/** Text from the spec with `code` spans, as React nodes (escaped by React, never raw HTML). */
export function Prose({ text }: { text: string }): ReactNode {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a static split of one string
      <code key={i} className="inline-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
