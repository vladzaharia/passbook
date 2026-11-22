/**
 * Whether the device may read `tag-enrollments/pending`. The route is Desk and up with assigning
 * not off (`tagRights`), so a door or a scanner with tags off asks nothing and gets no 403.
 */
export function canReadEnrollments(o: {
  device: boolean;
  reading: boolean;
  role: string;
  assign: string;
}): boolean {
  return o.device && o.reading && o.role !== 'door' && o.assign !== 'never';
}
