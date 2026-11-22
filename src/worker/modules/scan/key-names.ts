/** An API key gets ids, not the names of staff or the admin who owns a setup. */
export function withoutNames<
  T extends {
    staff: { id: string; name: string | null } | null;
    adminUser?: { id: string; name: string | null } | null;
  },
>(view: T): T {
  return {
    ...view,
    staff: view.staff && { ...view.staff, name: null },
    ...(view.adminUser === undefined
      ? {}
      : { adminUser: view.adminUser && { ...view.adminUser, name: null } }),
  };
}
