# UK limited company: compliance calendar and the "what expenses am I missing" checklist

Generic reference for a UK private limited company. Use it to (a) explain the
real filing obligations and (b) cross-check a catch-up so you can FLAG expenses
the user probably incurred but for which no receipt has turned up. Nothing here
is a substitute for an accountant; it is a checklist to make the books complete
and to know when things are due.

## The statutory deadlines (compute the exact dates with compliance_calendar.py)

Run `python3 scripts/compliance_calendar.py --incorporated <YYYY-MM-DD>` to get
the company's real dates. In words:

- **Confirmation statement (Companies House), annual.** Confirms the registered
  details. Review period ends the day before the incorporation anniversary; due
  14 days after. Small filing fee.
- **Annual accounts (Companies House).** First set due 21 months after
  incorporation; then 9 months after each accounting reference date. A small or
  micro company can usually file the simpler micro-entity / small-company
  accounts.
- **Corporation Tax (HMRC).** Payment due 9 months and 1 day after the
  accounting period end; the CT600 return due 12 months after. If the first
  period is longer than 12 months (common in year one) HMRC splits it into TWO
  periods, so year one has two payments and two returns. This is exactly the
  kind of first-year wrinkle worth a one-off accountant check.
- **VAT.** Only once taxable turnover passes the registration threshold
  (£90,000 on a rolling 12-month basis as of 2024/25). Monitor; register when
  approaching it.
- **PAYE / payroll.** Only if the company pays a salary (e.g. a director's
  salary). If so, RTI submissions are due on or before each payday.
- **ICO data protection fee.** If the company processes personal data (most do),
  an annual fee to the ICO is due, typically in the region of £40 to £60 for a
  small business. Renews annually.

Human owns every submission. Prepare it review-ready; the director files it.

## Typical UK startup and running costs to look for (flag any with no receipt)

When doing a historical catch-up, walk this list against what is in the inbox
and the bank feed. For anything a business like this almost certainly paid for
but you cannot find, FLAG IT to the user ("I can't find a receipt for X, did you
pay for it, and if so on which card?") rather than silently omitting it.

**Formation and statutory**
- Company incorporation fee (Companies House, online).
- Confirmation statement fee (annual, once the first one is due).
- ICO data protection fee (annual).
- Registered office / business address service (if not using their own address).
- Accountancy or bookkeeping software / accountant fees.

**Banking and payments**
- Business bank account fees (some are free, e.g. Mettle).
- Payment processor fees (Stripe, PayPal, etc.).
- Foreign exchange / card fees on overseas purchases.

**Software, hosting and infrastructure (very common for a software business)**
- Domain registration and renewal.
- Web hosting / cloud infrastructure.
- AI / LLM inference and API usage.
- Developer platform and app-store fees (e.g. annual/one-off developer accounts).
- SaaS subscriptions (email, monitoring, analytics, secrets management, CI, etc.).
- Any per-user compute or serverless costs.

**Operating**
- Professional indemnity / business insurance (if held).
- Phone and mobile costs used for the business.
- Use-of-home allowance if working from home.
- Mileage / travel for business.
- Marketing, advertising, design, and content costs.
- Legal or professional advice.

**Money the director spent personally (important for a new company)**
- Costs paid on the director's personal card, especially BEFORE the company had
  its own bank account or inbox, are still the company's costs. Pre-incorporation
  costs incurred wholly for the business can generally be brought in (within
  seven years). Record these as expenses owed back to the director (or to the
  director's loan account), each with its receipt, so the director can be
  reimbursed and the true cost of getting the business running is captured.

## How to present a catch-up

Give the user a clear picture, not a data dump:
1. A categorised ledger of what you found (supplier, date, amount, category,
   receipt yes/no).
2. A running total: "cost to get the business running so far".
3. A short FLAGGED list: expenses this kind of business almost certainly has but
   for which you found no receipt, each phrased as a question for the user.
4. Nothing filed yet: this is for their review first. File into the accounting
   tool only once they confirm, one entry at a time, verifying each.
