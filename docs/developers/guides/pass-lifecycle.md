---
id: pass-lifecycle
title: Pass lifecycle
line: Void, remove, delete
status: ready
ops: passes.deletePassesById
---
A pass is Active, Voided, Removed or Deleted. Three calls end it and several change it without ending it. Their names overlap; this page says which does what. Run each on a pass from your sandbox: nothing here reaches a phone.

{{diagram lifecycle}}

## Ending a pass

| Call | Moves it to | Undo | What it does |
| --- | --- | --- | --- |
| `void` | Voided | `unvoid` | Marks the pass void and republishes it. Scans are refused. |
| `remove` | Removed | `restore` | Publishes a last version that is voided and expired, so Wallet moves it to Expired passes. The record stays. `message` shows on the lock screen. |
| `DELETE` | Deleted | none | Deletes the record and frees its `externalId`. Wallet keeps the pass on the device and sends it no more updates. |

Pick `void` to pause a pass, `remove` to take it out of a wallet and keep the record, `DELETE` only when the record itself must go. Void a pass before you delete it if its holder should see why.

## Changing a pass that stays Active

| Call | What changes | Old value |
| --- | --- | --- |
| `update` | Fields, as a new version. | Kept in the version list. |
| `refresh` | Rebuilds the pass from its connection and pushes it again. | Replaced. |
| `renew` | The pass's term. | Replaced. |
| `new-code` | The scan code. Same serial and holder. | Stops scanning. Three a pass an hour. |
| `rotate-link` | The download and public links. The pass itself is unchanged. | Stops working. |
| `bulk-reissue` | Rebuilds every pass of a template. | Replaced. |

Email has two names for two things: `resend-email` sends a pass's email, `send-email` sends a bundle's.

## Void and undo

{{run void-pass}}

{{run unvoid-pass}}

The pass answers with `status: "voided"`, then `"active"`. Paste the pass `id` into the path.

## Remove and restore

{{run remove-pass}}

Undo it with [restore](console:passes.postPassesByIdRestore).

## Replace the links

{{run rotate-link}}

The old `downloadUrl` and `publicUrl` stop working; the new ones are in the answer.

## Result

After each call, open the pass's `downloadUrl`. The preview page shows the state: void, removed or normal. A deleted pass has no page.
