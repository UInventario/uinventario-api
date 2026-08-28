#!/usr/bin/env python3
"""Create or verify the project-scoped, non-destructive monthly cost budget."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


CONFIG = {
    "dev": {
        "project_id": "software-inventario-dev",
        "project_number": "624020863656",
        "display_name": "UInventario Dev monthly guardrail",
        "amount": "5000",
    },
    "prod": {
        "project_id": "software-inventario-prod",
        "project_number": "356622377746",
        "display_name": "UInventario Prod monthly guardrail",
        "amount": "15000",
    },
}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def expected_budget(environment: str) -> dict[str, Any]:
    config = CONFIG[environment]
    return {
        "displayName": config["display_name"],
        "budgetFilter": {
            "projects": [f"projects/{config['project_number']}"],
            "creditTypesTreatment": "INCLUDE_ALL_CREDITS",
            "calendarPeriod": "MONTH",
        },
        "amount": {
            "specifiedAmount": {
                "currencyCode": "CLP",
                "units": config["amount"],
            }
        },
        "thresholdRules": [
            {"thresholdPercent": 0.5, "spendBasis": "CURRENT_SPEND"},
            {"thresholdPercent": 0.9, "spendBasis": "FORECASTED_SPEND"},
            {"thresholdPercent": 1.0, "spendBasis": "CURRENT_SPEND"},
        ],
        "notificationsRule": {
            "disableDefaultIamRecipients": False,
            "enableProjectLevelRecipients": True,
        },
    }


def normalized_budget(budget: dict[str, Any]) -> dict[str, Any]:
    budget_filter = budget.get("budgetFilter", {})
    amount = budget.get("amount", {}).get("specifiedAmount", {})
    notifications = budget.get("notificationsRule", {})
    return {
        "displayName": budget.get("displayName"),
        "budgetFilter": {
            "projects": budget_filter.get("projects", []),
            "creditTypesTreatment": budget_filter.get(
                "creditTypesTreatment", "INCLUDE_ALL_CREDITS"
            ),
            "calendarPeriod": budget_filter.get("calendarPeriod", "MONTH"),
        },
        "amount": {
            "specifiedAmount": {
                "currencyCode": amount.get("currencyCode"),
                "units": str(amount.get("units", "")),
            }
        },
        "thresholdRules": sorted(
            budget.get("thresholdRules", []), key=lambda rule: rule["thresholdPercent"]
        ),
        "notificationsRule": {
            "disableDefaultIamRecipients": notifications.get(
                "disableDefaultIamRecipients", False
            ),
            "enableProjectLevelRecipients": notifications.get(
                "enableProjectLevelRecipients", False
            ),
        },
    }


def run_gcloud(*args: str) -> str:
    gcloud = shutil.which("gcloud") or shutil.which("gcloud.cmd")
    if not gcloud:
        fail("gcloud CLI is not available.")
    return subprocess.check_output([gcloud, *args], text=True).strip()


def request_json(
    url: str,
    token: str,
    quota_project: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-goog-user-project": quota_project,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        fail(f"Billing Budget API returned HTTP {error.code}: {detail}")


def reconcile_budget(
    environment: str, mode: str, billing_account: str, token: str
) -> dict[str, Any]:
    config = CONFIG[environment]
    expected = expected_budget(environment)
    base_url = f"https://billingbudgets.googleapis.com/v1/{billing_account}/budgets"
    query = urllib.parse.urlencode(
        {"scope": f"projects/{config['project_number']}"}
    )
    budgets = request_json(
        f"{base_url}?{query}", token, config["project_id"]
    ).get("budgets", [])
    matches = [
        budget
        for budget in budgets
        if budget.get("displayName") == config["display_name"]
    ]
    if len(matches) > 1:
        fail(f"More than one managed budget exists for {environment}.")

    action = "verified"
    if not matches:
        if mode == "verify":
            fail(f"Managed budget is missing for {environment}.")
        budget = request_json(base_url, token, config["project_id"], "POST", expected)
        action = "created"
    else:
        budget = matches[0]
        if normalized_budget(budget) != expected:
            if mode == "verify":
                fail(f"Managed budget configuration drifted for {environment}.")
            update_mask = ",".join(expected.keys())
            patch_url = (
                f"https://billingbudgets.googleapis.com/v1/{budget['name']}?"
                + urllib.parse.urlencode({"updateMask": update_mask})
            )
            payload = {**expected, "name": budget["name"], "etag": budget.get("etag", "")}
            budget = request_json(
                patch_url, token, config["project_id"], "PATCH", payload
            )
            action = "updated"

    if normalized_budget(budget) != expected:
        fail(f"Managed budget could not be reconciled for {environment}.")
    return {
        "environment": environment,
        "project": config["project_id"],
        "monthlyBudget": {"currency": "CLP", "units": config["amount"]},
        "notifications": "billing IAM and project owners",
        "enforcement": "alert-only",
        "action": action,
    }


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in {"apply", "verify"} or sys.argv[2] not in CONFIG:
        fail("Usage: manage-budget.py <apply|verify> <dev|prod>")
    mode, environment = sys.argv[1:]
    project_id = CONFIG[environment]["project_id"]
    billing = json.loads(
        run_gcloud("billing", "projects", "describe", project_id, "--format=json")
    )
    billing_account = billing.get("billingAccountName")
    if not billing.get("billingEnabled") or not billing_account:
        fail(f"Billing is not enabled for {project_id}.")
    token = run_gcloud("auth", "print-access-token")
    result = reconcile_budget(environment, mode, billing_account, token)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
