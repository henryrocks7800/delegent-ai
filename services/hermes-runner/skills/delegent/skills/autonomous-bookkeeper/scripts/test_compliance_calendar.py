#!/usr/bin/env python3
"""Tests for the UK Ltd compliance calendar.

The decisive test checks the computed deadlines against the ACTUAL published
Companies House figures for a real company (incorporated 20 May 2026), so a
maths slip fails the build rather than a filing deadline in real life."""
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compliance_calendar as cc  # noqa: E402


class DateHelpers(unittest.TestCase):
    def test_add_months_clamps_day(self):
        self.assertEqual(cc.add_months(date(2026, 5, 31), 1), date(2026, 6, 30))
        self.assertEqual(cc.add_months(date(2026, 5, 20), 21), date(2028, 2, 20))

    def test_add_years(self):
        self.assertEqual(cc.add_years(date(2026, 5, 20), 1), date(2027, 5, 20))


class RealCompanyDates(unittest.TestCase):
    """Grounded against Companies House for a company incorporated 20 May 2026."""
    INC = date(2026, 5, 20)

    def test_default_ard(self):
        # First accounting reference date = last day of the anniversary month.
        self.assertEqual(cc.default_accounting_reference_date(self.INC), date(2027, 5, 31))

    def test_first_confirmation_statement_matches_companies_house(self):
        cs = cc.confirmation_statement(self.INC, 1)
        # Companies House: made-up-to 19 May 2027, due 2 June 2027.
        self.assertIn("2027-05-19", cs.covers)
        self.assertEqual(cs.due, "2027-06-02")
        self.assertEqual(cs.authority, "Companies House")

    def test_first_accounts_match_companies_house(self):
        acc = cc.first_accounts(self.INC, cc.default_accounting_reference_date(self.INC))
        # Companies House: made-up-to 31 May 2027, due 20 February 2028.
        self.assertIn("2027-05-31", acc.covers)
        self.assertEqual(acc.due, "2028-02-20")

    def test_corporation_tax_splits_the_long_first_year(self):
        ct = cc.corporation_tax(self.INC, cc.default_accounting_reference_date(self.INC))
        # Long first period -> two CT periods -> two payments + two returns.
        pays = [d for d in ct if d.key.startswith("corporation_tax_pay")]
        returns = [d for d in ct if d.key.startswith("corporation_tax_return")]
        self.assertEqual(len(pays), 2)
        self.assertEqual(len(returns), 2)
        # First period ends 19 May 2027; payment due 9m+1d later = 20 Feb 2028.
        self.assertEqual(pays[0].due, "2028-02-20")
        self.assertTrue(any("splits it into TWO" in d.note for d in ct))

    def test_build_calendar_is_sorted_and_covers_the_essentials(self):
        cal = cc.build_calendar(self.INC)
        dues = [d.due for d in cal]
        self.assertEqual(dues, sorted(dues), "calendar must be in date order")
        keys = {d.key for d in cal}
        self.assertIn("confirmation_statement_1", keys)
        self.assertIn("accounts_1", keys)
        self.assertTrue(any(k.startswith("corporation_tax") for k in keys))


class Reminders(unittest.TestCase):
    def test_upcoming_window(self):
        cal = cc.build_calendar(date(2026, 5, 20))
        # 60 days before the 2 June 2027 confirmation statement.
        soon = cc.upcoming(cal, date(2027, 4, 10), 60)
        self.assertTrue(any(d.key == "confirmation_statement_1" for d in soon))
        # Nothing is within 7 days in a quiet stretch.
        self.assertEqual(cc.upcoming(cal, date(2026, 8, 1), 7), [])

    def test_generic_reusable_for_any_company(self):
        # Not hardcoded to one company: a different incorporation date yields
        # correspondingly shifted deadlines. Incorporated 10 Jan 2024 -> first
        # review period ends 9 Jan 2025 -> confirmation statement due 23 Jan 2025.
        cs = cc.confirmation_statement(date(2024, 1, 10), 1)
        self.assertEqual(cs.due, "2025-01-23")


if __name__ == "__main__":
    unittest.main(verbosity=2)
