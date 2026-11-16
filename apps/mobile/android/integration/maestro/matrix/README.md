# Device matrix flows

This directory holds Maestro flows that are explicitly designed to be
re-run against multiple Android emulator targets (different screen
sizes + API levels). The master runner picks up everything in here
under `--mode matrix`.

## Target matrix

| AVD name | Width × height | API | Why |
|---|---|---|---|
| `Delegent_Small_API30` | 320 × 640 dp (sw320dp) | 30 | Smallest phone we support. Catches text overflow, button reachability. |
| `Delegent_Pixel_API36` | 411 × 891 dp (sw411dp) | 36 | The default test target. Pixel 6 baseline. |
| `Delegent_Large_API34` | 480 × 960 dp (sw480dp) | 34 | Large phone, common in 2024-2026 launches. |
| `Delegent_Old_API28` | 411 × 891 dp (sw411dp) | 28 | Oldest reasonable API. Catches missing platform APIs, runtime
permission edge cases (POST_NOTIFICATIONS arrived in 33). |

Create them on the Windows side via Android Studio Device Manager
(see [`docs/mobile-lab/DEVICE_MATRIX.md`](../../../../../../docs/mobile-lab/DEVICE_MATRIX.md))
or via the SDK's `avdmanager`:

```powershell
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\avdmanager.bat" create avd `
  --name Delegent_Small_API30 `
  --package "system-images;android-30;google_apis;x86_64" `
  --device "pixel_3a"
```

The AVDs only need to exist on the Windows side; the WSL runner
selects them with `ADB_SERIAL=<emulator-XXXX>` before invoking
`bash scripts/run-mobile-test-pack.sh matrix`.

## What the matrix flows assert

The default matrix pack is **NOT a duplicate** of the smoke/release
pack. It contains a small set of flows that are specifically size-
class-aware:

- `MATRIX-01.small_phone_keeps_send_button_reachable.yaml` —
  asserts the chat send button is within the visible viewport on
  sw320dp.
- `MATRIX-02.large_phone_does_not_stretch_the_chat_bubble_across_full_width.yaml` —
  asserts the assistant bubble has a sensible max-width on sw480dp.
- `MATRIX-03.legacy_api_handles_missing_post_notifications_permission.yaml` —
  asserts no crash on API 28 (which doesn't have POST_NOTIFICATIONS).

For the size-class-blind flows (smoke, release, MAIN-EVENT-01),
just run the existing mode against the target AVD.
