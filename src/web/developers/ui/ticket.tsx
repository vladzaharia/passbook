import type { ReactNode } from 'react';

/** The request is the stub, the response the body, joined by a dashed tear (CSS mask, no images). */
export function Ticket({
  stub,
  body,
  buddy,
}: {
  stub: ReactNode;
  body: ReactNode;
  buddy?: ReactNode;
}) {
  return (
    <div className="ticket">
      {buddy}
      <div className="stub">{stub}</div>
      <div className="body">{body}</div>
    </div>
  );
}
