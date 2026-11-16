import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const scriptSource = readFileSync(
  resolve(process.cwd(), 'scripts/sidekick-mobile-fresh-emulator.sh'),
  'utf8'
);

test('fresh emulator script waits for Android package service before install and pm clear', () => {
  assert.match(scriptSource, /waitForPackageService/);
  assert.match(scriptSource, /cmd package list packages/);
  assert.match(scriptSource, /Can't find service: package/);
  assert.match(scriptSource, /waitForAdbDevice\s*\n\s*ensureAdbShellResponsive\s*\n\s*waitForBootCompleted\s*\n\s*ensurePackageServiceReadyWithRecovery\s*\n\s*echo "Using Android device/);
  assert.match(scriptSource, /install_with_recovery/);
  assert.match(scriptSource, /install_with_recovery[\s\S]*ensurePackageServiceReadyWithRecovery\s*\n\s*(?:adbDevice|runAdbWithTimeout "\$ADB_COMMAND_TIMEOUT_SECONDS") shell pm clear/);
});

test('fresh emulator script waits for Android boot completion before package checks', () => {
  assert.match(scriptSource, /waitForBootCompleted/);
  assert.match(scriptSource, /getprop\s+sys\.boot_completed/);
  assert.match(scriptSource, /waitForPackageService/);
});

test('fresh emulator script attempts one adb reboot recovery when package service never comes up', () => {
  assert.match(scriptSource, /ensurePackageServiceReadyWithRecovery\(\)\s*\{/);
  assert.match(scriptSource, /PACKAGE_SERVICE_RECOVERY_REBOOTS="\$\{PACKAGE_SERVICE_RECOVERY_REBOOTS:-1\}"/);
  assert.match(scriptSource, /while\s*\(\(\s*attempt\s*<=\s*PACKAGE_SERVICE_RECOVERY_REBOOTS\s*\)\)/);
  assert.match(scriptSource, /(?:adbDevice|runAdbWithTimeout "\$ADB_COMMAND_TIMEOUT_SECONDS")\s+reboot/);
  assert.match(scriptSource, /waitForAdbDevice\s*\n\s*ensureAdbShellResponsive\s*\n\s*waitForBootCompleted\s*\n\s*if\s+waitForPackageService/s);
});

test('fresh emulator script auto-falls back to Windows adb.exe when default WSL adb sees no ready device', () => {
  assert.match(scriptSource, /DEFAULT_WINDOWS_ADB="\/mnt\/c\/Users\/Alex\/AppData\/Local\/Android\/Sdk\/platform-tools\/adb\.exe"/);
  assert.match(
    scriptSource,
    /devices \| tr -d '\\r' \| awk 'NR > 1 && \$2 == "device" \{ print \$1; exit \}'/,
    'Windows adb.exe emits CRLF; serial discovery must strip carriage returns before matching the device column',
  );
  assert.match(
    scriptSource,
    /if \[\[ -z "\$ADB_SERIAL" && "\$ADB" != \*\.exe && -x "\$DEFAULT_WINDOWS_ADB" \]\]; then[\s\S]*ADB="\$DEFAULT_WINDOWS_ADB"[\s\S]*resolveAdbSerial/,
    'when WSL default adb cannot resolve a ready device, script should retry discovery through Windows adb.exe automatically',
  );
  assert.match(
    scriptSource,
    /Switching ADB transport to Windows platform-tools/,
    'fallback path should emit explicit diagnostics for evidence handoff',
  );
});
