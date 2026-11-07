import { lazy, type ReactNode, Suspense } from 'react';
import './scan-boot.css';

const Buddy = lazy(() => import('../../ui/art/buddy.tsx').then((m) => ({ default: m.Buddy })));

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
      className="scan-card scan-boot-card"
      data-tone={tone}
      data-testid={testId}
      aria-labelledby="scan-card-title"
    >
      <header className="scan-boot-heading">
        <div className="scan-boot-mascot" aria-hidden>
          <Suspense fallback={null}>
            <Buddy scene="peek" size="lg" mood="happy" />
          </Suspense>
        </div>
        <span className="scan-boot-eyebrow">PassBook · Scanning</span>
        <h1 id="scan-card-title" ref={titleRef} tabIndex={-1} className="scan-card-title">
          {title}
        </h1>
        {line ? <p className="scan-card-line">{line}</p> : null}
      </header>
      <div className="scan-boot-body">{children}</div>
    </section>
  );
}
