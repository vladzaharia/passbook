# Scanning

## Set up a device

1. Open **Scanning → New scanning session**.
2. Choose the organization, accepted passes, time zone and admission rules.
3. Choose **Add device**, then select **Scanner**, **Operator** or **Customer display**. All three views
   are available on every screen size; **Automatic** chooses Scanner on smaller screens and Operator
   on wide screens.
4. Create a pairing code and enter it at `/scan` or in PassBook Reader.

Session devices share admission rules and can use per-device input overrides. Each device has its own
pairing code. Pairing again replaces that device's credential.

## Choose check-in rules

Open **Pass → Holder → Check-in rules** for one pass, or edit a scanner's settings.

- **One scan; no check-out:** one accepted entry. Another entry is refused until the entry is undone.
- **Once per day:** one entry per local calendar day, using the scanner or event time zone.
- **Unlimited scans:** every valid check-in is accepted.
- **Track in / out:** shared entry state across scanners, with entry, exit and re-entry records.
- **Event restriction:** bind a pass to an event; another event cannot accept it.
- **Valid from / until:** admission dates, independent of the reader's clock.
- **Duration:** minutes from pass issue or its first successful scan.

A scanner's type supplies the default when the pass has no explicit type. When both have
explicit rules, limits apply together. A scanner cannot weaken an explicit single-use pass.
Daily limits can combine with in/out tracking: an exit is allowed, followed by another entry
only after the next local day begins.

Entry-only and exit-only setups fix the direction. **Entry and exit** chooses the next transition
from the shared state. Expired admission windows still permit a recorded in/out member to leave.
An event with **Allow re-entry** off permits one entry and its exit.

Changes to admission rules take effect immediately. Undo is audited and restores the previous
entry state; it cannot undo a transition superseded by a newer scan.

## Scan or look up a pass

**Look up** accepts a full barcode, ID, name prefix or full email address. Enter a code or ID
and press Enter (or **Find pass**). It follows the scanner's **On scan, tap or entered code**
setting: automatic check-in by default, or review before check-in. Hardware keyboard scans use
the same setting. Looking up a person by name or email never checks them in until **Check in**
is pressed. Turning off people lookup still permits code entry.

Names need at least three letters; email addresses must be complete. Exact pass IDs, serials,
external IDs, barcode contents and configured lookup IDs can be searched without appearing in
the pass's title or subtitle. Search remains limited to the scanner's organization, mode and
accepted passes. Short IDs match exactly; they do not enable short name searches.

To use a separate membership or ticket number, add a text input in the template designer and
select it under **Barcode → Lookup ID**. It needs no visible field or barcode binding. The QR
can continue to contain different data. Use text for IDs with leading zeros. Save and activate
the template, then issue or reissue passes with that input populated. Existing passes gain the
identifier when rebuilt against that version. Lookup IDs are normalized for case, spaces,
hyphens, dots and slashes; keep them unique within the accepted passes. Duplicate matches
require selecting a person and are never automatically admitted.

## Bluetooth and USB scanners

Pair a Bluetooth scanner in the device's operating system using **HID / keyboard** mode, or
connect a USB keyboard scanner. Configure a US keyboard layout and Enter suffix. In a browser,
start the scanner session and scan with focus on the page or in **Look up**. Avoid typing into
other controls. HID input works independently of the camera reader setting.

In the Android APK, focus **Scan barcode here** and scan. The native field forwards the exact
text, including leading zeros, to the same verifier. Android integrated scanners can also use
their documented broadcast configuration. Serial/SPP and proprietary BLE modes need a
model-specific adapter; select HID mode when the scanner supports it.

## Use an admin session

At `/scan`, choose **Scan as Admin** beneath the pairing form. Select an organization and session,
then join. PassBook creates or reuses that user's managed device. Admin devices use platform
sign-in and do not issue pairing credentials; their layout can be changed in the session.

## Add customer displays and operators

In a session, choose **Add device** and select **Customer display** or **Operator**. Customer displays
show a short, generic verdict for a presented code, without member names or photos. They do not show
manual lookups and return to Ready after the result expires.

Operator combines code scanning, pass lookup and session activity. Staff can review or check in from
the same view. Previously enrolled standalone Desk monitors remain read-only; new session devices use
Operator for staff activity and actions.

## Add a member photo

Open **Pass → Holder → Member photo**. Choose an image smaller than 10 MB. The browser centre-crops
it to a 270-pixel square; the server removes ancillary image metadata before storage.

Photos appear in authorized Scanner and Operator views and on legacy standalone Desk monitors.
**Show member photos** can hide them. Template photo role restrictions still apply; Customer displays
never receive photos.

Photos stay out of Wallet by default. Enable **Include photo in Wallet pass** to publish it as the
thumbnail. Generic passes and event tickets without a strip image support this option. Disabling
it restores the pass's previous thumbnail. Removing the photo removes it from scanners and Wallet.

Wallet inclusion rebuilds and signs the pass through the normal update pipeline. If rebuilding
fails, the previous photo settings remain in place.

## Android

Use the signed [PassBook Reader APK](https://github.com/vladzaharia/passbook/releases/tag/android-v0.2.3).
The same web verifier supplies the policies, photos and display views; reload the verifier to
receive updates. Camera access needs HTTPS and Android camera permission. Hardware barcode
configuration and physical-device acceptance checks are in [android/README.md](../android/README.md).
