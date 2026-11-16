"""Table-driven tests for the tiered-action classifier - the testable heart of
the Operations Manager. No network, no credentials; pure function under test."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load():
    spec = importlib.util.spec_from_file_location("tiered_action", HERE / "tiered_action.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ta = _load()

# (description, expected_tier, expected_confirmation)
SAFE_CASES = [
    ("Add a task to call the accountant tomorrow", "safe", "none"),
    ("Update my list with the three follow-ups", "safe", "none"),
    ("Draft a reply to the supplier about the late delivery", "safe", "none"),
    ("Draft an email to the landlord and leave it in drafts", "safe", "none"),
    ("Add a calendar hold for the dentist on Friday", "safe", "none"),
    ("Block time on Thursday morning for deep work", "safe", "none"),
    ("Summarise my inbox from this morning", "safe", "none"),
    ("Read the latest message and tell me what it says", "safe", "none"),
    ("Tick off the task I already finished", "safe", "none"),
    ("Make a note to follow up next week", "safe", "none"),
    ("Add an event to my calendar for the team sync", "safe", "none"),
    ("Prioritise the list so the urgent ones are on top", "safe", "none"),
]

MEDIUM_CASES = [
    ("Fill in the contact form on their website", "medium", "confirm"),
    ("Fill out the online application form", "medium", "confirm"),
    ("Submit the request through the web form", "medium", "confirm"),
    ("Register on the supplier portal", "medium", "confirm"),
    ("Sign up for the newsletter on their site", "medium", "confirm"),
    ("Book an appointment on the clinic website", "medium", "confirm"),
    ("Request a quote through their online form", "medium", "confirm"),
    ("Send the email I drafted to the client", "medium", "confirm"),
    ("Reply to the customer and send it", "medium", "confirm"),
    ("Email them the meeting notes", "medium", "confirm"),
    ("Fire off the follow-up message", "medium", "confirm"),
    ("", "medium", "confirm"),  # empty -> over-confirm, never silently safe
    ("Do the thing we discussed", "medium", "confirm"),  # unmapped -> over-confirm
]

DANGEROUS_CASES = [
    ("Pay the electricity invoice", "dangerous", "hard-confirm"),
    ("Buy the office chair from Amazon", "dangerous", "hard-confirm"),
    ("Complete the checkout for the order", "dangerous", "hard-confirm"),
    ("Place the order for the supplies", "dangerous", "hard-confirm"),
    ("Subscribe to the premium plan", "dangerous", "hard-confirm"),
    ("Renew the annual subscription", "dangerous", "hard-confirm"),
    ("Transfer 200 pounds to the contractor", "dangerous", "hard-confirm"),
    ("Send money to the supplier", "dangerous", "hard-confirm"),
    ("Settle the invoice with the card on file", "dangerous", "hard-confirm"),
    ("Enter the credit card details to finish booking", "dangerous", "hard-confirm"),
    ("Type in the card number and CVV", "dangerous", "hard-confirm"),
    ("Log in to the bank with my password", "dangerous", "hard-confirm"),
    ("Sign in on my behalf using my credentials", "dangerous", "hard-confirm"),
    ("Enter the one-time code to authenticate", "dangerous", "hard-confirm"),
    ("Top up the account balance", "dangerous", "hard-confirm"),
    # Mixed: a form-fill that ALSO enters payment must be dangerous, not medium.
    ("Fill in the checkout form with my card details", "dangerous", "hard-confirm"),
    ("Fill out the form and pay the deposit", "dangerous", "hard-confirm"),
]


class ClassifierTests(unittest.TestCase):
    def _check(self, cases):
        for desc, tier, confirm in cases:
            with self.subTest(desc=desc):
                out = ta.classify_action(desc)
                self.assertEqual(out["tier"], tier, f"{desc!r} -> {out}")
                self.assertEqual(out["confirmation"], confirm, f"{desc!r} -> {out}")
                self.assertIn("reason", out)
                self.assertTrue(out["reason"])

    def test_safe(self):
        self._check(SAFE_CASES)

    def test_medium(self):
        self._check(MEDIUM_CASES)

    def test_dangerous(self):
        self._check(DANGEROUS_CASES)

    def test_dangerous_is_always_hard_confirm(self):
        # Every dangerous result must demand hard-confirm (never autonomous).
        for desc, _, _ in DANGEROUS_CASES:
            out = ta.classify_action(desc)
            self.assertEqual(out["tier"], "dangerous")
            self.assertEqual(out["confirmation"], "hard-confirm")

    def test_most_dangerous_wins(self):
        # When money/credential signals co-occur with a form, dangerous wins.
        out = ta.classify_action("fill in the form and pay with my credit card")
        self.assertEqual(out["tier"], "dangerous")
        self.assertIn("spends-money", out["signals"])

    def test_unknown_defaults_to_at_least_confirm(self):
        # The classifier must never return "safe" for something it cannot map.
        for desc in ["", "   ", "blah blah unknown verb noun", "frobnicate the widget"]:
            out = ta.classify_action(desc)
            self.assertNotEqual(out["tier"], "safe", f"{desc!r} -> {out}")
            self.assertIn(out["confirmation"], ("confirm", "hard-confirm"))

    def test_confirmation_matches_tier(self):
        # The tier -> confirmation mapping is the single source of truth.
        mapping = {"safe": "none", "medium": "confirm", "dangerous": "hard-confirm"}
        for desc, _, _ in SAFE_CASES + MEDIUM_CASES + DANGEROUS_CASES:
            out = ta.classify_action(desc)
            self.assertEqual(out["confirmation"], mapping[out["tier"]])

    def test_drafting_is_safe_but_sending_is_not(self):
        # The light-touch line: a draft is safe, but sending reaches an outside
        # party and must be at least confirmed.
        self.assertEqual(ta.classify_action("draft an email to the client")["tier"], "safe")
        self.assertEqual(ta.classify_action("send the email to the client")["tier"], "medium")

    def test_output_shape(self):
        out = ta.classify_action("pay the invoice")
        self.assertEqual(set(out.keys()), {"tier", "confirmation", "reason", "signals"})
        self.assertIsInstance(out["signals"], list)


if __name__ == "__main__":
    unittest.main(verbosity=2)
