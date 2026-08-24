from __future__ import annotations

import copy
import tempfile
import unittest
import uuid
from pathlib import Path

from ai_analysis_runner.checkpoint import CheckpointError, ResultCheckpointStore
from ai_analysis_runner.constants import ENGINE_COMMIT
from ai_analysis_runner.models import EngineOutput
from ai_analysis_runner.normalize import ResultValidationError, normalize_result, serialize_result, validate_result

from tests.helpers import final_state, output


class NormalizeTests(unittest.TestCase):
    def test_exact_v031_portfolio_headers_and_workflow_fields(self) -> None:
        result = normalize_result("AAPL", "2026-08-21", "2026-08-23T12:34:56.789Z", output())
        self.assertEqual(result["recommendation"], "BUY")
        self.assertEqual(result["executiveSummary"], "Strong setup.")
        self.assertEqual(result["investmentThesis"], "Durable growth.")
        self.assertEqual(result["priceTarget"], 225.5)
        self.assertEqual(result["timeHorizon"], "12 months")
        self.assertEqual(result["reports"]["researchManager"], "Research decision")
        self.assertEqual(result["reports"]["risk"]["neutral"], "Neutral case")
        self.assertEqual(result["engine"]["commit"], ENGINE_COMMIT)

    def test_nullable_sections_are_not_invented_from_nearby_headings(self) -> None:
        portfolio = "**Rating**: HOLD\n\n## Executive Summary\nDo not extract me.\n\n**Thesis**: Also not exact."
        result = normalize_result("MSFT", "2026-08-21", "2026-08-23T12:34:56Z", output(portfolio))
        self.assertIsNone(result["executiveSummary"])
        self.assertIsNone(result["investmentThesis"])
        self.assertIsNone(result["priceTarget"])
        self.assertIsNone(result["timeHorizon"])

    def test_multiline_exact_section_stops_at_next_exact_header(self) -> None:
        portfolio = "**Rating**: OVERWEIGHT\n\n**Executive Summary**: Line one\nLine two\n\n**Investment Thesis**: Thesis"
        result = normalize_result("NVDA", "2026-08-21", "2026-08-23T12:34:56Z", output(portfolio))
        self.assertEqual(result["executiveSummary"], "Line one\nLine two")
        self.assertEqual(result["investmentThesis"], "Thesis")

    def test_shape_enum_length_and_size_are_strict(self) -> None:
        result = normalize_result("AAPL", "2026-08-21", "2026-08-23T12:34:56Z", output())
        for mutation in ("extra", "bad_recommendation", "bad_commit", "oversize"):
            candidate = copy.deepcopy(result)
            if mutation == "extra":
                candidate["extra"] = True
            elif mutation == "bad_recommendation":
                candidate["recommendation"] = "STRONG BUY"
            elif mutation == "bad_commit":
                candidate["engine"]["commit"] = "f" * 40
            else:
                candidate["reports"]["marketAndTechnical"] = "x" * 120_001
            with self.subTest(mutation=mutation), self.assertRaises(ResultValidationError):
                validate_result(candidate)
        with self.assertRaisesRegex(ResultValidationError, "result_too_large"):
            validate_result(result, max_bytes=100)

    def test_recommendation_falls_back_to_exact_rating_header(self) -> None:
        portfolio = "**Rating**: BUY\n\n**Executive Summary**: Strong setup."
        result = normalize_result(
            "AAPL", "2026-08-21", "2026-08-23T12:34:56Z",
            EngineOutput(final_state(portfolio), "BUY: strong setup", "google", "gemini-3.1-flash-lite", "gemini-3.5-flash"),
        )
        self.assertEqual(result["recommendation"], "BUY")

    def test_recommendation_tolerant_token_only_on_known_words(self) -> None:
        portfolio = "**Rating**: Strong\n\n**Executive Summary**: Summary."
        result = normalize_result(
            "AAPL", "2026-08-21", "2026-08-23T12:34:56Z",
            EngineOutput(final_state(portfolio), "We recommend a BUY: strong setup", "google", "gemini-3.1-flash-lite", "gemini-3.5-flash"),
        )
        self.assertEqual(result["recommendation"], "BUY")

    def test_recommendation_rejects_when_no_known_token(self) -> None:
        portfolio = "**Rating**: Strong\n\n**Executive Summary**: Summary."
        with self.assertRaisesRegex(ResultValidationError, "recommendation"):
            normalize_result(
                "AAPL", "2026-08-21", "2026-08-23T12:34:56Z",
                EngineOutput(final_state(portfolio), "Strong momentum with solid fundamentals", "google", "gemini-3.1-flash-lite", "gemini-3.5-flash"),
            )

    def test_checkpoint_is_atomic_validated_and_subject_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = ResultCheckpointStore(Path(directory), 1_500_000)
            analysis_id = str(uuid.uuid4())
            result = normalize_result("AAPL", "2026-08-21", "2026-08-23T12:34:56Z", output())
            store.save(analysis_id, result)
            self.assertEqual(store.load(analysis_id, "AAPL", "2026-08-21"), result)
            path = Path(directory) / "pending-results" / f"{analysis_id}.json"
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(CheckpointError, "subject"):
                store.load(analysis_id, "MSFT", "2026-08-21")
            self.assertNotIn("NaN", serialize_result(result))
            store.delete(analysis_id)
            self.assertIsNone(store.load(analysis_id, "AAPL", "2026-08-21"))


if __name__ == "__main__":
    unittest.main()
