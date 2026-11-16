---
name: connect-telegram
title: Connect Telegram
version: 1.1.0
category: delegent
risk_level: low
description: "Use to walk the user through linking their Telegram account so they can chat with you from Telegram as well as the app."
activation_phrases:
  - "connect telegram"
  - "set up telegram"
  - "link telegram"
  - "use telegram"
  - "message you on telegram"
  - "talk to you on telegram"
requires_human_approval: false
delegent_safe: true
---

# Connect Telegram

## When to use this skill

The user wants to reach you from Telegram — connecting, linking, or setting it up.

## Safety rules

- NEVER invent, guess, or type a connect code yourself. Codes come only from the
  connect card the app shows.
- NEVER ask for the user's Telegram password, phone number, or any login/2FA code.
  Linking never needs their credentials. If they paste a code, tell them not to
  share codes and continue without it.
- Telegram is the only messenger available today. If asked about others, say
  they're not available yet.

## Intake

Ask the user one thing: do they already have the Telegram app installed and
signed in? If not, point them to their app store to install it first.

## The flow (three quick steps)

1. **Show the connect card.** Output this fenced block on its own lines, exactly
   as written, with an EMPTY body:

```telegram-connect
```

   The app turns it into a live "Connect Telegram" card. Don't describe codes or
   links yourself — the card handles it.

2. **Tell them what to tap.** "Tap *Get my connect code*, then *Open Telegram*,
   then *START* in the bot chat." Tapping START sends the code automatically. (If
   the button fails, the card also shows the code + bot name to do it manually.)

3. **Verify.** Ask them to confirm the bot replied "linked", then send a quick
   hello from Telegram. Only call it done once they confirm both.

Wrap up: they can now use either surface, and Telegram replies arrive in Telegram.

## Handover template

```text
What I did:
- Walked you through linking Telegram to me.

Status:
- Linked and verified: [yes / no, and what is left]

How to use it:
- Message me on Telegram any time; replies land in Telegram and stay in one
  shared history with the app. To unlink, use the app's settings.
```

## Troubleshooting

- **Code expired** (codes last ~10 min): emit a fresh ` ```telegram-connect `
  block for a new one.
- **"This chat is already linked"**: that's success — move to verify.
- **No card appears**: tell them to fully close and reopen the app; if still
  missing, try again after the next app update.
- **Bot never replies**: don't keep retrying. Telegram linking may not be switched
  on for their account yet; suggest they contact support from the app.
- **Wants to unlink**: they do it from the app's settings; don't attempt it
  yourself.
