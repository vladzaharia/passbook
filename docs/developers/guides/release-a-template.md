---
id: release-a-template
title: Release a template
line: Try, review, release
status: ready
ops: templates.postTemplatesByIdRelease
---
Take a saved template version from a draft to your holders. One call, `POST /templates/{id}/release`, releases a version to Test and Live; a second asks a teammate to review it first. In a sandbox only Test runs, so nothing here reaches a holder.

## Pick a key

A release needs `templates:publish`, asking for review `templates:write`, and approving `templates:review`. A Test key reaches only Test.

{{run current-key}}

`scopes` lists what the key may do; `mode` is `test` in a sandbox.

## How a version moves

A saved version is a draft. Test follows Live, and may run one version ahead.

- Try puts the draft in Test only. Test is then ahead of Live.
- Release puts it in Test and then Live. A newer Test head is kept, and the answer says `kept`.
- A team asks for review first. Another reviewer approves, and the version is released.

The answer's `state` says what comes next in `next`: `try`, `release`, `request_review`, `review`, `wait`, or `null` when nothing is newer than Live.

## Preview a release

`?dryRun=true` writes nothing. It answers the plan for each mode, the passes and devices a release would update, and the changes grouped as colors, front, back, images and barcode. It needs no Idempotency-Key.

{{show release-dry-run}}

`approval.action` is `needed` when Live has no approval you can write. Then the real call is 409 `TEMPLATE_REVIEW_REQUIRED` with this plan.

## Try a version in Test

Send `modes: ["test"]` and an Idempotency-Key. A Test key may name only `test`. Then make a Test pass from the template's `sample` and read `GET /passes/{id}/devices` until a device is listed.

{{show release-try}}

The second call replays the first: same key, same body, same answer, one release. The same key with another body is 409 `IDEMPOTENCY_KEY_REUSED`. A repeat while the first still runs is 409 `IDEMPOTENCY_IN_PROGRESS`.

## Release

Leave `modes` out for both. Test runs first, then Live. Send `expected` with the generation each head must still be at, `0` before its first release, so a release that raced another is refused instead of overwriting it.

```json
{ "version": "4", "expected": { "live": 2, "test": 3 } }
```

Alone in the org, you approve your own work: Live gets a `sole` approval. Otherwise the answer is 409 `TEMPLATE_REVIEW_REQUIRED`. Test stays released, and a repeat after the review resumes where it stopped.

## Ask for a review

{{show request-review}}

This makes the Test and Live candidates and emails the other reviewers. A newer request replaces an older open one. A Live key with `templates:write` may ask; approval and release stay with people.

## Approve and release

The reviewer lists what waits on them, then approves. Set `release` to release in the same call when they can publish. You cannot approve your own version.

{{show approve-review}}

`approved` lists the modes approved. `release` carries the result when it was set.

## Result

A version released to Test and Live shows the same `version` as both heads in `state`. Replaying the call with its key changes nothing.
