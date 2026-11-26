export interface ScimPushInput {
  /** `deactivate` pushes `active: false`; `delete` removes the user, as Polaris ID does when the owner deletes one. */
  op: 'create' | 'deactivate' | 'delete';
  sub: string;
}

interface Target {
  appOrigin: string;
  scimToken: string;
}

const HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/scim+json',
});

/** Polaris ID's SCIM push to the main Worker's receiver (`/scim/v2`): what the owner's edits look like to PassBook. */
export async function scimPush(target: Target, input: ScimPushInput): Promise<{ status: number }> {
  const base = `${target.appOrigin}/scim/v2/Users`;
  if (input.op === 'delete') {
    const list = await fetch(`${base}?count=1000`, { headers: HEADERS(target.scimToken) });
    const found = (await list.json().catch(() => null)) as {
      Resources?: { id: string; externalId: string }[];
    } | null;
    const id = found?.Resources?.find((u) => u.externalId === input.sub)?.id;
    if (!id) return { status: 404 };
    const res = await fetch(`${base}/${id}`, {
      method: 'DELETE',
      headers: HEADERS(target.scimToken),
    });
    return { status: res.status };
  }
  // A POST makes the user or updates the mirror, as Polaris ID's push does for a changed account.
  const res = await fetch(base, {
    method: 'POST',
    headers: HEADERS(target.scimToken),
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      externalId: input.sub,
      userName: input.sub,
      active: input.op !== 'deactivate',
    }),
  });
  return { status: res.status };
}
