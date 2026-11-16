#!/usr/bin/env python3
"""Inject EXPO_PUBLIC_* values from a local provider env file into the
mobile app's generatedExpoPublicEnv.ts so the Gradle release build bakes
them into the JS bundle. Restored to a placeholder after the build by the
caller (scripts/build-fresh-apk.sh)."""

import argparse
import re
import sys
from pathlib import Path

# Which keys are baked, and equally which keys may be read out of the secrets
# file, is the set the committed placeholder declares. A list repeated here is
# an allowlist that falls behind the app: the Sentry DSN was missing from it
# once already, so crash reporting shipped OFF despite the wiring being in
# place, and the same omission would silently disable analytics next.
KEY_PATTERN = re.compile(r"^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*:", re.M)


def allowed_keys(target: Path) -> list[str]:
    keys = KEY_PATTERN.findall(target.read_text(encoding="utf-8"))
    if not keys:
        raise SystemExit(f"no EXPO_PUBLIC_* keys declared in {target}")
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()

    env_path = Path(args.env_file)
    if not env_path.exists():
        print(f"error: env file not found: {env_path}", file=sys.stderr)
        return 1

    target = Path(args.target)
    # Read the declared keys before the target is overwritten below.
    ALLOWED = allowed_keys(target)
    values = {key: "" for key in ALLOWED}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line.strip())
        if not m:
            continue
        key = m.group(1)
        if key not in ALLOWED:
            continue
        value = m.group(2).strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        values[key] = value

    missing = [k for k, v in values.items() if not v]
    if missing:
        print(f"warning: missing EXPO_PUBLIC values: {', '.join(missing)}", file=sys.stderr)

    body = [
        "// Generated for a fresh release build by scripts/build-fresh-apk.sh.",
        "// DO NOT COMMIT LIVE VALUES, this file is restored to a placeholder",
        "// immediately after Gradle finishes.",
        "export const generatedExpoPublicEnv = {",
    ]
    for key in ALLOWED:
        # Use double-quoted string literals so anything weird in the value
        # (apostrophes, accents) doesn't break the TypeScript parse.
        escaped = values[key].replace("\\", "\\\\").replace('"', '\\"')
        body.append(f'  {key}: "{escaped}",')
    body.append("} as const;")
    body.append("")

    target.write_text("\n".join(body), encoding="utf-8")
    set_count = sum(1 for v in values.values() if v)
    print(f"injected {set_count}/{len(ALLOWED)} EXPO_PUBLIC values into {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
