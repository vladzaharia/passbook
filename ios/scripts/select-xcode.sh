#!/bin/bash
# Selects the Xcode a CI job builds with and checks it's the one expected.
#
#   ios/scripts/select-xcode.sh [--xcode /Applications/Xcode_27.1.app] [--expect 27.1] [--expect-build 27A9275]
#
#   --xcode          the Xcode app (default $PASSBOOK_XCODE, then /Applications/Xcode_27.1.app)
#   --expect         fail unless `xcodebuild -version` is Xcode <this> or a patch release of it (27.1, 27.1.1; not 27.10)
#   --expect-build   also fail unless the build is exactly this
#
# Exports DEVELOPER_DIR through $GITHUB_ENV, so every later step uses this Xcode.
set -euo pipefail

xcode="${PASSBOOK_XCODE:-/Applications/Xcode_27.1.app}"
expect="27.1"
expect_build=""

fail() { echo "select-xcode.sh: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --xcode) xcode="${2-}"; shift ;;
        --expect) expect="${2-}"; shift ;;
        --expect-build) expect_build="${2-}"; shift ;;
        *) fail "unknown option: $1" ;;
    esac
    shift
done

developer_dir="$xcode/Contents/Developer"
if [[ ! -d "$developer_dir" ]]; then
    echo "Installed Xcodes:" >&2
    ls -d /Applications/Xcode*.app >&2 || true
    fail "$xcode isn't installed on this runner."
fi
export DEVELOPER_DIR="$developer_dir"
if [[ -n "${GITHUB_ENV:-}" ]]; then echo "DEVELOPER_DIR=$developer_dir" >> "$GITHUB_ENV"; fi

version="$(xcodebuild -version)"
echo "$version"
first="${version%%$'\n'*}"
[[ "$first" == "Xcode $expect" || "$first" == "Xcode $expect."* ]] || fail "expected Xcode $expect at $xcode, found $first"
build="$(sed -n 's/^Build version //p' <<< "$version")"
if [[ -n "$expect_build" && "$build" != "$expect_build" ]]; then
    fail "$first at $xcode is build $build, not $expect_build. The runner image changed: set the PASSBOOK_RELEASE_XCODE_BUILD repository variable (ios/README.md, TestFlight)."
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then echo "- $first ($build) at \`$xcode\`" >> "$GITHUB_STEP_SUMMARY"; fi
