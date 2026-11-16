# Real onboarding demos

Rendered 2026-09-09 from Alex's existing emulator footage. Muted 10-second
loops, H.264, 540 x 960, 15 fps. No generated app UI.

| Asset | Original recording/edit in the main development checkout |
|---|---|
| receipts.mp4 | marketing/video/demo-v2/s4-receipt.mp4 |
| email.mp4 | marketing/video/demo-v2/s2-chat.mp4 |
| connections.mp4 | marketing/video/interview-pro/seg-conn.mp4 |

Each loop repeats 3.2 seconds starting one second into the source edit, removing
the original advert fades. Posters are frames at one second of the output.
The email recording shows the demo invoice
reminder to Mrs Patel. The raw interview chat recording also contains internal
administrative details and is deliberately not included.

The media uses the existing WebView, Asset and FileSystem native modules.
Do not replace it with expo-av in an OTA: that module is excluded from iOS.
