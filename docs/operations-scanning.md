# Scanning

## Set up a device

1. Open **Scanning → New scanner** in the admin panel.
2. Choose the organization, accepted passes or event, and **Scanner** view.
3. Choose camera input (**Reader: None**) or a hardware barcode reader.
4. Create the setup and enter its pairing code at `/scan` or in PassBook Reader.

Each device has its own pairing code. Pairing again replaces that device's credential.
Changes to a scanner's settings apply at its next session refresh or between scans.

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

## Use an admin session

At `/scan`, choose **Scan as Admin** beneath the pairing form. Select an organization and start
the session. PassBook creates or reuses that user's managed setup for the organization and mode.
Edit it in **Scanning** like any other setup. Admin sessions use platform sign-in and do not
issue pairing credentials. The setup list shows the owner and hides pairing actions.

## Add customer screens and desk monitors

Create a setup with **Customer screen** or **Desk monitor** view, choose the scanners it follows,
then pair the screen with its own code. Multiple screens can follow the same scanners; each screen
can follow up to eight scanners. A desk monitor may follow the entire organization.

Customer screens show a short, generic verdict for a physically presented barcode. They show
no member names or photos, never display manual lookup results, and return to Ready after the
result expires. Reconnecting does not replay a previous customer's result.

Desk monitors show recent scans and permitted member photos. Both screen views are read-only.
Revoking or reconfiguring a screen clears its feed and reconnects it through current authorization.
Live history is limited to 100 results and 15 minutes, isolated by organization and mode.

## Add a member photo

Open **Pass → Holder → Member photo**. Choose an image smaller than 10 MB. The browser centre-crops
it to a 270-pixel square; the server removes ancillary image metadata before storage.

The photo appears in authorized scanner results and desk monitors. **Show member photos** on a
scanner can hide it. Template photo role restrictions still apply. Customer screens never get it.

Photos stay out of Wallet by default. Enable **Include photo in Wallet pass** to publish it as the
thumbnail. Generic passes and event tickets without a strip image support this option. Disabling
it restores the pass's previous thumbnail. Removing the photo removes it from scanners and Wallet.

Wallet inclusion rebuilds and signs the pass through the normal update pipeline. If rebuilding
fails, the previous photo settings remain in place.

## Android

Use the signed [PassBook Reader APK](https://github.com/vladzaharia/passbook/releases/tag/android-v0.2.2).
The same web verifier supplies the policies, photos and display views; reload the verifier to
receive updates. Camera access needs HTTPS and Android camera permission. Hardware barcode
configuration and physical-device acceptance checks are in [android/README.md](../android/README.md).
