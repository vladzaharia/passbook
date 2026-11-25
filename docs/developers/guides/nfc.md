---
id: nfc
title: NFC
line: Tags and bindings
status: preview
---
> Preview. NFC is off until Apple approves it. You can define tag types now; a tag cannot be bound or tapped yet.

A tag type says how a kind of tag behaves: who it is for, how many a pass may hold, and whether staff confirm a tap. Passes bind to tags of a type once NFC opens.

## Create a tag type

`use` is `member`, `staff` or `visitor`. `perPass` is how many tags one pass may bind. `confirm` is who confirms a tap: `none`, `staff` or `manager`.

```json run=nfc-tags.postNfcTagTypes
{
  "name": "Member wristband",
  "use": "member",
  "perPass": 1,
  "confirm": "none"
}
```

## List your tag types

[List them](console:nfc-tags.getNfcTagTypes). The new type is there with its settings. Keep its `id` and `version`.

## Change or archive one

Use the tag type `id` in the path. Send the `version` the list shows, 1 on a new type: a stale version is refused. Each change raises it by one.

```json run=nfc-tags.patchNfcTagTypesById
{ "version": 1, "name": "Member wristband (blue)", "perPass": 2 }
```

Archive stops new bindings and keeps the history. Send the new `version`, 2.

```json run=nfc-tags.postNfcTagTypesByIdArchive
{ "version": 2 }
```

## Result

The list shows the tag type as you set it, with `archivedAt` set after the archive. Binding and tap calls are not part of the API yet, so there is nothing to scan: this guide ends at the definition. The [changelog](/developers/changelog) says when NFC opens.
