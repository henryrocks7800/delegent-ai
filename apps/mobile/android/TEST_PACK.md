# Delegent Android Test Pack

This directory is the single Android testing home for the mobile app. The repo still uses
`sidekick` package names, but the product test pack is organized around Delegent AI user
journeys and the standard Android project shape.

## Structure

```text
apps/mobile/android/
  app/src/test/js/              Fast local source, business, readiness, and contract tests
  app/src/androidTest/          Native instrumented/JUnit tests when we add them
  integration/assertions/       External backend assertions used by device/E2E flows
  integration/maestro/          Maestro smoke flows
  integration/maestro/production/
                                Full 26-flow production Android UI manifest
  integration/production-flow-manifest.json
                                Flow inventory, required state, evidence, and observables
```

## Testing Pyramid

- `app/src/test/js` is the fast layer. These tests run on the host with `node:test` and guard
  product-state logic, source-level UI contracts, selectors, checkout readiness, file surfaces,
  and production-flow manifest integrity.
- `app/src/androidTest` is reserved for native instrumented tests that must run inside Android.
- `integration` is the slowest layer. Maestro drives the emulator/device and pairs UI evidence
  with backend/provider observables.

## Unified Report

Generate a single Android report:

```bash
npm run android:allure
```

The command writes Allure-compatible JSON to:

```text
apps/mobile/android/build/allure-results/
```

and a report to:

```text
apps/mobile/android/build/reports/allure-report/index.html
```

If the Allure CLI is available on `PATH`, the command uses it. Otherwise it still writes valid
Allure result files and a lightweight fallback HTML summary.

Run the full live 26-flow production UI suite before reporting:

```bash
ANDROID_ALLURE_RUN_PRODUCTION_UI=1 npm run android:allure
```

Use existing production UI evidence instead of rerunning the emulator flow:

```bash
npm run android:allure -- --production-evidence apps/mobile/android/build/reports/production-mobile-ui/<run-id>
```

Gradle entry points are also available from this directory:

```bash
./gradlew delegentAndroidFastTests
./gradlew delegentAndroidProductionUi
./gradlew delegentAndroidAllureReport
./gradlew delegentAndroidTestPack
```
