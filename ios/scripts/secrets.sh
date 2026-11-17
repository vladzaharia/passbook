#!/bin/bash
# Turns the release secrets into a short-lived App Store Connect API key file on the runner, and removes it afterwards.
#
#   ios/scripts/secrets.sh run -- COMMAND [ARGUMENTS...]
#                        write the key, run COMMAND with the outputs in its environment, then clean up,
#                        whatever COMMAND's outcome (also on SIGINT/SIGTERM)
#   ios/scripts/secrets.sh setup     write the key; appends the outputs to $GITHUB_ENV when set, else prints them
#   ios/scripts/secrets.sh cleanup   delete the files; safe to run more than once
#
# Inputs (environment; the iOS TestFlight environment's secrets):
#   ASC_KEY_ID, ASC_ISSUER_ID   App Store Connect API key ID and issuer ID
#   ASC_KEY_P8_BASE64           the AuthKey_<id>.p8 file, base64-encoded (raw PEM is accepted too)
#   PASSBOOK_SECRETS_DIR        where the file goes (default $RUNNER_TEMP/passbook-secrets)
#
# Outputs (exported to COMMAND under `run`): PASSBOOK_ASC_KEY_PATH, PASSBOOK_ASC_KEY_ID, PASSBOOK_ASC_ISSUER_ID.
# The directory is mode 700 and the file 600. Under `run`, COMMAND doesn't see ASC_KEY_P8_BASE64.
set -euo pipefail

dir="${PASSBOOK_SECRETS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/passbook-secrets}"
in_process=0

fail() { echo "secrets.sh: $*" >&2; exit 1; }
note() { echo "secrets.sh: $*" >&2; }

export_env() {
    if (( in_process )); then
        export "$1=$2"
    elif [[ -n "${GITHUB_ENV:-}" ]]; then
        printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV"
    else
        printf 'export %s=%q\n' "$1" "$2"
    fi
}

setup() {
    : "${ASC_KEY_ID:?ASC_KEY_ID is required (a secret in the iOS TestFlight environment)}"
    : "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required}"
    : "${ASC_KEY_P8_BASE64:?ASC_KEY_P8_BASE64 is required}"
    [[ "$ASC_KEY_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "ASC_KEY_ID should be the 10-character key ID"
    umask 077
    mkdir -p "$dir"
    chmod 700 "$dir"
    local key="$dir/AuthKey_$ASC_KEY_ID.p8"
    if [[ "$ASC_KEY_P8_BASE64" == -----BEGIN* ]]; then
        printf '%s\n' "$ASC_KEY_P8_BASE64" > "$key"
    else
        printf '%s' "$ASC_KEY_P8_BASE64" | tr -d ' \n\r\t' | base64 -d > "$key" 2>/dev/null \
            || fail "couldn't base64-decode ASC_KEY_P8_BASE64"
    fi
    chmod 600 "$key"
    grep -q -- '-----BEGIN PRIVATE KEY-----' "$key" || fail "ASC_KEY_P8_BASE64 isn't a .p8 private key"
    openssl pkey -in "$key" -noout 2>/dev/null || fail "ASC_KEY_P8_BASE64 doesn't parse as a private key"
    export_env PASSBOOK_ASC_KEY_PATH "$key"
    export_env PASSBOOK_ASC_KEY_ID "$ASC_KEY_ID"
    export_env PASSBOOK_ASC_ISSUER_ID "$ASC_ISSUER_ID"
    note "App Store Connect API key $ASC_KEY_ID written to $key"
}

cleanup() {
    if [[ -d "$dir" ]]; then
        /bin/rm -rf "${dir:?}"
        note "removed $dir"
    fi
}

run() {
    [[ "${1-}" == -- ]] && shift
    (( $# )) || { echo "usage: $0 run -- COMMAND [ARGUMENTS...]" >&2; exit 2; }
    in_process=1
    cleanup 2>/dev/null
    trap 'cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    local mask status=0
    mask="$(umask)"
    setup
    umask "$mask"
    unset ASC_KEY_P8_BASE64
    "$@" || status=$?
    exit "$status"
}

case "${1-}" in
    run) shift; run "$@" ;;
    setup) setup ;;
    cleanup) cleanup ;;
    *) echo "usage: $0 run -- COMMAND... | setup | cleanup" >&2; exit 2 ;;
esac
