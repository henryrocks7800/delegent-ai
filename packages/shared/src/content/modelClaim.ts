// How we describe the AI model to customers — on every surface, in one place.
//
// WHY THIS IS DELIBERATELY VAGUE. Until 2026-08-02 three surfaces each hardcoded
// "Powered by Kimi K2.6": the mobile paywall, the website hero, and the website
// FAQ. We changed the model on 2026-08-01 and every one of them kept advertising
// the old one, including a Play Store screenshot that stayed live for days
// (replaced 2026-08-03, once Managed Publishing was turned off). Naming the
// model turns a routine engineering decision into a marketing change across four
// surfaces plus a store review, and the failure mode is silent — nobody notices
// copy that used to be true.
//
// So the product does not name the model anywhere a customer can read. The
// specific model is an implementation detail we reserve the right to change, and
// changing it should never require a copy edit, a redeploy of the website, or a
// store re-review.
//
// A release-gate test (tests/release-gate/no-model-name-in-copy.test.mjs)
// enforces this: any model vendor or family name appearing in a user-facing
// string fails the build.
//
// ON DEFENSIBILITY. "Frontier" is a real, load-bearing claim, not decoration, so
// it is held to the same bar as everything else in docs/play-store/LISTING.md.
// It is defensible while we run a top-tier general model from a major lab, which
// has been true of every model we have shipped. If we ever move to a small or
// specialised model to save money, THIS WORDING MUST CHANGE — that is the whole
// point of it living in one file.

/** The short badge line. Used where there is room for one clause. */
export const MODEL_CLAIM_SHORT = 'Powered by a frontier AI model';

/** The paywall / plan-picker line. The reassurance is what happens to what you send. */
export const MODEL_CLAIM_PAYWALL =
  'Powered by a frontier AI model, and nothing you send is used to train it.';

/**
 * The FAQ answer. Says plainly that we choose the model and may change it, which
 * is both true and the thing that stops this becoming a promise we have to keep.
 */
export const MODEL_CLAIM_FAQ =
  'A frontier AI model. You get that capability with none of the setup and no technical skill needed. '
  + 'We choose the model and keep it current as better ones arrive, so you get our best without '
  + 'changing a setting.';

/**
 * THE MODEL BY NAME (Alex, 2026-09-28: "it would be good somewhere to let
 * people know that we use GPT-6"). This reverses the 2026-08-02 rule above for
 * two places only, the app's FAQ and the Talk beta note, and both read it from
 * HERE, so a model change is one edit to this line and an app update, never a
 * hunt through copy. The paywall, the store listing and the website keep the
 * generic claim, so a model change still never needs a store review. It must
 * match MODEL in apps/agent/src/model.ts (openai/gpt-6-luna).
 */
export const MODEL_NAME_PUBLIC = 'GPT-6 Luna from OpenAI';

export const MODEL_FAQ_QUESTION = 'Which AI model does my coworker use?';
export const MODEL_FAQ_ANSWER =
  `Your coworker thinks with ${MODEL_NAME_PUBLIC}, a frontier AI model, in the chat and in Talk. `
  + 'Nothing you send is used to train it. We choose the model and move to better ones as they arrive, '
  + 'so this answer can change.';
