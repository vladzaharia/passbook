# Scanning sessions

A session owns accepted passes, admission policy, time zone, staff requirements and device defaults.
A device belongs to one session. Pairing adds a device; Scan as Admin adds or reuses this browser’s
administrator device in the selected session. Administrator sign-in does not select a layout.

Layouts work on phones, tablets and computers:

- **Scanner**: camera, barcode reader, taps and code entry.
- **Operator**: camera-free lookup, actions and recent session activity; stacked on a phone.
- **Desk display**: read-only staff activity and permitted member photos.
- **Customer display**: temporary generic verdicts, without names, photos or pass details.

Automatic suggests Operator on wide screens and Scanner on smaller screens. Admins can select any
responsive layout. Devices report viewport, touch, keyboard, camera availability and Android reader
support without prompting for camera permission. These reports never grant authorization.

Device overrides cover input flow, reader, entry/exit direction, people lookup and photos.
Admission, pass scope and staff rights remain shared. Session defaults apply wherever no device
override is present. Rules are re-read on every request; displays revalidate their credentials and
session membership before delivery. Configuration refresh waits until a scan or review finishes
and preserves the started state. Pausing or ending a session blocks new check-ins immediately.

Names and emails open a read-only preview followed by an explicit action. Codes and IDs submitted
with Enter follow the configured scan flow, including Bluetooth/USB keyboard readers and Android
barcode events. Customer displays follow presented codes and taps rather than people lookups.

Camera decoding examines the whole frame on every processed frame. The aiming marks are guidance;
they do not crop the image. The preview contains the whole camera image. Linear codes retain the
existing consecutive-read check against partial stripe reads.

Migration `0024_scanning_sessions.sql` creates one standalone session for each existing scanner,
preserving credentials, accepted passes, modes and explicit legacy display watches. Existing
scanners keep their Scanner layout. Shared sessions use automatic watches across their own devices.
Device membership is fixed so scan history cannot be reassigned to another session.
