import type { ReactNode } from 'react';

/** A boot or blocking card on the card layer: the h1, an optional line, then the body. */
export function BootCard({
  title,
  line,
  tone,
  children,
  testId,
  titleRef,
}: {
  title: ReactNode;
  line?: ReactNode;
  tone?: 'slate';
  children?: ReactNode;
  testId?: string;
  titleRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <section
      className="scan-card"
      data-tone={tone}
      data-testid={testId}
      aria-labelledby="scan-card-title"
    >
      <h1 id="scan-card-title" ref={titleRef} tabIndex={-1} className="scan-card-title">
        {title}
      </h1>
      {line ? <p className="scan-card-line">{line}</p> : null}
      {children}
    </section>
  );
}
