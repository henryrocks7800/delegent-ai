#!/usr/bin/env bash
# Fresh-emulator release install for the mobile lab.
#
# History note (2026-07-15): this script lived for weeks as an UNTRACKED file
# and was lost to a stray cleanup; it is reconstructed from its May base plus
# the behaviours pinned by fresh-emulator-install-readiness.test.mjs, and is
# now COMMITTED so it can never silently vanish again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MOBILE="$ROOT/apps/mobile"
ANDROID="$MOBILE/android"
PACKAGE="${PACKAGE:-com.sidekick.v2}"
PUBLIC_ENV_FILE="${PUBLIC_ENV_FILE:-$HOME/.coworker-ai/live-provider.env}"
REQUIRE_PUBLIC_AUTH_ENV="${REQUIRE_PUBLIC_AUTH_ENV:-1}"
GENERATED_PUBLIC_ENV_MODULE="$MOBILE/src/auth/generatedExpoPublicEnv.ts"

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/jdks/temurin-17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# Timeouts. Every adb invocation is wrapped in `timeout` because a wedged
# emulator turns bare adb calls into indefinite hangs (observed live: pm clear
# hanging forever while the package service was down).
ADB_COMMAND_TIMEOUT_SECONDS="${ADB_COMMAND_TIMEOUT_SECONDS:-60}"
ADB_INSTALL_TIMEOUT_SECONDS="${ADB_INSTALL_TIMEOUT_SECONDS:-300}"
BOOT_COMPLETED_TIMEOUT_SECONDS="${BOOT_COMPLETED_TIMEOUT_SECONDS:-180}"
PACKAGE_SERVICE_TIMEOUT_SECONDS="${PACKAGE_SERVICE_TIMEOUT_SECONDS:-120}"

# ADB resolution. Prefer an explicit ADB, then PATH, then Alex's Windows
# Android Studio SDK path when running from WSL.
DEFAULT_WINDOWS_ADB="/mnt/c/Users/Alex/AppData/Local/Android/Sdk/platform-tools/adb.exe"
ADB="${ADB:-$(command -v adb || true)}"
if [[ -z "$ADB" && -x "$DEFAULT_WINDOWS_ADB" ]]; then
  ADB="$DEFAULT_WINDOWS_ADB"
fi

if [[ -z "$ADB" || ! -x "$ADB" ]]; then
  echo "ADB not found. Install Android platform-tools, ensure 'adb' is on PATH, or export ADB=/path/to/adb." >&2
  exit 1
fi
ADB_SERIAL="${ADB_SERIAL:-}"

resolveAdbSerial() {
  if [[ -n "$ADB_SERIAL" ]]; then
    return 0
  fi
  # Windows adb.exe emits CRLF line endings; strip them before matching the
  # device column or the serial silently never matches.
  ADB_SERIAL="$("$ADB" devices | tr -d '\r' | awk 'NR > 1 && $2 == "device" { print $1; exit }')"
}

adbDevice() {
  if [[ -n "$ADB_SERIAL" ]]; then
    "$ADB" -s "$ADB_SERIAL" "$@"
  else
    "$ADB" "$@"
  fi
}

runAdbWithTimeout() {
  local timeout_seconds="$1"
  shift
  if [[ -n "$ADB_SERIAL" ]]; then
    timeout "$timeout_seconds" "$ADB" -s "$ADB_SERIAL" "$@"
  else
    timeout "$timeout_seconds" "$ADB" "$@"
  fi
}

waitForAdbDevice() {
  resolveAdbSerial
  # The WSL-native adb daemon cannot always see the Windows-hosted emulator.
  # If the default transport resolves no ready device, retry discovery through
  # the Windows platform-tools adb.exe before giving up.
  if [[ -z "$ADB_SERIAL" && "$ADB" != *.exe && -x "$DEFAULT_WINDOWS_ADB" ]]; then
    echo "Switching ADB transport to Windows platform-tools: $DEFAULT_WINDOWS_ADB" >&2
    ADB="$DEFAULT_WINDOWS_ADB"
    resolveAdbSerial
  fi
  runAdbWithTimeout "$ADB_COMMAND_TIMEOUT_SECONDS" wait-for-device
  resolveAdbSerial
}

ensureAdbShellResponsive() {
  local deadline=$(( $(date +%s) + ADB_COMMAND_TIMEOUT_SECONDS ))
  while (( $(date +%s) < deadline )); do
    if runAdbWithTimeout 10 shell echo ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "adb shell never became responsive." >&2
  return 1
}

waitForBootCompleted() {
  local deadline=$(( $(date +%s) + BOOT_COMPLETED_TIMEOUT_SECONDS ))
  local booted
  while (( $(date +%s) < deadline )); do
    booted="$(runAdbWithTimeout 10 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$booted" == "1" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Device never reported sys.boot_completed=1." >&2
  return 1
}

# The Android package service comes up noticeably later than boot_completed on
# cold emulators; installing or pm-clearing before it is ready fails with
# "Can't find service: package". Poll until package listing genuinely works.
waitForPackageService() {
  local deadline=$(( $(date +%s) + PACKAGE_SERVICE_TIMEOUT_SECONDS ))
  local out
  while (( $(date +%s) < deadline )); do
    out="$(runAdbWithTimeout 15 shell cmd package list packages 2>&1 | tr -d '\r' || true)"
    if [[ "$out" != *"Can't find service: package"* && "$out" == *"package:"* ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# If the package service never comes up, one reboot usually recovers a wedged
# emulator; more than one means something is genuinely broken and a human
# should look. Bounded by PACKAGE_SERVICE_RECOVERY_REBOOTS (default 1).
ensurePackageServiceReadyWithRecovery() {
  PACKAGE_SERVICE_RECOVERY_REBOOTS="${PACKAGE_SERVICE_RECOVERY_REBOOTS:-1}"
  if waitForPackageService; then
    return 0
  fi
  local attempt=1
  while (( attempt <= PACKAGE_SERVICE_RECOVERY_REBOOTS )); do
    echo "Package service unavailable; rebooting device (recovery attempt $attempt of $PACKAGE_SERVICE_RECOVERY_REBOOTS)..." >&2
    runAdbWithTimeout "$ADB_COMMAND_TIMEOUT_SECONDS" reboot || true
    sleep 5
    waitForAdbDevice
    ensureAdbShellResponsive
    waitForBootCompleted
    if waitForPackageService; then
      return 0
    fi
    attempt=$(( attempt + 1 ))
  done
  echo "Android package service never became available (after $PACKAGE_SERVICE_RECOVERY_REBOOTS recovery reboot(s))." >&2
  return 1
}

install_with_recovery() {
  local apk="$1"
  if ! runAdbWithTimeout "$ADB_INSTALL_TIMEOUT_SECONDS" install -r "$apk"; then
    echo "adb install failed; recovering the package service and retrying once..." >&2
    ensurePackageServiceReadyWithRecovery
    runAdbWithTimeout "$ADB_INSTALL_TIMEOUT_SECONDS" install -r "$apk"
  fi
  ensurePackageServiceReadyWithRecovery
  runAdbWithTimeout "$ADB_COMMAND_TIMEOUT_SECONDS" shell pm clear "$PACKAGE"
}

loadPublicExpoEnv() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    echo "Public env file not found: $env_file" >&2
    return 0
  fi

  # Load only EXPO_PUBLIC_* values needed by the native app bundle. The file may
  # also contain server-side settings; those are deliberately not exported here.
  # Which keys are allowed through is read from the committed placeholder, so
  # this list cannot fall behind the one the app actually reads.
  eval "$(python3 - "$env_file" "$GENERATED_PUBLIC_ENV_MODULE" <<'PY'
import re
import shlex
import sys
from pathlib import Path

allowed = set(re.findall(r'^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*:', Path(sys.argv[2]).read_text(), re.M))
if not allowed:
    sys.exit('no EXPO_PUBLIC_* keys found in the committed placeholder')
# The iOS client id is read straight from the env file, not from the generated
# module, so it has no placeholder entry to be discovered from.
allowed.add('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID')
path = Path(sys.argv[1])
for raw in path.read_text(errors='ignore').splitlines():
    line = raw.strip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('export '):
        line = line[len('export '):].strip()
    if '=' not in line:
        continue
    key, value = line.split('=', 1)
    key = key.strip()
    if key not in allowed:
        continue
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        value = value[1:-1]
    print(f'export {key}={shlex.quote(value)}')
PY
)"
}

# Put back exactly what was there rather than a hand-written copy of it, which
# drifts the moment a new EXPO_PUBLIC_* key is added and then restores a file
# that fails typecheck and disables whatever read the missing key.
PUBLIC_ENV_PLACEHOLDER_BACKUP=""

restoreGeneratedPublicEnvModule() {
  if [[ -n "$PUBLIC_ENV_PLACEHOLDER_BACKUP" && -f "$PUBLIC_ENV_PLACEHOLDER_BACKUP" ]]; then
    cp "$PUBLIC_ENV_PLACEHOLDER_BACKUP" "$GENERATED_PUBLIC_ENV_MODULE"
    rm -f "$PUBLIC_ENV_PLACEHOLDER_BACKUP"
    PUBLIC_ENV_PLACEHOLDER_BACKUP=""
  fi
}

writeGeneratedPublicEnvModule() {
  PUBLIC_ENV_PLACEHOLDER_BACKUP="$(mktemp)"
  cp "$GENERATED_PUBLIC_ENV_MODULE" "$PUBLIC_ENV_PLACEHOLDER_BACKUP"
  python3 - "$GENERATED_PUBLIC_ENV_MODULE" "$PUBLIC_ENV_PLACEHOLDER_BACKUP" <<'PY'
import json
import os
import re
import sys
from pathlib import Path

out = Path(sys.argv[1])
keys = re.findall(r'^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*:', Path(sys.argv[2]).read_text(), re.M)
if not keys:
    sys.exit('no EXPO_PUBLIC_* keys found in the committed placeholder')
lines = [
    '// Generated temporarily by scripts/sidekick-mobile-fresh-emulator.sh.',
    '// Public mobile values are allowed in the APK but must not be committed.',
    '// DO NOT COMMIT LIVE VALUES.',
    'export const generatedExpoPublicEnv = {',
]
for key in keys:
    lines.append(f'  {key}: {json.dumps(os.environ.get(key, ""))},')
lines.extend(['} as const;', ''])
out.write_text('\n'.join(lines))
PY
}

requirePublicAuthEnv() {
  local missing=()
  for key in EXPO_PUBLIC_SUPABASE_URL EXPO_PUBLIC_SUPABASE_ANON_KEY EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    echo "Missing public mobile auth values: ${missing[*]}" >&2
    echo "Set them in PUBLIC_ENV_FILE=$PUBLIC_ENV_FILE or export them before building." >&2
    if [[ "$REQUIRE_PUBLIC_AUTH_ENV" == "1" ]]; then
      exit 1
    fi
  fi
}

verifyExpoPublicValuesEmbedded() {
  local apk="$1"
  python3 - "$apk" <<'PY'
import os
import sys
import zipfile

apk = sys.argv[1]
required = [
    'EXPO_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
    'EXPO_PUBLIC_SIDEKICK_API_BASE_URL',
]
with zipfile.ZipFile(apk) as archive:
    bundle_names = [name for name in archive.namelist() if name.endswith('index.android.bundle')]
    if not bundle_names:
        print('No index.android.bundle found in APK.', file=sys.stderr)
        sys.exit(1)
    bundle = b'\n'.join(archive.read(name) for name in bundle_names)

missing = []
for key in required:
    value = os.environ.get(key, '')
    if value and value.encode() not in bundle:
        missing.append(key)
if missing:
    print('Public Expo values missing from release JS bundle: ' + ', '.join(missing), file=sys.stderr)
    sys.exit(1)
print('Verified public Expo values embedded in release bundle: ' + ', '.join(required))
PY
}

verifyAndroidManifestMatchesPublicSupabaseHost() {
  python3 - "$ANDROID/app/src/main/AndroidManifest.xml" <<'PY'
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

manifest_path = Path(sys.argv[1])
supabase_url = os.environ.get('EXPO_PUBLIC_SUPABASE_URL', '').strip()
if not supabase_url:
    print('EXPO_PUBLIC_SUPABASE_URL is missing; cannot verify AndroidManifest auth host.', file=sys.stderr)
    sys.exit(1)

host = urlparse(supabase_url).hostname
if not host:
    print('EXPO_PUBLIC_SUPABASE_URL has no host; cannot verify AndroidManifest auth host.', file=sys.stderr)
    sys.exit(1)

manifest = manifest_path.read_text(errors='ignore')
needle = f'android:host="{host}"'
if needle not in manifest:
    print(
        'AndroidManifest Supabase auth-link host does not match EXPO_PUBLIC_SUPABASE_URL. '
        f'Expected {needle} in {manifest_path}. Regenerate/prebuild the manifest or route magic links through sidekick://auth/callback.',
        file=sys.stderr,
    )
    sys.exit(1)
print(f'Verified AndroidManifest Supabase auth-link host: {host}')
PY
}

loadPublicExpoEnv "$PUBLIC_ENV_FILE"
requirePublicAuthEnv
verifyAndroidManifestMatchesPublicSupabaseHost
writeGeneratedPublicEnvModule
trap restoreGeneratedPublicEnvModule EXIT

cd "$MOBILE"
npm run typecheck

# Release builds embed the JS bundle. Force the bundle task to rerun so changed
# EXPO_PUBLIC_* values are actually present in the APK Alex tests.
cd "$ANDROID"
rm -f "$ANDROID/app/build/generated/assets/createBundleReleaseJsAndAssets/index.android.bundle"
./gradlew :app:createBundleReleaseJsAndAssets :app:assembleRelease --no-daemon
APK="$ANDROID/app/build/outputs/apk/release/app-release.apk"
verifyExpoPublicValuesEmbedded "$APK"

waitForAdbDevice
ensureAdbShellResponsive
waitForBootCompleted
ensurePackageServiceReadyWithRecovery
echo "Using Android device: ${ADB_SERIAL:-default adb target}"

INSTALL_APK="$APK"
case "$ADB" in
  *.exe|*.EXE)
    INSTALL_APK="$(wslpath -w "$APK")"
    ;;
esac

install_with_recovery "$INSTALL_APK"
runAdbWithTimeout "$ADB_COMMAND_TIMEOUT_SECONDS" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null

echo "Fresh Sidekick launch complete. Installed release APK, cleared app data, and opened from first-run welcome screen."
echo "APK: $APK"
