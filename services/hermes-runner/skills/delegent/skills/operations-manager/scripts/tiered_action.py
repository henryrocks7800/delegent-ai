#!/usr/bin/env python3
"""The tiered-action classifier - the testable heart of the Operations Manager.

`classify_action(description)` is a PURE function: a plain-English description of
something the operations manager is about to do goes in, and a tier + the
confirmation it demands comes out. Nothing in here touches the network or any
credential; it is deterministic and exhaustively unit-tested in
`test_tiered_action.py`.

The three tiers and the rule that decides them (most dangerous wins):

  DANGEROUS  -> confirmation "hard-confirm", NEVER autonomous.
               Anything that spends money OR enters credentials / payment
               details (pay, buy, checkout, transfer, subscribe, enter a card,
               type a password, log in somewhere on the user's behalf). The user
               must re-approve EVERY single time; the agent never does this on a
               schedule or off a standing instruction.

  MEDIUM     -> confirmation "confirm".
               Filling in a web form in the browser (anything that submits data
               on a site that is not just a money/credential action). The user
               approves once before it runs.

  SAFE       -> confirmation "none" (light touch).
               Updating the user's own lists / drafting an email (drafts are not
               sent), adding a calendar hold, reading and summarising. Reversible,
               in the user's own tools, no outside party affected.

Design choice: when a description is ambiguous between two tiers, the classifier
returns the MORE cautious one. It is always safe to over-confirm; it is never
safe to under-confirm. The agent treats anything it cannot map confidently as at
least MEDIUM.
"""
import argparse
import json
import re
import sys

# --- tier + confirmation vocabulary -----------------------------------------
TIER_SAFE = "safe"
TIER_MEDIUM = "medium"
TIER_DANGEROUS = "dangerous"

CONFIRM_NONE = "none"
CONFIRM_CONFIRM = "confirm"
CONFIRM_HARD = "hard-confirm"

_CONFIRMATION = {
    TIER_SAFE: CONFIRM_NONE,
    TIER_MEDIUM: CONFIRM_CONFIRM,
    TIER_DANGEROUS: CONFIRM_HARD,
}

# Ordering so "most dangerous wins" is a simple max().
_RANK = {TIER_SAFE: 0, TIER_MEDIUM: 1, TIER_DANGEROUS: 2}


def _word(*words):
    """A regex that matches any of the given phrases as whole words/phrases."""
    parts = [re.escape(w) for w in words]
    return re.compile(r"(?<![a-z])(?:" + "|".join(parts) + r")(?![a-z])")


# DANGEROUS: spends money, or enters credentials / payment details.
_MONEY_PATTERNS = [
    _word("pay", "pays", "paid", "paying", "payment", "pay for"),
    _word("buy", "buys", "bought", "buying", "purchase", "purchasing", "order", "ordering"),
    _word("checkout", "check out", "place an order", "place the order"),
    _word("subscribe", "subscription", "renew", "renews", "renewal", "upgrade the plan",
          "top up", "top-up", "add funds"),
    _word("transfer", "transfers", "wire", "send money", "send funds", "send payment",
          "remit", "refund", "payout", "withdraw", "deposit"),
    _word("invoice payment", "settle the invoice", "settle an invoice", "pay the invoice"),
    _word("book and pay", "pay the deposit", "deposit to hold"),
]
_CREDENTIAL_PATTERNS = [
    _word("password", "passcode", "passphrase"),
    _word("credit card", "debit card", "card number", "card details", "cvv", "cvc",
          "card expiry", "payment details", "payment info", "billing details", "bank details",
          "account number", "sort code", "iban", "routing number", "ssn", "social security"),
    _word("log in", "login", "logs in", "sign in", "signs in", "log into", "log in to",
          "authenticate", "enter credentials", "enter the password", "2fa", "one-time code",
          "otp", "verification code"),
    _word("api key", "secret key", "private key", "access token"),
]

# MEDIUM: filling in / submitting a web form in the browser (not money/credential).
_FORM_PATTERNS = [
    _word("fill in", "fill out", "fill the form", "fill in the form", "fill out the form",
          "form-fill", "form fill", "complete the form", "complete a form"),
    _word("submit the form", "submit a form", "submit the application", "submit an application",
          "submit a request", "register on", "sign up on", "sign up for", "apply on",
          "apply for", "book a", "book an", "book the", "make a booking", "reserve a",
          "reserve the", "request a quote", "request an appointment", "schedule an appointment"),
    _word("browser form", "web form", "online form", "contact form"),
]

# DRAFTING: writing a draft (which is NOT sending). Kept separate so it can beat
# a co-occurring "reply to" / "send" verb - a draft never leaves the user's tools.
_DRAFT_PATTERNS = [
    _word("draft", "drafts", "drafting", "draft an email", "draft a reply", "draft a message",
          "write a draft", "prepare a draft", "compose a draft"),
]

# SAFE: own-list updates + reads (drafting handled via _DRAFT_PATTERNS).
_SAFE_PATTERNS = [
    _word("add a task", "add task", "add tasks", "add a to-do", "add a todo", "add to the list",
          "update the list", "update my list", "update lists", "tick off", "close a task",
          "complete a task", "mark done", "mark as done", "reorder", "prioritise the list",
          "prioritize the list", "tidy the list"),
    _word("add a calendar hold", "block time", "hold time", "pencil in", "add a calendar event",
          "add an event", "create a calendar event", "put it on the calendar", "schedule a hold"),
    _word("summarise", "summarize", "read", "reads", "reading", "review", "list", "brief",
          "round up", "round-up", "look over", "go over", "check", "scan"),
    _word("note", "notes", "make a note", "jot down", "remind me", "reminder", "flag", "label"),
]

# A "send" of an email is explicitly NOT safe: drafting is safe, sending reaches
# an outside party irreversibly, so it must be confirmed. Treated as MEDIUM.
_SEND_PATTERNS = [
    _word("send the email", "send an email", "send email", "send the message", "send a message",
          "send the reply", "send a reply", "email them", "reply to", "send it to", "fire off",
          "send out", "dispatch", "post the", "publish"),
]


def _any(patterns, text):
    return any(p.search(text) for p in patterns)


def classify_action(description: str) -> dict:
    """Classify a plain-English action description into a tier + confirmation.

    Returns: {"tier", "confirmation", "reason", "signals"}.
    """
    text = (description or "").strip().lower()
    if not text:
        # Empty / unknown -> over-confirm. Never silently treat as safe.
        return {
            "tier": TIER_MEDIUM,
            "confirmation": _CONFIRMATION[TIER_MEDIUM],
            "reason": "no action described; defaulting to confirm rather than acting blind",
            "signals": [],
        }

    signals = []
    tier = None
    reason = None

    # DANGEROUS first - money or credentials/payment. Most cautious, never autonomous.
    if _any(_MONEY_PATTERNS, text):
        signals.append("spends-money")
    if _any(_CREDENTIAL_PATTERNS, text):
        signals.append("enters-credentials-or-payment")
    if signals:
        tier = TIER_DANGEROUS
        reason = ("this spends money or enters credentials/payment details; "
                  "hard-confirm every time and never autonomous")
        return {"tier": tier, "confirmation": _CONFIRMATION[tier], "reason": reason,
                "signals": signals}

    # An explicit "draft" intent is light-touch even if the text mentions a
    # recipient ("draft a reply to the supplier"): drafting does not send. We
    # only treat it as a send when there is a send verb AND no drafting verb.
    drafting = _any(_DRAFT_PATTERNS, text)

    # MEDIUM next - browser form-fill, or actually sending to an outside party.
    if _any(_FORM_PATTERNS, text):
        signals.append("browser-form-fill")
    if _any(_SEND_PATTERNS, text) and not drafting:
        signals.append("reaches-an-outside-party")
    if signals:
        tier = TIER_MEDIUM
        reason = ("this fills in a web form or reaches an outside party; "
                  "confirm with the user before running")
        return {"tier": tier, "confirmation": _CONFIRMATION[tier], "reason": reason,
                "signals": signals}

    # SAFE - own-list updates, drafting (not sending), reads. Light touch.
    if drafting or _any(_SAFE_PATTERNS, text):
        signals.append("own-list-update-or-draft-or-read")
        tier = TIER_SAFE
        reason = ("this is a light-touch update to the user's own lists, a draft, "
                  "or a read; safe to do directly")
        return {"tier": tier, "confirmation": _CONFIRMATION[tier], "reason": reason,
                "signals": signals}

    # Unmapped - default to MEDIUM (over-confirm). Never assume safe.
    return {
        "tier": TIER_MEDIUM,
        "confirmation": _CONFIRMATION[TIER_MEDIUM],
        "reason": ("could not map this to a known-safe action; defaulting to confirm "
                   "so nothing irreversible happens unapproved"),
        "signals": ["unmapped"],
    }


def main():
    ap = argparse.ArgumentParser(description="Classify an action into a safety tier")
    ap.add_argument("description", nargs="+", help="plain-English action description")
    args = ap.parse_args()
    print(json.dumps(classify_action(" ".join(args.description)), indent=2))


if __name__ == "__main__":
    sys.exit(main())
