# Mobile end-to-end tests

Mobile-specific full-path tests. These are SOURCE-SHAPE checks (no
emulator); the emulator-driven flows live in
`apps/mobile/android/integration/maestro/`.

## What's here

- `mobile-auth-onboarding-checkout.test.mjs` — the auth → onboarding → checkout flow assertions: every required testID exists, the deeplink intent filter is registered, the OTP screen has the expected fields, the post-checkout landing is the chat surface.

## Running

```bash
npm run test:e2e:mobile
```

Budget: < 30s. No live env required.

## Where the real emulator runs are

- Maestro YAML flows: `apps/mobile/android/integration/maestro/spec/*.yaml` (driven by `npm run mobile:maestro`)
- Audit scripts: `scripts/audit/*.sh` (use `scripts/audit/lib.sh` helpers)
- One-shot smokes: `scripts/sidekick-mobile-fresh-emulator.sh`
