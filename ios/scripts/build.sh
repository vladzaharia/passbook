#!/bin/bash
# Builds the PassBook Scanner iOS app. Generates the Xcode project from ios/project.yml with XcodeGen, then
# builds with xcodebuild. It never installs anything on a device.
#
#   ios/scripts/build.sh                  generate, then build for the iOS Simulator (no team needed)
#   ios/scripts/build.sh --generate-only  just regenerate ios/PassBookScanner.xcodeproj
#   ios/scripts/build.sh --archive        xcodebuild archive (Release) to ios/build/PassBookScanner.xcarchive with
#                                         automatic signing; needs APPLE_TEAM_ID and a profile for
#                                         mobile.passbook.scanner. Add --no-sign for an unsigned archive (a check).
#   ios/scripts/build.sh --archive --export upload
#                                         ... then -exportArchive with the app-store-connect method: `upload` sends
#                                         it to App Store Connect (TestFlight), `export` writes the .ipa to
#                                         ios/build/Export. --export alone exports an existing --archive-path.
#
# Options:
#   --marketing-version <X.Y.Z>  MARKETING_VERSION (CFBundleShortVersionString)
#   --build-number <N>           CURRENT_PROJECT_VERSION (CFBundleVersion)
#   --archive-path <path>        default ios/build/PassBookScanner.xcarchive
#
# Environment:
#   APPLE_TEAM_ID                Apple Developer team (10 characters) for signed archives and exports
#   XCODEGEN                     path to xcodegen (default: from PATH, then /opt/homebrew/bin)
#   PASSBOOK_ASC_KEY_PATH, PASSBOOK_ASC_KEY_ID, PASSBOOK_ASC_ISSUER_ID
#                                an App Store Connect API key, for the release workflow only. With all three set,
#                                --archive and --export authenticate with the key and pass
#                                -allowProvisioningUpdates, so Xcode's cloud-managed signing supplies the
#                                certificates and profiles. The script refuses them outside
#                                .github/workflows/ios-testflight.yml on GitHub Actions.
set -euo pipefail

APP="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$APP/PassBookScanner.xcodeproj"
DERIVED="$APP/build/DerivedData"
MODE=simulator
SIGN=1
EXPORT=""
ARCHIVE_PATH="$APP/build/PassBookScanner.xcarchive"
EXPORT_PATH="$APP/build/Export"
VERSION_SETTINGS=()

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-sign) SIGN=0 ;;
        --generate-only) MODE=generate ;;
        --archive) MODE=archive ;;
        --export) EXPORT="$2"; shift ;;
        --archive-path) ARCHIVE_PATH="$2"; shift ;;
        --marketing-version) VERSION_SETTINGS+=("MARKETING_VERSION=$2"); shift ;;
        --build-number) VERSION_SETTINGS+=("CURRENT_PROJECT_VERSION=$2"); shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

if [[ -n "$EXPORT" && "$EXPORT" != upload && "$EXPORT" != export ]]; then
    echo "--export takes upload or export" >&2
    exit 2
fi
if [[ -n "$EXPORT" && "$MODE" == simulator ]]; then MODE=export; fi
if [[ -n "$EXPORT" && "$MODE" != archive && "$MODE" != export ]]; then
    echo "--export goes with --archive, or alone to export an existing --archive-path" >&2
    exit 2
fi

# The App Store Connect API key (all three variables or none) brings -allowProvisioningUpdates, which only the
# release workflow may pass.
AUTH=()
count=0
for name in PASSBOOK_ASC_KEY_PATH PASSBOOK_ASC_KEY_ID PASSBOOK_ASC_ISSUER_ID; do
    if [[ -n "${!name:-}" ]]; then count=$(( count + 1 )); fi
done
if (( count == 1 || count == 2 )); then
    echo "Set all of PASSBOOK_ASC_KEY_PATH, PASSBOOK_ASC_KEY_ID, and PASSBOOK_ASC_ISSUER_ID, or none." >&2
    exit 2
fi
if (( count == 3 )); then
    if [[ "${GITHUB_ACTIONS:-}" != true || "${GITHUB_WORKFLOW_REF:-}" != */.github/workflows/ios-testflight.yml@* ]]; then
        echo "The App Store Connect API key is for the release workflow only (.github/workflows/ios-testflight.yml)," >&2
        echo "because it passes -allowProvisioningUpdates. Build with your Xcode account and existing profiles." >&2
        exit 2
    fi
    AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$PASSBOOK_ASC_KEY_PATH"
          -authenticationKeyID "$PASSBOOK_ASC_KEY_ID" -authenticationKeyIssuerID "$PASSBOOK_ASC_ISSUER_ID")
fi

if [[ "$MODE" != export ]]; then
    XCODEGEN="${XCODEGEN:-$(command -v xcodegen || echo /opt/homebrew/bin/xcodegen)}"
    [[ -x "$XCODEGEN" ]] || { echo "XcodeGen is required: brew install xcodegen" >&2; exit 1; }
    echo "Generating $PROJECT"
    "$XCODEGEN" generate --spec "$APP/project.yml" --project "$APP" --quiet
fi
[[ "$MODE" == generate ]] && exit 0

team="${APPLE_TEAM_ID:-}"
if [[ "$SIGN" == 1 && ( "$MODE" == archive || "$MODE" == export ) && ! "$team" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "Set APPLE_TEAM_ID to the 10-character team ID for a signed archive, or pass --no-sign." >&2
    exit 1
fi

COMMON=(-project "$PROJECT" -scheme PassBookScanner -derivedDataPath "$DERIVED")
if (( ${#VERSION_SETTINGS[@]} )); then COMMON+=("${VERSION_SETTINGS[@]}"); fi

if [[ "$MODE" == simulator ]]; then
    xcodebuild "${COMMON[@]}" -configuration Debug -destination 'generic/platform=iOS Simulator' \
        "ARCHS=$(uname -m)" CODE_SIGNING_ALLOWED=NO build
    exit 0
fi

if [[ "$MODE" == archive ]]; then
    /bin/rm -rf "${ARCHIVE_PATH:?}"
    if [[ "$SIGN" == 1 ]]; then
        # Without the API key this uses only profiles that already exist. With it (the workflow), Xcode may
        # create the development certificate and profiles it needs.
        xcodebuild "${COMMON[@]}" -configuration Release -destination 'generic/platform=iOS' \
            -archivePath "$ARCHIVE_PATH" ${AUTH[@]+"${AUTH[@]}"} DEVELOPMENT_TEAM="$team" archive
    else
        xcodebuild "${COMMON[@]}" -configuration Release -destination 'generic/platform=iOS' \
            -archivePath "$ARCHIVE_PATH" CODE_SIGNING_ALLOWED=NO archive
    fi
    echo "Archived $ARCHIVE_PATH"
    [[ -z "$EXPORT" ]] && exit 0
fi

if [[ "$SIGN" == 0 ]]; then
    echo "--export needs a signed archive; drop --no-sign." >&2
    exit 2
fi
[[ -d "$ARCHIVE_PATH" ]] || { echo "No archive at $ARCHIVE_PATH" >&2; exit 1; }
OPTIONS="$APP/build/ExportOptions.plist"
mkdir -p "$APP/build"
/bin/rm -f "${OPTIONS:?}"
plutil -create xml1 "$OPTIONS"
plutil -insert method -string app-store-connect "$OPTIONS"
plutil -insert destination -string "$EXPORT" "$OPTIONS"
plutil -insert signingStyle -string automatic "$OPTIONS"
plutil -insert teamID -string "$team" "$OPTIONS"
plutil -insert uploadSymbols -bool YES "$OPTIONS"
# The workflow sets the version and build number, so App Store Connect mustn't change them.
plutil -insert manageAppVersionAndBuildNumber -bool NO "$OPTIONS"

# An upload that fails on the network is tried again, up to three times; anything else, such as Apple
# rejecting the build, fails at once.
LOG="$APP/build/export.log"
for (( attempt = 1; ; attempt++ )); do
    /bin/rm -rf "${EXPORT_PATH:?}"
    if xcodebuild -exportArchive -archivePath "$ARCHIVE_PATH" -exportPath "$EXPORT_PATH" \
        -exportOptionsPlist "$OPTIONS" ${AUTH[@]+"${AUTH[@]}"} 2>&1 | tee "$LOG"; then
        break
    fi
    if [[ "$EXPORT" != upload || $attempt -ge 3 ]] \
        || ! grep -q -i -E 'request timed out|network connection was lost|could not connect|not connected to the internet|NSURLErrorDomain|ENOTFOUND|-100[1459]' "$LOG"; then
        exit 70
    fi
    echo "::warning title=Upload retried::the upload failed on the network (attempt $attempt of 3); trying again"
    sleep $(( attempt * 30 ))
done
if [[ "$EXPORT" == upload ]]; then echo "Uploaded $ARCHIVE_PATH to App Store Connect."; else echo "Exported $EXPORT_PATH"; fi
