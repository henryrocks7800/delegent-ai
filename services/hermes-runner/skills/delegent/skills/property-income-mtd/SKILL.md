---
name: property-income-mtd
title: Landlord Tax And Making Tax Digital (MTD)
version: 1.0.0
category: finance
risk_level: high
description: "Use to get a landlord's property income and expenses into Making Tax Digital shape: digital records per property, the cumulative quarterly figures, and the deadlines. Prepares the numbers for the user's MTD software or accountant; never files anything with HMRC."
activation_phrases:
  - "making tax digital"
  - "MTD"
  - "landlord tax"
  - "rental income"
  - "property income"
  - "quarterly update"
  - "my rental properties"
requires_human_approval: true
delegent_safe: true
---

# Landlord Tax And Making Tax Digital (MTD)

## When to use this skill

Use this skill when the user asks for:

- They rent out property and want their records ready for Making Tax Digital.
- They need the cumulative income and expense figures for a quarterly update.
- They want to know whether MTD applies to them yet, and by when.
- They want a year's property records tidied before handing them to an accountant.

Do not use this skill for company accounts. MTD for Income Tax applies to
individuals and sole traders. A landlord who holds property through a limited
company files company accounts and a corporation tax return instead, which is a
different job entirely.

## The one boundary that matters

**You prepare the numbers. You never file them.**

Quarterly updates and the final declaration can only reach HMRC through
software HMRC has recognised for Making Tax Digital. Delegent is not that
software and does not connect to HMRC. What you produce is the figures, the
records behind them, and a clear summary the user keys into their own MTD
software or hands to their accountant.

Say this plainly the first time the user asks. Someone who thinks their tax has
been filed when it has not is the worst outcome this skill can produce, and a
missed deadline earns them a penalty point.

## Non-negotiable safety rules

**Arithmetic goes through code, never through your head.** On 2026-08-02 two
frontier models were given three invoices (450 plus VAT at 20%, 620 zero-rated,
480 plus VAT at 20%) and both produced a confidently wrong total (1596 and 1550
against the correct 1736). A wrong figure in someone's books or tax numbers is
the worst mistake this skill can make. So: any sum, VAT calculation, total,
proration, or percentage MUST be computed with the code_execution tool (a
three-line Python expression is enough), and the reply should show the working,
not just the answer. Mental arithmetic is acceptable only for restating a number
that already appears verbatim in a document or tool result.


- Do not claim a third-party integration is live until you have verified it.
- Do not ask for personal passwords where an API key, OAuth flow, service account, or scoped token is safer.
- Do not store secrets in chat. Tell the user where to place keys securely.
- Do not make payments, sign contracts, submit legal/official filings, or send sensitive external messages without explicit user confirmation.
- Do not give regulated advice as final professional advice. For legal, tax, accounting, medical, financial, employment, or property compliance matters, prepare drafts and workflows for human review.
- If you are blocked by a sign-up, payment, identity check, CAPTCHA, or human-only approval step, stop and give the user exact instructions.
- Never tell the user a figure has reached HMRC. You have no route to HMRC.
- Never guess at a number. An unknown figure stays visibly unknown and goes on the open-questions list.
- Flag anything with a tax judgement in it (what counts as a repair, what share of a jointly held property is theirs, how finance costs are treated) for their accountant rather than deciding it yourself.

## Before you ask anything: check what you already have

The user may have connected their bank, accounting tool or cloud storage on the
Connections screen, which happens in their browser where you cannot see it. Run
both of these and actually read the output before asking them to fetch anything:

- `delegent-connect list` for services they signed into with their own account.
- `delegent-keys list` for credentials they typed in themselves.

If a bank feed or a cloud folder of statements is already there, use it. Asking
a landlord to dig out twelve months of statements they already connected is the
fastest way to lose them.

## Intake questions

Ask only what is needed, and stop asking once you can start. Start with:

- How many properties, and are any of them jointly owned? If so, what is your share?
- Roughly what is the total rent across them for the year, and do you have any self-employment income as well?
- Which tax year are we working on, and which quarter?
- Where are the records now: bank statements, a spreadsheet, an accounting tool, a shoebox of receipts?
- Do you already have MTD software or an accountant, and if so, which?

## Who has to do this, and when

MTD for Income Tax phases in by qualifying income. Check the user against this
before doing anything else, because a landlord under the threshold has no
quarterly obligation yet and should not be pushed into one.

| From | Applies if qualifying income was over |
|---|---|
| 6 April 2026 | £50,000 |
| 6 April 2027 | £30,000 |
| 6 April 2028 | £20,000 |

Qualifying income is gross, before expenses, and combines:

- UK property rental income
- Furnished holiday lets
- Foreign property income
- Self-employment turnover

It does **not** include employment (PAYE) income, pensions, dividends,
partnership income, or savings interest. A landlord with £40,000 of rent and a
£60,000 salary is not in scope on the salary.

The threshold is tested against an earlier tax year's figures, so if the user is
close to a boundary, tell them it is worth confirming with HMRC or their
accountant rather than assuming.

## The quarterly cycle

Updates are **cumulative from the start of the tax year**, not just that
quarter. Quarter three covers 6 April to 5 January, not October to January. This
is the single most common thing to get wrong.

| Period covered | Due by |
|---|---|
| 6 April to 5 July | 7 August |
| 6 April to 5 October | 7 November |
| 6 April to 5 January | 7 February |
| 6 April to 5 April | 7 May |

A quarterly update is **not** a tax return. No accounting or tax adjustments are
needed before it goes in: no capital allowances, no private-use restriction, no
finance-cost adjustment. Those happen once, at the final declaration. Do not let
the user agonise over an adjustment that does not belong in a quarterly figure.

The **final declaration** is due by 31 January after the tax year ends. It pulls
in everything else the person is taxed on (pensions, savings interest, dividends,
capital gains, gift aid) and it also has to go through MTD software. Flag this
early, because a landlord who has only ever used HMRC's online filing service
will find that route closed to them.

Late updates earn penalty points under a points-based system starting in
2027-28. Four points brings a £200 penalty, and £200 again for each further
miss. Use that to explain why the dates matter, not to frighten anybody.

## Categories to sort into

Keep one set of records **per property**, then total them. HMRC receives the
summary, not the individual records, but the individual records have to exist
digitally and be kept.

Income:

- Rent received
- Any other property income (for example a charge for parking or furniture)

Expenses, using the standard property boxes:

- Rent, rates, insurance and ground rents
- Property repairs and maintenance
- Loan interest and other financial costs
- Legal, management and other professional fees
- Costs of services provided, including wages
- Other allowable property expenses

Two traps worth naming when you see them, both for the accountant rather than
for you to settle:

- **Repair or improvement.** Replacing a broken boiler with a like-for-like one
  is usually a repair. Putting in a new extension is not. If it looks like an
  improvement, park it and say why.
- **Finance costs on residential lets.** Mortgage interest on a residential
  buy-to-let is not deducted the way other expenses are; it is handled as a
  basic-rate reduction at the final declaration. Record it in its own category
  and leave the treatment to their accountant.

## Execution playbook

Follow this sequence:

1. Run `delegent-connect list` and `delegent-keys list` and use what is already there.
2. Establish scope: properties, ownership shares, tax year, quarter, and whether MTD applies to them yet.
3. Gather the source records. Bank statements, invoices, agent statements, receipts from Files.
4. Build one digital record set per property, one row per transaction, with date, amount, category, property and a pointer to the underlying document.
5. Total each category cumulatively from 6 April to the end of the quarter in question.
6. Apply the user's ownership share on any jointly held property, and show the share you used.
7. Produce the quarterly summary: per property and combined, with every category listed even where it is zero.
8. List every open question and every transaction you could not categorise, with the reason.
9. Tell the user exactly where the figures go: their MTD software or their accountant, and by which date.
10. Save the working file and the summary to Files so the record is theirs and is kept.

## Verification checklist

Before telling the user the work is complete, verify:

- Every figure traces to a source document, and nothing was estimated.
- The period really does run from 6 April, not from the start of the quarter.
- Each property is recorded separately and the ownership share is stated.
- Income and expense categories match the standard property boxes above.
- Uncategorised transactions are listed rather than quietly dropped or lumped into "other".
- The summary states plainly that nothing has been sent to HMRC and names who has to send it.
- The relevant deadline is on the summary in full.
- The totals on the combined summary equal the sum of the per-property sheets.

## Deliverables

Return one or more of:

- A per-property record set covering the period
- A cumulative quarterly summary, per property and combined
- A list of open questions and uncategorised items
- A short note of the deadline and who has to act on it

## Handover template

```text
What I did:
- ...

Period covered:
- 6 April YYYY to D Month YYYY (cumulative)

Figures, per property and combined:
- ...

What I could not categorise:
- ...

Evidence:
- ...

Files / systems touched:
- ...

What still needs your approval:
- These figures have NOT been sent to HMRC. Delegent cannot file them.
  They need to go into your MTD software or to your accountant by DATE.

Next recommended step:
- ...
```

## Related skills

- autonomous-bookkeeper
- spreadsheet-excel
- file-workspace-manager
- pdf-document-creation
