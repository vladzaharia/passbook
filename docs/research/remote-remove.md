# Remote remove: what Wallet does

Researched 2026-11-04. Apple publishes no per-iOS-version behavior for these keys, so everything below is from Apple's guide plus credible third-party reports. Nothing was tested on a device for iOS 18 to 27.

## Verified

- **No API deletes a pass from a device.** The Wallet developer guide describes only the web service (register, unregister, list updated serials, fetch pass, log) and push. Wallet gives the user the controls to manage and delete passes, and the guide says an app should not remove expired passes without the user's consent.
  - Sources: [Wallet Developer Guide, Ecosystem](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/PassKit_PG/Ecosystem.html); [wallet_passes lifecycle guide](https://hex.pm/packages/wallet_passes/0.9.0/files/guides/lifecycle.md): "once a pass is added, only the user can remove it."
- **`expirationDate`** (W3C date) is evaluated by the device. After that moment Wallet shows the pass as expired and files it under Expired Passes (introduced in iOS 15). No server call is needed.
  - Sources: [wallet_passes lifecycle guide](https://hex.pm/packages/wallet_passes/0.9.0/files/guides/lifecycle.md); [Apple Community: Expired passes](https://discussions.apple.com/thread/255590367); [Dan's Tutorials: View Expired Passes](https://danstutorials.com/tutorials/tutor-for-iphone/lessons/working-with-apps-on-the-iphone-2/topics/view-expired-passes-in-the-wallet-app-2/).
- **Expired Passes and the setting.** Settings > Wallet & Apple Pay > Hide Expired Passes hides expired passes from the stack. They stay reachable at the bottom of the stack under View Expired Passes, where the user can unhide or delete them.
  - Sources: [Apple Community: unhid a pass](https://discussions.apple.com/thread/253868939); Dan's Tutorials above.
- **A pushed update reaches the device only when iOS fetches it.** A successful APNs response does not mean the device updated, and with background refresh off iOS may not poll for hours. So "removed" can only be inferred when the device fetches the new version.
  - Source: wallet_passes lifecycle guide.
- **Other issuers use the same approach**: set `voided: true` and `expirationDate` to now, push, and the pass is greyed out and demoted until the user deletes it.
  - Source: [spatie laravel-mobile-pass: expiring passes](https://spatie.be/docs/laravel-mobile-pass/v1/basic-usage/expiring-passes); [Badge: archiving vs voiding](https://help.trybadge.com/en/articles/8884412-archiving-vs-voiding-passes-what-s-the-difference).

## Not verified

- Whether `voided: true` alone, without a past `expirationDate`, moves a pass into Expired Passes. Reports describe a voided pass as greyed out and unusable; none confirm it is filed as expired. We always set both.
- Differences between iOS 18 and 27. No source documents any.
- Whether an expired pass with a changed `changeMessage` field still shows a lock-screen message. We offer the message but do not promise it appears.
- Voided and expired passes may keep scanning at a reader if the barcode stays in the pass. We strip barcodes from the final version so nothing is left to scan.
- Android and Google Wallet: out of scope.

## What the product does and says

- Remove publishes a last version: `voided: true`, `expirationDate` now, no barcodes, locations, beacons, relevant dates, featured actions or NFC, and an optional message on a back field.
- It pushes, then watches for each device to fetch that version. "Removed on 1 of 2 devices" means fetched after removal, not deleted.
- A holder deleting the pass in Wallet unregisters the device; the log shows that as Deleted by holder.
- UI copy states one limit: the pass moves to Expired passes in Wallet and the holder can delete it there. It never says the pass is deleted from the device.
