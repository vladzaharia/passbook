import { Fragment, type ReactNode } from 'react';

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** Guide text allows only **bold** and `code`; everything else is plain text. */
export function Rich({ text }: { text: string }): ReactNode {
  return text.split(TOKEN).map((part, i) => {
    const key = `${i}-${part}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return (
        <strong key={key} className="font-semibold text-fg-strong">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <code key={key} className="rounded-sm bg-surface-sunken px-1 font-mono text-[0.8125em]">
          {part.slice(1, -1)}
        </code>
      );
    return <Fragment key={key}>{part}</Fragment>;
  });
}
