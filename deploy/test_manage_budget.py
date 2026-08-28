import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("manage-budget.py")
SPEC = importlib.util.spec_from_file_location("manage_budget", MODULE_PATH)
assert SPEC and SPEC.loader
manage_budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manage_budget)


class ManageBudgetTest(unittest.TestCase):
    def test_dev_budget_is_project_scoped_and_alert_only(self):
        budget = manage_budget.expected_budget("dev")
        self.assertEqual(
            budget["budgetFilter"]["projects"], ["projects/624020863656"]
        )
        self.assertEqual(budget["amount"]["specifiedAmount"]["units"], "5000")
        self.assertFalse(budget["notificationsRule"]["disableDefaultIamRecipients"])
        self.assertTrue(budget["notificationsRule"]["enableProjectLevelRecipients"])
        self.assertNotIn("pubsubTopic", budget["notificationsRule"])

    def test_prod_budget_has_actual_and_forecast_thresholds(self):
        budget = manage_budget.expected_budget("prod")
        self.assertEqual(budget["amount"]["specifiedAmount"]["units"], "15000")
        self.assertEqual(
            budget["thresholdRules"],
            [
                {"thresholdPercent": 0.5, "spendBasis": "CURRENT_SPEND"},
                {"thresholdPercent": 0.9, "spendBasis": "FORECASTED_SPEND"},
                {"thresholdPercent": 1.0, "spendBasis": "CURRENT_SPEND"},
            ],
        )

    def test_api_defaults_normalize_without_false_drift(self):
        budget = manage_budget.expected_budget("dev")
        budget["notificationsRule"].pop("disableDefaultIamRecipients")
        budget["budgetFilter"].pop("calendarPeriod")
        self.assertEqual(
            manage_budget.normalized_budget(budget),
            manage_budget.expected_budget("dev"),
        )


if __name__ == "__main__":
    unittest.main()
