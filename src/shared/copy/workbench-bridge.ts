/** The admin side of the Workbench bridge (design §2.4). The Workbench is Test only. */
export const BRIDGE_COPY = {
  open: 'Open in Workbench',
  /** The sidebar entry; its name says what it opens. */
  entry: 'Workbench',
  entryName: 'Workbench, opens Test',
  test: 'Test',
  opensTest: 'Opens Test',
  back: 'Back to Workbench',
  quiet: 'Workbench',
  group: 'Workbench',
  /** Spoken when admin adopts Test from a launch link. */
  adopted: 'Test mode on.',
} as const;
