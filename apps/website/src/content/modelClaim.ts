// How we describe the AI model to visitors. Never names it.
//
// The app and the web app read these strings from
// packages/shared/src/content/modelClaim.ts, which carries the full reasoning.
// The website is a standalone Vite build with no workspace dependencies, so it
// keeps its own copy — the same arrangement as webAppLink.ts — and a test in
// website-content-scanner.test.mjs holds the two to identical text.
//
// The short version of why: three surfaces each hardcoded the model's name, we
// changed the model, and all three carried on advertising the old one. The model
// is an implementation detail; changing it must never require a copy edit or a
// store re-review.

export const MODEL_CLAIM_SHORT = 'Powered by a frontier AI model';

export const MODEL_CLAIM_PAYWALL =
  'Powered by a frontier AI model, and nothing you send is used to train it.';

export const MODEL_CLAIM_FAQ =
  'A frontier AI model. You get that capability with none of the setup and no technical skill needed. '
  + 'We choose the model and keep it current as better ones arrive, so you get our best without '
  + 'changing a setting.';
