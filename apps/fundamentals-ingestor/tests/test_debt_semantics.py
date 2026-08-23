import unittest

from fundamentals_ingestor.edgar import DEBT_NONCURRENT_FACT_CONCEPTS, _fact_value


class DebtSemanticsTests(unittest.TestCase):
    def test_long_term_debt_total_is_not_noncurrent_component(self):
        rows = [
            {
                "concept": "us-gaap:DebtCurrent",
                "numeric_value": 20,
                "period_type": "instant",
                "fiscal_year": 2027,
                "fiscal_period": "Q1",
                "period_end": "2026-04-26",
            },
            {
                "concept": "us-gaap:LongTermDebt",
                "numeric_value": 100,
                "period_type": "instant",
                "fiscal_year": 2027,
                "fiscal_period": "Q1",
                "period_end": "2026-04-26",
            },
        ]

        self.assertNotIn("us-gaap:LongTermDebt", DEBT_NONCURRENT_FACT_CONCEPTS)
        self.assertIsNone(_fact_value(rows, DEBT_NONCURRENT_FACT_CONCEPTS, (2027, "Q1")))


if __name__ == "__main__":
    unittest.main()
