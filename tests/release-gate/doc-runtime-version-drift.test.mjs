// A document must not assert a CURRENT runtimeVersion that is not current.
//
// THIS HAS NOW BITTEN THREE TIMES, all found in one audit on 2026-08-28:
//
//   START_HERE.md              "Never publish an OTA to 2.1.1. Current is 2.2.0."
//   docs/OPERATIONS_RUNBOOK.md "runtimeVersion (= the app version, currently 2.1.1)"
//   docs/OTA_INCIDENT_RESPONSE.md "runtimeVersion (= app version, currently 2.2.0)"
//
// By then Android was on 2.5.0 and iOS on 2.6.0. Every one of those was an
// OPERATIONAL document, the kind someone follows while something is on fire.
// Publishing an OTA to a runtime nobody is installed on reaches nobody, and
// LOOKS like a successful ship: eas reports success, the update exists, and
// not one user gets it. You then debug the wrong thing.
//
// WHY A GUARD RATHER THAN JUST FIXING THE DOCS. They were fixed once before,
// on 2026-08-06, and rotted again within three weeks, because the version
// moves and prose does not. The only durable fix is to make the assertion
// checkable.
//
// WHAT THIS DOES NOT DO. It does not ban mentioning old versions. Docs must be
// able to say "this said 2.2.0 until 2026-08-28" as history, and the archive is
// skipped entirely. It only objects to a doc claiming a version is CURRENT when
// it is not, which is the sentence that actually misleads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function liveRuntimeVersions() {
  const cfg = readFileSync(join(REPO, 'apps', 'mobile', 'app.config.ts'), 'utf8');
  const appJson = JSON.parse(readFileSync(join(REPO, 'apps', 'mobile', 'app.json'), 'utf8'));

  // Android inherits the top-level runtimeVersion, which is `config.version`.
  const android = appJson.expo.version;
  // iOS overrides it inside the ios block.
  const iosBlock = cfg.slice(cfg.indexOf('ios: {'));
  const ios = /runtimeVersion:\s*'([\d.]+)'/.exec(iosBlock)?.[1];

  assert.ok(android, 'could not read the Android version from app.json');
  assert.ok(ios, 'could not read the iOS runtimeVersion from app.config.ts');
  return { android, ios };
}

// A filename carrying a date is a POINT-IN-TIME RECORD by convention in this
// repo: AUDIT_FINDINGS_2026-05-29.md, DEFECT_HUNT_2026-06-10.md,
// AUDIT_2026-08-28.md. Such a document exists to say what was true on that day,
// and quoting the stale claim it found is the entire point of it.
//
// This exclusion was added the moment the guard flagged the audit that
// introduced it, for quoting the very lines it had just fixed. Without it the
// guard cries wolf on every incident writeup, and a guard that cries wolf gets
// deleted. It stays narrow: a date in the FILENAME, nothing else. An undated
// operational document like OTA_INCIDENT_RESPONSE.md is still checked, and that
// is where the real damage was.
const DATED_RECORD = /\d{4}-\d{2}-\d{2}/;

function markdownFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    // The archive is history and is deliberately left alone, per CLAUDE.md.
    if (name === 'node_modules' || name === '.git' || name === 'archive') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) markdownFiles(full, out);
    else if (name.endsWith('.md') && !DATED_RECORD.test(name)) out.push(full);
  }
  return out;
}

test('[docs] no document claims a stale runtimeVersion is the current one', () => {
  const { android, ios } = liveRuntimeVersions();
  const files = [join(REPO, 'START_HERE.md'), join(REPO, 'CLAUDE.md')]
    .concat(markdownFiles(join(REPO, 'docs')))
    .concat(markdownFiles(join(REPO, 'infra', 'docs')));

  // "currently 2.1.1", "current is 2.2.0", "Current: 2.3.0" and friends.
  const CLAIM = /current(?:ly|\s+is|:)?\s*\**\s*(\d+\.\d+\.\d+)/gi;

  const offenders = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Only lines that are actually about runtimeVersion.
    for (const line of text.split('\n')) {
      if (!/runtimeversion/i.test(line)) continue;
      for (const m of line.matchAll(CLAIM)) {
        const claimed = m[1];
        if (claimed !== android && claimed !== ios) {
          offenders.push(
            `${relative(REPO, file).split(sep).join('/')}: claims current runtimeVersion ${claimed}, `
            + `but live values are Android ${android} / iOS ${ios}`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    'A document asserts a runtimeVersion that is no longer current. Publishing an OTA '
    + 'to a runtime nobody is installed on reaches nobody AND looks like a successful '
    + 'ship. Either update the version, or reword it as history rather than as a '
    + 'current fact.\n\n' + offenders.join('\n'),
  );
});
