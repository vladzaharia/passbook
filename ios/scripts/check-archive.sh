#!/bin/bash
# Checks the scanner archive before it's exported and uploaded, so a build never stalls or bounces in App Store
# Connect for something visible in the archive.
#
#   ios/scripts/check-archive.sh <PassBookScanner.xcarchive> [--version X.Y.Z] [--build N]
#
# Fails when the app's Info.plist lacks ITSAppUsesNonExemptEncryption = false (TestFlight would hold every build at
# "Missing Compliance"), has no app icon, has another bundle ID than mobile.passbook.scanner, or has a version or
# build number other than --version / --build; and, for a signed archive, when the NFC tag-reading entitlement is
# missing.
set -euo pipefail

archive=""
version=""
build=""
failures=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) version="${2-}"; shift ;;
        --build) build="${2-}"; shift ;;
        -*) echo "check-archive.sh: unknown option: $1" >&2; exit 2 ;;
        *) archive="$1" ;;
    esac
    shift
done
[[ -d "$archive" ]] || { echo "usage: $0 <PassBookScanner.xcarchive> [--version X.Y.Z] [--build N]" >&2; exit 2; }

problem() { echo "check-archive.sh: $*" >&2; failures=$(( failures + 1 )); }
ok() { echo "ok: $*"; }
plist_value() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }

app="$(find "$archive/Products/Applications" -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$app" ]] || { echo "check-archive.sh: no app in $archive/Products/Applications" >&2; exit 1; }
info="$app/Info.plist"

if [[ "$(plutil -type ITSAppUsesNonExemptEncryption "$info" 2>/dev/null || true)" == bool \
    && "$(plist_value "$info" ITSAppUsesNonExemptEncryption)" == false ]]; then
    ok "ITSAppUsesNonExemptEncryption = false"
else
    problem "Info.plist doesn't set ITSAppUsesNonExemptEncryption to the boolean false (HTTPS only), so TestFlight would hold the build for the export compliance question."
fi

if [[ -n "$(plutil -type CFBundleIcons "$info" 2>/dev/null || true)" ]]; then
    ok "app icon: $(plist_value "$info" CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName)"
else
    problem "the app has no app icon (no CFBundleIcons), and App Store Connect rejects such an upload (ITMS-90713)."
fi

id="$(plist_value "$info" CFBundleIdentifier)"
short="$(plist_value "$info" CFBundleShortVersionString)"
long="$(plist_value "$info" CFBundleVersion)"
[[ "$id" == mobile.passbook.scanner ]] || problem "bundle ID is '$id', expected mobile.passbook.scanner"
[[ -z "$version" || "$short" == "$version" ]] || problem "CFBundleShortVersionString is '$short', expected $version"
[[ -z "$build" || "$long" == "$build" ]] || problem "CFBundleVersion is '$long', expected $build"
ok "$id $short ($long)"

if codesign --verify --strict "$app" >/dev/null 2>&1; then
    if codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q '<string>NDEF</string>'; then
        ok "entitlement: NFC NDEF tag reading"
    else
        problem "the signed app lacks the NFC NDEF tag-reading entitlement. Enable NFC Tag Reading on the App ID."
    fi
else
    echo "note: the app isn't signed; skipping the entitlement check"
fi

if (( failures )); then
    echo "check-archive.sh: $failures problem(s) in $archive" >&2
    exit 1
fi
echo "check-archive.sh: $archive is ready to export"
