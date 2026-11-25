---
id: release-a-template
title: Release a template
line: Try, review, release
status: ready
ops: templates.postTemplatesByIdRelease
---
Take a saved template version from a draft to your holders. One call, `POST /templates/{id}/release`, releases a version to Test and Live; a second asks a teammate to review it first. In a sandbox only Test runs, so nothing here reaches a holder.

## Before you release

A release needs `templates:publish`, asking for review `templates:write`, and approving `templates:review`. A Test key reaches only Test.

{{run current-key}}

`scopes` lists what the key may do; `mode` is `test` in a sandbox.

A saved version is a draft. Test follows Live, and may run one version ahead.

- Try puts the draft in Test only. Test is then ahead of Live.
- Release puts it in Test and then Live. A newer Test head is kept, and the answer says `kept`.
- A team asks for review first. Another reviewer approves, and the version is released.

The answer's `state` says what comes next in `next`: `try`, `release`, `request_review`, `review`, `wait`, or `null` when nothing is newer than Live.

## Make a draft

A new sandbox has no draft: its template is already released. Copy a blueprint to get one, a template with a saved version and nothing released. Keep the answer's `id` and the `version` in `versions`. In a shell, `export TEMPLATE_ID=<id>`, and put the version in the bodies below.

{{show release-draft}}

> Sandbox: saving your own edit as a version needs a session, not a key. Save it in the designer (Templates, Designer, Save version) and use that version below.

## Preview a release

`?dryRun=true` writes nothing. It answers the plan for each mode, the passes and devices a release would update, and the changes grouped as colors, front, back, images and barcode. It needs no Idempotency-Key.

{{show release-dry-run}}

`approval.action` is `needed` when Live has no approval you can write. Then the real call is `409` [TEMPLATE_REVIEW_REQUIRED](/developers/errors/TEMPLATE_REVIEW_REQUIRED) with this plan.

## Try a version in Test

Send `modes: ["test"]` and an Idempotency-Key. A Test key may name only `test`.

{{show release-try}}

The second call replays the first: same key, same body, same answer, one release. The same key with another body is `422` [IDEMPOTENCY_KEY_REUSED](/developers/errors/IDEMPOTENCY_KEY_REUSED). A repeat while the first still runs is `409` [IDEMPOTENCY_IN_PROGRESS](/developers/errors/IDEMPOTENCY_IN_PROGRESS).

## Release to Live

Leave `modes` out for both. Test runs first, then Live. Send `expected` with the generation each head must still be at, `0` before its first release, so a release that raced another is refused instead of overwriting it.

```json
{ "version": "<version>", "expected": { "live": 2, "test": 3 } }
```

Alone in the org, you approve your own work: Live gets a `sole` approval. Otherwise the answer is `409` `TEMPLATE_REVIEW_REQUIRED`. Test stays released, and a repeat after the review resumes where it stopped. A sandbox has no Live: skip this step.

## Ask for a review

`POST /templates/{id}/review-requests` needs an Idempotency-Key. It makes the Test and Live candidates and emails the other reviewers. A newer request replaces an older open one. A Live key with `templates:write` may ask; approval and release stay with people.

{{show request-review}}

> Sandbox: you are the only member, so no review opens and `state.review.state` stays `none`. Ask in an organization with a teammate.

## Approve and release

The reviewer lists what waits on them, then approves. Set `release` to release in the same call when they can publish. You cannot approve your own version. With no review requested, the call is `404` [TEMPLATE_REVIEW_NOT_FOUND](/developers/errors/TEMPLATE_REVIEW_NOT_FOUND).

{{show approve-review}}

`approved` lists the modes approved. `release` carries the result when it was set. In a sandbox the inbox is empty.

## Result

The Test call answers `modes.test.outcome` `released`, and `current` on the repeat. `state.test.version` is your version, `state.test.state` is `ahead` and `state.live` is `null`: Test is ahead of Live. In an organization, a version released to Test and Live shows the same `version` as both heads.
