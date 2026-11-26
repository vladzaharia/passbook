---
id: pass-lifecycle
title: Pass lifecycle
line: Void, remove, delete
status: ready
ops: passes.deletePassesById
---
A pass is Active, Voided, Removed or Deleted. Three calls end it and several change it without ending it. Their names overlap; this page says which does what. Run each on a pass from your sandbox, such as the one from [issue on purchase](/developers/guides/issue-on-purchase): set `PASS_ID` to its `id`. Nothing here reaches a phone.

{{diagram lifecycle}}

## Ending a pass

| Call | Moves it to | Undo | What it does |
| --- | --- | --- | --- |
| `void` | Voided | `unvoid` | Marks the pass void and republishes it. Scans are refused. |
| `remove` | Removed | `restore` | Publishes a last version that is voided and expired, so Wallet moves it to Expired passes. The record stays. `message` shows on the lock screen. |
| `DELETE` | Deleted | none | Deletes the record and frees its `externalId`. Wallet keeps the pass on the device and sends it no more updates. |

Pick `void` to pause a pass, `remove` to take it out of a wallet and keep the record, `DELETE` only when the record itself must go. Void a pass before you delete it if its holder should see why.

Read the state from the pass:

| State | `status` | `removedAt` |
| --- | --- | --- |
| Active | `active` | `null` |
| Voided | `voided` | `null` |
| Removed | `voided` | a timestamp |
| Deleted | `404` [PASS_NOT_FOUND](/developers/errors/PASS_NOT_FOUND) | none |

A removed pass is also `voided`: `removedAt` tells the two apart. Voiding a removed pass is `409` [PASS_REMOVED](/developers/errors/PASS_REMOVED); restore it first.

## Changing a pass that stays Active

| Call | What changes | Old value |
| --- | --- | --- |
| `update` | Fields, as a new version. | Kept in the version list. |
| `refresh` | Rebuilds the pass from its connection and pushes it again. | Replaced. |
| `renew` | The pass's term. | Replaced. |
| `new-code` | The scan code. Same serial and holder. | Stops scanning. Three a pass an hour. |
| `rotate-link` | The download and public links. The pass itself is unchanged. | Stops working. |
| `bulk-reissue` | Rebuilds every pass of a template. | Replaced. |

## A pass that was replaced

An identity move (a new signing identity for an organization) issues a new pass for each holder and voids the old one 24 hours after the new one is added on the same device. The old pass carries the move's `replacedBy`: the new pass's id, in the `pass.replaced` event.

- `PATCH`, `stamps` and `renew` on the old id are forwarded to the new pass, and the answer is the new pass with an `X-Forwarded-From` header. Switch to the new id.
- A connection sync or bind of the old pass is `409` [PASS_REPLACED](/developers/errors/PASS_REPLACED); the message names the new pass.
- The `externalId` moves to the new pass in the same step, so it is never on two active passes.

## Void and undo

{{run void-pass}}

The pass answers with `status: "voided"`.

{{run unvoid-pass}}

It is `"active"` again.

## Remove and restore

{{run remove-pass}}

The pass answers with `status: "voided"` and `removedAt` set. It is in the list `GET /passes?status=removed`.

{{run restore-pass}}

`removedAt` is `null` and `status` is `"active"`.

## Replace the links

{{run rotate-link}}

The old `downloadUrl` and `publicUrl` stop working; the new ones are in the answer.

## Delete

Do this last: the pass and its id are gone.

{{run delete-pass}}

The answer is `200`. Reading the pass is now `404 PASS_NOT_FOUND`.

## Result

After each call, read the pass: `status` and `removedAt` match the state table. The `downloadUrl` preview page shows the state: void, removed or normal. A deleted pass has no page.
