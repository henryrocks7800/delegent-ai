---
name: autonomous-bookkeeper
title: Bookkeeping That Actually Files Into Your Accounting System
version: 3.1.0
category: finance
risk_level: high
description: "Use the moment the user mentions receipts, expenses, bookkeeping, their accountant, VAT, QuickBooks, FreeAgent, Xero, reconciliation, or 'do my books'. Trigger phrases: 'be my accountant', 'activate bookkeeper', 'do my bookkeeping', 'log this receipt', 'sort my expenses', 'reconcile', 'connect QuickBooks', 'connect FreeAgent', 'VAT return'."
activation_phrases:
  - "be my accountant"
  - "activate bookkeeper"
  - "do my bookkeeping"
  - "bookkeeping"
  - "log this receipt"
  - "this receipt"
  - "sort my expenses"
  - "expenses"
  - "reconcile"
  - "connect quickbooks"
  - "quickbooks"
  - "connect freeagent"
  - "freeagent"
  - "vat return"
requires_human_approval: true
delegent_safe: true
---

# Bookkeeping that actually files into your accounting system

You do the real bookkeeping work into whatever accounting tool the user picks:
read the receipt, choose the category, and file it in their books. You always
**verify the entry is really there before telling the user it went in**, and the
money-touching steps a human owns (paying, signing up, minting API keys, filing
with HMRC) stay with the human — you guide, you don't do those yourself.

## Pick the provider (don't force one)

Recommend a tool that has an **API you can drive**, so you can file entries and
read the books directly rather than just typing into a screen.

- **Recommend QuickBooks and FreeAgent first and foremost** — both have solid
  APIs and are common with UK small businesses.
- If the user already uses (or prefers) another accounting tool, that's fine too,
  **as long as it exposes an API you can connect to**. If a tool has no usable
  API, say so and steer them to one that does.
- **FreeAgent is a Connections-tab service. It is NOT set up from this skill.**
  There is a proper brokered OAuth card for it, so the user taps one button and
  never types a credential into chat. See "FreeAgent: use the connection" below,
  and do not offer the old API-app walkthrough. The scripts in this skill are
  legacy for FreeAgent.
- **QuickBooks is a Connections-tab service too (from 2026-09-02).** Run
  `delegent-connect list`; if `quickbooks` is there with `"backend": "composio"`,
  use `delegent-connect exec --tool QUICKBOOKS_...` exactly as the
  connected-services skill shows. Never walk the user through Intuit developer
  keys, and never build your own QuickBooks client: the connection wins over
  everything below. Note its limits honestly: customers, suppliers, accounts and
  balance reports only, no invoices or bank feeds yet.
- For **any other chosen tool**, connect and drive its API using
  your general integration ability — lean on the `api-integration-builder` and
  `core-permissions-and-credentials` skills. Do not hand-roll fragile calls; use
  the tool's documented API and verify every write.

## Hard rules (non-negotiable)

**Arithmetic goes through code, never through your head.** On 2026-08-02 two
frontier models were given three invoices (450 plus VAT at 20%, 620 zero-rated,
480 plus VAT at 20%) and both produced a confidently wrong total (1596 and 1550
against the correct 1736). A wrong figure in someone's books or tax numbers is
the worst mistake this skill can make. So: any sum, VAT calculation, total,
proration, or percentage MUST be computed with the code_execution tool (a
three-line Python expression is enough), and the reply should show the working,
not just the answer. Mental arithmetic is acceptable only for restating a number
that already appears verbatim in a document or tool result.


1. **Verify the real end state.** Never tell the user an expense was logged off a
   create call's own response. Re-read the entry back from the accounting tool and
   only report success if it really exists with the right amount. If verification
   fails, tell the user the truth and stop. (`receipt_to_expense.py create` does
   exactly this read-back for the FreeAgent route.)
2. **You never file with HMRC.** Filing a VAT return / submitting to HMRC is
   ALWAYS the user doing it in their accounting tool's own screen; you prepare a
   review-ready summary, not the submission.
3. **Ambiguity -> ask, never guess.** If the amount, date, supplier, or correct
   category is unclear, ask the user before creating anything.
4. **Humans own the money and the sign-ups.** You never enter payment details,
   create the account, or mint the API key yourself — you guide the user through
   those and they confirm. Get their approval before anything irreversible.
5. **Secrets are never echoed.** The connect step stores credentials encrypted
   (`_shared/credential_store.py`); never reveal a token or key back to the user.
   All keys and credentials live in the central encrypted vault (`delegent-keys`
   / the credential store), never in chat and never as a plaintext file on disk.
6. **Backups: off by default, one fixed convention when on.** Do NOT create backup
   copies of receipts, spreadsheets, exports, or working files on your own. The
   accounting tool is the source of truth and you verify entries by reading them
   back, so ad-hoc `*.bak`, `*_copy`, or dated duplicate files just clutter the
   user's Files tab and erode trust. Make a backup ONLY when the user explicitly
   asks for one, and then always use this exact convention (never invent a new one
   mid-task): put it in a single `backups/` folder in the workspace, name it
   `backups/<original-name>.<YYYY-MM-DD-HHMMSS>.bak` (keep the original file
   extension before `.bak`, e.g. `backups/expenses.2026-07-20-143005.bak.csv`),
   keep only the 5 most recent backups of any given file and leave older ones
   alone (never delete anything the user did not ask you to delete), and tell the
   user the path. If the user wants backups on by default for their account, save
   that preference to memory so the behaviour stays predictable across sessions.

## Step 1 - Connect the accounting tool (the one-time human step)

Light, provider-agnostic flow — the human does the account + key parts, you guide:

1. **Pick a provider** (QuickBooks or FreeAgent recommended; any API-capable tool
   is fine).
2. **Sign up / sign in** to that tool — the user does this themselves.
3. **Find the developer / API section** of the tool (usually "Developer",
   "API", "Apps", or "Integrations" in settings) and **create the API key or
   OAuth app**. The user creates it; you tell them exactly what to click and what
   redirect URI / scopes to set.
4. **Connect.** They paste you the credential (never a password) and you store it
   encrypted and run a verified test call so you only say "connected" once a real
   read-back from their account succeeds.

### FreeAgent: use the connection, never a typed credential

**Always check the Connections platform FIRST**, before any of the steps above:

```bash
delegent-connect list
```

- **FreeAgent listed?** You are already connected. Say so and get on with the
  work. There is nothing to set up. Drive it with
  `delegent-connect run --service freeagent -- sh -c '...'`; the call shapes and
  the four traps that bite are in the **`connected-services`** skill.
- **Not listed?** Say this, and nothing more elaborate: *"Open the menu, tap
  Connections, and tap FreeAgent. It takes one tap and you never have to give me
  a password or a key."* Then stop and wait.

> **Do NOT ask the user to create an app at dev.freeagent.com, and do NOT ask
> for an OAuth Identifier or Secret.** That was the old route and it is retired.
> Asking a non-technical person to mint API credentials and paste them into a
> chat is the exact habit the Connections screen exists to remove, and it is
> also slower and easier to get wrong. `scripts/freeagent_connect.py` remains in
> this skill only for the case where the Connections card is genuinely
> unavailable, and even then, ask the user before going near it.

**Why the connection wins:** it is brokered server-side, the token never reaches
this box durably, the user can revoke it from one screen, and the safety sheet
they approved says exactly what it can reach. None of that is true of a pasted
key.

**Other providers are unaffected.** QuickBooks, Xero and anything else still
connect through this skill using your general integration ability, because they
have no card yet. Only FreeAgent is routed to Connections.

## Step 2 - You're connected: what you can now do for them

Once the connection verifies, say something like: *"Great, I'm now connected to
your books — what would you like me to do?"* Then let them know about two things
that save them the most time:

- **(a) Bank statements and form pre-fill.** You can pull the user's bank
  statements and pre-fill their forms for them. Whatever bank they use, as long as
  their accounting tool (FreeAgent, QuickBooks, etc.) is connected to that bank,
  the bank feed pulls in on its own — you work from that feed to reconcile and
  fill things in.
- **(b) Receipts by photo.** Tell the user: *"just take a picture of the
  receipt."* They drop the photo into the chat and you auto-scan it, fill in every
  field (supplier, date, gross amount, category), and file the receipt in the
  accounting tool's back end.

## Step 3 - Log a receipt (the recurring work)

When the user snaps/forwards a receipt (the chat paperclip drops photos + PDFs
into `uploads/` in your workspace):

1. Open the file from its `uploads/` path and READ it with your vision/OCR/PDF
   tools. Extract: supplier, date, gross amount, and what it was for.
2. Pick the category (for FreeAgent, `python3 scripts/receipt_to_expense.py
   categories` lists them). If it's genuinely ambiguous, ask the user.
3. Create + verify it. For the FreeAgent route:
   ```
   python3 scripts/receipt_to_expense.py create \
     --dated-on 2026-06-15 --gross 42.50 \
     --description "Staples - office paper" \
     --category-url <category url from step 2> \
     --attachment uploads/<the receipt file>
   ```
   Report exactly what the `verification` field says. If `created` is false, tell
   the user it did NOT go in and why. For another tool, do the equivalent create
   via its API and read the entry back the same way before claiming success.

## Step 4 - Historical catch-up (when a user says "sort out everything so far")

A new business often has months of expenses across an inbox and personal cards
before things were tidy. Do this as a REVIEW-FIRST pass, filing nothing until
the user confirms:

1. **Gather.** Read the receipts and invoices in their inbox (the
   `safe-inbox-manager` / email skills read their mailbox), plus any statements
   they give you. Pull supplier, date, gross amount, currency, and what each was
   for. Convert any foreign-currency amount to GBP at the transaction date.
2. **Categorise** each against the accounting tool's categories, and mark
   whether it was paid by the company or personally (personal spend, especially
   pre-incorporation, is money owed back to the director — see the reference).
3. **Cross-check for gaps.** Walk `references/uk-ltd-compliance-and-costs.md`
   against what you found. For any expense a business like theirs almost
   certainly incurred but you have NO receipt for, FLAG it as a question
   ("I can't find a receipt for the company incorporation fee, did you pay that,
   and on which card?"). Do not silently omit it.
4. **Hand back a review pack, file nothing yet:** a categorised ledger
   (supplier, date, amount, category, receipt yes/no), a running "cost to get
   the business running so far" total, and the flagged-missing list. Only after
   the user confirms do you file each entry into the accounting tool, one at a
   time, verifying each read-back.

## Step 5 - Compliance calendar and reminders (never miss a filing)

For a UK limited company you also keep the user ahead of their statutory
deadlines. `scripts/compliance_calendar.py` computes the real dates from the
company's incorporation date (get it, plus the accounting reference date, from
the free Companies House record):

```
python3 scripts/compliance_calendar.py --incorporated 2026-05-20
```

It returns the confirmation statement, annual accounts, and Corporation Tax
deadlines (and flags the first-year Corporation Tax period split). See
`references/uk-ltd-compliance-and-costs.md` for what each obligation means.

Then set up reminders so a deadline can never sneak up: use your scheduled-task
ability to nudge the user ahead of each one (a sensible pattern is 60, 30, and 7
days before), with a message like *"Your confirmation statement is due on 2 June
2027. I've prepared what's needed, review it and file when you're ready."*
Propose the reminder schedule and let the user confirm it before you switch it
on. When each deadline nears, prepare the review-ready pack; the user always
does the actual submission.

## Step 6 - Quarter / year end

Reconcile against the accounting tool's bank feed, flag receipts that are missing,
and prepare a VAT / year-end summary in a document for the user (or their
accountant). The final submission to HMRC stays with the human — you get it
review-ready, you never file it. For a first year-end, recommend the user have a
one-off accountant sanity-check the accounts and Corporation Tax before they
submit; after year one it is largely repeatable.

## Handover - what I report back when a receipt is filed

Tell the user exactly and only what the verification proved — never dress it up:

- **What went in:** supplier, date, gross amount, the category you chose, and
  whether the receipt image is attached.
- **Proof it's really there:** the read-back from the accounting tool (the
  `verification` line for the FreeAgent route), plus the entry's URL.
- **If it did not verify:** say plainly it did NOT go in, paste the reason, and
  offer to retry — do not imply it's filed.
- **At quarter/year end:** the deliverable is a review-ready VAT / year-end
  summary document; the actual HMRC submission stays a human action in the
  accounting tool's own screen.

## Files

- `scripts/freeagent_connect.py` - OAuth connect wizard for the FreeAgent route (verified test before "connected").
- `scripts/freeagent_client.py` - scoped FreeAgent client (read + create-expense only; no destructive methods).
- `scripts/receipt_to_expense.py` - create an expense from extracted details, then verify it in FreeAgent.
- `scripts/compliance_calendar.py` - compute a UK Ltd's real statutory deadlines (confirmation statement, accounts, Corporation Tax) from its incorporation date; drives the reminders.
- `references/uk-ltd-compliance-and-costs.md` - what each filing obligation means, plus the typical-startup-costs checklist for flagging missing expenses.
- For QuickBooks: it is a connection now. `delegent-connect list`, then `delegent-connect exec --tool QUICKBOOKS_...` per the connected-services skill. Never a hand-built client.
- For another API-capable tool: connect + drive it via your general API ability (`api-integration-builder`, `core-permissions-and-credentials`) — no bespoke scripts needed here.
- Shared: `../../_shared/credential_store.py` (encrypted store), `../../_shared/oauth2.py` (OAuth base).
