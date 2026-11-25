/** What the create confirmation says about the key about to be made. */
export function KeyReview({
  orgId,
  orgName,
  mode,
  name,
  personal,
  permissions,
  ipAllow,
  days,
}: {
  orgId: string | null;
  orgName: string;
  mode: string;
  name: string;
  personal: boolean;
  permissions: string;
  ipAllow: readonly string[];
  days: string;
}) {
  const modeName = mode === 'test' ? 'Test' : 'Live';
  return (
    <span className="block">
      <span className="block">
        {orgId === null ? (
          <>This key can access all organizations in {modeName} mode.</>
        ) : (
          <>
            This key is bound to {orgName} in {modeName} mode.
          </>
        )}
      </span>
      <span className="mt-3 block">Name: {name}</span>
      <span className="block">
        {personal && orgId !== null ? 'Type: personal, acts as you.' : null}
      </span>
      <span className="block">Permissions: {permissions}</span>
      {ipAllow.length ? <span className="block">Allowed IPs: {ipAllow.join(', ')}</span> : null}
      <span className="block">
        {days === 'never'
          ? 'It will not expire.'
          : `It expires after ${days === '365' ? '1 year' : `${days} days`}.`}
      </span>
      <span className="mt-3 block">
        No secret has been issued yet. It will be shown once after creation.
      </span>
    </span>
  );
}
