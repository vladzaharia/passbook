/** Before the first Run: a line, and while a call is out, bars where the response will be. */
export function ResponseEmpty({ pending = false }: { pending?: boolean }) {
  if (pending)
    return (
      <div className="bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  return <p className="muted sm resp-hint">Run the request to see the response here.</p>;
}
