---
name: website-builder
title: Build And Manage Your Website
version: 4.0.0
category: development
risk_level: medium
description: "Use the moment the user wants a NEW website, or wants their site built, published, or changed. Builds a simple static site and deploys it live on Firebase Hosting (free), then keeps updating it on request. Auth is a Firebase service-account key the user pastes once; it is stored in the central encrypted vault, never in chat. Trigger phrases: 'build me a website', 'create a website', 'make me a website', 'update my website', 'change my site', 'make it live', 'publish my website', 'edit my homepage'."
activation_phrases:
  - "build me a website"
  - "create a website"
  - "make me a website"
  - "update my website"
  - "change my site"
  - "make it live"
  - "publish my website"
  - "edit my homepage"
requires_human_approval: true
delegent_safe: true
---

# Build and manage your website

Build a simple new website for the user and keep managing it: scaffold a clean
static site, deploy it live on **Firebase Hosting (free Spark tier)** at
`https://<project>.web.app`, verify it is really serving, then edit and redeploy
on request. This is the operator-proven flow — it has built, deployed a real live
site, and updated it on request.

Scope: simple marketing / brochure sites (a homepage, maybe an about/contact
section). Not web apps, dashboards, or anything with a backend. The site lives as
a git repo on the user's runner and is served as static files on the free tier.

> This skill is for building a NEW site. Managing a user's EXISTING third-party
> site through a vendor's own API is a separate skill that is not built yet — do
> not improvise it here.

## Intake questions (ask before you build)

Ask the user these up front so the first deploy is close to what they want (one
short message, not an interrogation — infer what you reasonably can):

1. **What is the site for?** (business/brand name + one line on what they do.)
2. **What should the homepage say?** (headline, a sentence or two, and how people
   reach them — email/phone/socials.)
3. **Any look preference?** (colour, tone.) If they DON'T specify one, the
   starter site already ships a polished modern default (the Delegent house
   style: warm off-white paper, a sage-green accent, a serif italic display
   voice, generous spacing, light + dark aware). Keep that look unless the user
   asks for something different, and replace the three starter "points" with the
   business's real ones. Only reach for a plainer or different style when the
   user actually asks for it.
4. **Do they already have a Firebase project + service-account key**, or do they
   need walking through creating one (the two human steps below)?
5. **Custom domain now or later?** (Fine to launch on the free `*.web.app` URL and
   add a domain afterwards.)

## The two human steps (everything else is yours)

Only two things genuinely need the human, because they need their Google account:

1. **Create a free Firebase project** at <https://console.firebase.google.com>.
2. **Generate a service-account private key** and paste the JSON to you.

You do the rest: scaffold, deploy, verify, and every future edit.

### HARD REQUIREMENT: the key is generated on a DESKTOP browser

The "Service accounts" tab is **hidden on the mobile Firebase Console**. The user
MUST do the key step on a desktop/laptop browser. Say this up front — it saves a
frustrating loop where they cannot find the button on their phone.

Guide them, in the Firebase Console on a desktop:

1. Create (or open) a project.
2. Gear icon -> **Project settings** -> **Service accounts** tab.
3. Click **Generate new private key** -> **Generate key**. A JSON file downloads.
4. Paste the **entire JSON** into chat.

We do **NOT** use `firebase login:ci` — that needs an interactive browser and
fails on the headless runner. The service-account key is the reliable headless
path.

## Step 1 — Connect (verify + store the key ENCRYPTED in the vault)

> **Already connected?** Run `delegent-connect list` before you plan any setup. It shows the services the user signed into on the Connections screen, which never appear in chat and never touch your workspace. If the provider is listed, it is live: use it. `delegent-keys list` shows the other kind, credentials the user typed in. Check both.

When the user pastes the service-account JSON, store it in the central encrypted
vault. **Never write it to a plaintext file and never echo it back.**

```
# paste the JSON on stdin (preferred — the key never becomes a shell argument):
python3 scripts/website_manager.py connect --service-account-json -
```

This validates that the blob is a real `service_account` key (right `type`,
`project_id`, `client_email`, `private_key`) and stores it **encrypted** in the
vault under `firebase-<projectid>` (the same store the `delegent-keys` CLI
drives). It prints only the project id + client email — never the key. Equivalent
vault command:

```
delegent-keys put firebase-<projectid> --stdin --meta kind=service_account
```

Tell the user "connected to `<project>`" only when it prints `"connected": true`.
Check anytime with `python3 scripts/website_manager.py status`.

## Step 2 — Build the site

```
python3 scripts/website_manager.py build --site-dir <repo path> \
  [--name "Their Business"] [--brief "one-line description"]
```

This scaffolds a simple static site — `public/index.html` (inline CSS, no
external assets), `firebase.json`, `.firebaserc` — and makes an initial git
commit so the deployed tree can self-identify. It is idempotent: an existing
`index.html` is left alone unless you pass `--force`. Then edit
`public/index.html` to say what the user wants (keep it simple, marketing copy
only) and `git commit` the change so there is a clean commit to stamp and revert.

## Step 3 — Deploy, then PROVE it is live

```
python3 scripts/website_manager.py deploy --site-dir <repo path> \
  [--live-url https://<project>.web.app]
```

What deploy does:

1. Local-installs `firebase-tools` if needed (into the runner's own dir; never
   `npm install -g`, which EACCEShes) and invokes `node_modules/.bin/firebase`.
2. Stamps the git commit hash into the deployed tree so the live URL can
   self-identify.
3. **Materialises the service-account key from the vault to a temp file (mode
   0600) for the split second of the deploy, sets it as
   `GOOGLE_APPLICATION_CREDENTIALS`, runs `firebase deploy --only hosting`, then
   DELETES that temp file in a `finally` block** — success or failure. This is
   exactly what the vault CLI does directly:

   ```
   delegent-keys run --service firebase-<id> --file \
     --var GOOGLE_APPLICATION_CREDENTIALS -- \
     node_modules/.bin/firebase deploy --only hosting --project <id>
   ```

4. **Verifies the deploy by curling the live URL**: it re-reads
   `<live-url>/version.txt` and requires HTTP 200 **and** that the exact commit it
   just deployed is being served.

Report `"deployed"` verbatim. Only say the site is live when it is `true`. A
deploy CLI has been seen to print "Success! Published" while the live address
served a 404 — so a 404, a stale build, or an unreachable URL all come back
`"deployed": false` with the reason, and so do you. **Never claim live without
the verified read-back.**

## Step 4 — Update on request (the recurring work)

When the user wants a change:

1. Edit `public/index.html` (simple marketing copy only).
2. `git commit` the change (clean commit to stamp + a point to revert to).
3. `deploy` again.
4. **Verify**, then report the live URL.

To undo a bad change, `git revert` the last commit (reversible, no history
rewrite) and redeploy with the same verified read-back. Never force-push or
rewrite history.

## Custom domain (optional) — you guide, the user acts

You **cannot** buy a domain or change DNS — those are the user's actions in their
registrar. If they want a custom domain:

1. They buy the domain from any registrar (their payment, their account).
2. In the Firebase Console -> Hosting -> **Add custom domain**, Firebase shows
   the exact DNS records (usually two A records, or a TXT for verification).
3. Relay those records to the user; they paste them into their registrar's DNS.
4. Firebase auto-provisions the SSL certificate once DNS propagates (can take a
   few hours). Verify the custom URL the same way once it is live.

## Verify checklist (before you ever say "it's live")

- [ ] `deploy` returned `"deployed": true`.
- [ ] The live URL returned HTTP 200 (not 404, not unreachable).
- [ ] The commit hash served at `/version.txt` equals the one just deployed.

If any box is unchecked, it is NOT live — say so plainly, paste the reason, and
offer to fix or roll back.

## Handover (what you report back)

When a build or update is live and verified, hand over in plain language — no
infrastructure detail. Deliverables:

- **The live URL** (the `*.web.app` address, or the custom domain once it resolves).
- **What changed** this round (one line — "published your homepage", "updated the
  contact section").
- **How to get more changes**: they just tell you what to change and you edit +
  redeploy.
- If a custom domain is pending DNS, say it can take a few hours and you will
  confirm once it is serving.

Never hand over a URL you have not verified with the read-back curl.

## Safety (non-negotiable)

- **Never buy a domain, change DNS, or enter payment details.** Those stay human
  actions; you only guide and hand over the exact records.
- **Keys live in the central encrypted vault, never in chat and never as a
  plaintext file.** The service-account JSON is stored encrypted via
  `_shared/credential_store.py` / `delegent-keys`, and is only ever materialised
  transiently (0600 temp file, deleted in a `finally`) at deploy time. Never echo
  a key back to the user.
- **Never claim live without the verified curl read-back.** The deploy tool's own
  "success" output is not proof; the live URL serving the deployed commit is.
- Simple marketing sites only — no backends, no forms wired to real handlers, no
  destructive project actions (this skill has no delete-project / take-down path).

## Files

- `scripts/website_manager.py` — the whole engine: `connect` (verify the
  service-account key + store it ENCRYPTED in the vault), `build` (scaffold the
  static site + git commit), `deploy` (local-install firebase-tools + materialise
  the key to a 0600 temp file + `firebase deploy` + verify the live URL + shred
  the temp key in a finally), `status` (connected project, never the key).
- `scripts/test_website_manager.py` — contract tests (SA stored encrypted + never
  printed; deploy materialises the key to a temp file, deploys, verifies, and
  cleans up even on failure; a failed curl => not live).
- Central vault: `delegent-keys` (CLI) over `../../_shared/credential_store.py`
  (encrypted store). `../../_shared/oauth2.py` provides shared HTTP helpers.
