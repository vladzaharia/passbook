/** A pass type's own check-in rules. A pass's rules override them; a scanner's cap tightens them. */
export interface ScanCheckIn {
  mode?: 'single' | 'daily' | 'unlimited';
  /** Ends at local midnight after this many days (1 = tonight), from the first scan unless `durationFrom` says issued. */
  days?: number;
  durationMinutes?: number;
  durationFrom?: 'first_scan' | 'issued';
}
