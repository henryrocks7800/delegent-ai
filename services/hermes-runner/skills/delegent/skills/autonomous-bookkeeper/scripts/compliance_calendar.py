#!/usr/bin/env python3
"""UK limited-company compliance calendar.

Given a company's incorporation date (and optionally its accounting reference
date), work out the real statutory deadlines a director must not miss:

  * Confirmation statement (Companies House) - annual.
  * Annual accounts (Companies House) - first set 21 months after
    incorporation, then 9 months after each accounting reference date.
  * Corporation Tax (HMRC) - payment 9 months + 1 day after the period end,
    return 12 months after the period end. Flags the first-year period split
    when the first period is longer than 12 months.

Pure and stdlib-only, so it runs identically in a scheduled reminder job and in
a chat turn, and is unit-tested against a real company's published dates. It
computes deadlines; it never files anything. Filing stays a human action after
the director reviews.

CLI:
  python3 compliance_calendar.py --incorporated 2026-05-20 [--ard 2027-05-31] \
      [--as-of 2026-07-23] [--within-days 60]
"""
from __future__ import annotations

import argparse
import calendar
import json
from dataclasses import dataclass, asdict
from datetime import date, timedelta


# --- date helpers (stdlib only; no dateutil) --------------------------------

def _last_day_of_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def add_months(d: date, months: int) -> date:
    """Add whole months, clamping the day to the target month's last day."""
    total = (d.year * 12 + (d.month - 1)) + months
    year, month = divmod(total, 12)
    month += 1
    day = min(d.day, _last_day_of_month(year, month))
    return date(year, month, day)


def add_years(d: date, years: int) -> date:
    return add_months(d, years * 12)


# --- model ------------------------------------------------------------------

@dataclass
class Deadline:
    key: str
    title: str
    authority: str          # "Companies House" | "HMRC"
    covers: str             # the period/subject in words
    due: str                # ISO date
    note: str = ""

    def days_until(self, as_of: date) -> int:
        return (date.fromisoformat(self.due) - as_of).days


def default_accounting_reference_date(incorporated: date) -> date:
    """Companies House sets the first ARD to the last day of the month of the
    first anniversary of incorporation (e.g. incorporated 20 May 2026 -> ARD
    31 May 2027)."""
    anniv = add_years(incorporated, 1)
    return date(anniv.year, anniv.month, _last_day_of_month(anniv.year, anniv.month))


def confirmation_statement(incorporated: date, review_year: int = 1) -> Deadline:
    """Confirmation statement for the Nth review period. The review period ends
    the day before the incorporation anniversary; the statement is due 14 days
    later."""
    review_end = add_years(incorporated, review_year) - timedelta(days=1)
    due = review_end + timedelta(days=14)
    return Deadline(
        key=f"confirmation_statement_{review_year}",
        title="Confirmation statement",
        authority="Companies House",
        covers=f"review period to {review_end.isoformat()}",
        due=due.isoformat(),
        note="Confirms the company's registered details are up to date. Filed online; small annual fee.",
    )


def first_accounts(incorporated: date, ard: date) -> Deadline:
    due = add_months(incorporated, 21)
    return Deadline(
        key="accounts_1",
        title="First annual accounts",
        authority="Companies House",
        covers=f"period to {ard.isoformat()}",
        due=due.isoformat(),
        note="First set is due 21 months after incorporation. A small company can usually file micro-entity or small-company accounts.",
    )


def subsequent_accounts(ard: date, year_offset: int) -> Deadline:
    period_end = add_years(ard, year_offset)
    due = add_months(period_end, 9)
    return Deadline(
        key=f"accounts_{year_offset + 1}",
        title="Annual accounts",
        authority="Companies House",
        covers=f"year to {period_end.isoformat()}",
        due=due.isoformat(),
        note="Due 9 months after the accounting reference date.",
    )


def corporation_tax(incorporated: date, ard: date) -> list[Deadline]:
    """CT for the first accounting period. If incorporation-to-ARD is longer
    than 12 months (the common first-year case), HMRC splits it into two CT
    periods; flag that so the director knows to expect two returns."""
    out: list[Deadline] = []
    span_days = (ard - incorporated).days
    if span_days > 366:
        p1_end = add_years(incorporated, 1) - timedelta(days=1)
        periods = [(incorporated, p1_end), (p1_end + timedelta(days=1), ard)]
        split_note = "First year is longer than 12 months, so HMRC splits it into TWO Corporation Tax periods (two CT600 returns). Worth a one-off accountant check."
    else:
        periods = [(incorporated, ard)]
        split_note = ""
    for i, (start, end) in enumerate(periods, start=1):
        pay_due = add_months(end, 9) + timedelta(days=1)
        file_due = add_months(end, 12)
        out.append(Deadline(
            key=f"corporation_tax_pay_{i}",
            title="Corporation Tax payment",
            authority="HMRC",
            covers=f"period {start.isoformat()} to {end.isoformat()}",
            due=pay_due.isoformat(),
            note=("Payment is due 9 months and 1 day after the period end. " + split_note).strip(),
        ))
        out.append(Deadline(
            key=f"corporation_tax_return_{i}",
            title="Corporation Tax return (CT600)",
            authority="HMRC",
            covers=f"period {start.isoformat()} to {end.isoformat()}",
            due=file_due.isoformat(),
            note="The return is due 12 months after the period end.",
        ))
    return out


def build_calendar(incorporated: date, ard: date | None = None, years_ahead: int = 3) -> list[Deadline]:
    ard = ard or default_accounting_reference_date(incorporated)
    deadlines: list[Deadline] = []
    for yr in range(1, years_ahead + 1):
        deadlines.append(confirmation_statement(incorporated, yr))
    deadlines.append(first_accounts(incorporated, ard))
    for off in range(1, years_ahead):
        deadlines.append(subsequent_accounts(ard, off))
    deadlines.extend(corporation_tax(incorporated, ard))
    deadlines.sort(key=lambda d: d.due)
    return deadlines


def upcoming(deadlines: list[Deadline], as_of: date, within_days: int) -> list[Deadline]:
    """Deadlines that fall between now and `within_days` ahead - the set a
    reminder job should nudge the user about."""
    return [d for d in deadlines if 0 <= d.days_until(as_of) <= within_days]


def _main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--incorporated", required=True)
    ap.add_argument("--ard", default=None)
    ap.add_argument("--as-of", default=None)
    ap.add_argument("--within-days", type=int, default=None)
    args = ap.parse_args()
    inc = date.fromisoformat(args.incorporated)
    ard = date.fromisoformat(args.ard) if args.ard else None
    cal = build_calendar(inc, ard)
    if args.within_days is not None:
        as_of = date.fromisoformat(args.as_of) if args.as_of else date.fromisoformat("2026-01-01")
        cal = upcoming(cal, as_of, args.within_days)
    print(json.dumps([asdict(d) for d in cal], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
