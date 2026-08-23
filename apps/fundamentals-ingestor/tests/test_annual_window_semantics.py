import unittest
from types import SimpleNamespace

from fundamentals_ingestor.main import _annual_window_is_safe


class AnnualWindowSemanticsTests(unittest.TestCase):
    def test_confirmed_history_growth_rejects_same_length_shift(self):
        existing = {2024, 2025}
        transient = [SimpleNamespace(fiscal_year=2025), SimpleNamespace(fiscal_year=2026)]

        self.assertFalse(_annual_window_is_safe(existing, transient, annual_periods_available=3))

    def test_confirmed_history_growth_accepts_complete_window(self):
        existing = {2024, 2025}
        complete = [
            SimpleNamespace(fiscal_year=2024),
            SimpleNamespace(fiscal_year=2025),
            SimpleNamespace(fiscal_year=2026),
        ]

        self.assertTrue(_annual_window_is_safe(existing, complete, annual_periods_available=3))


if __name__ == "__main__":
    unittest.main()
