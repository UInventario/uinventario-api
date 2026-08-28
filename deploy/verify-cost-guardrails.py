#!/usr/bin/env python3
"""Validate the versioned UIN-161 cost-control contract."""

from __future__ import annotations

import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_json(relative_path: str):
    with (ROOT / relative_path).open(encoding="utf-8-sig") as source:
        return json.load(source)


def require_contains(relative_path: str, fragments: list[str]) -> None:
    content = (ROOT / relative_path).read_text(encoding="utf-8-sig")
    missing = [fragment for fragment in fragments if fragment not in content]
    if missing:
        fail(f"{relative_path} is missing cost controls: {missing}")


def validate_artifact_policy(environment: str, age: str, keep_count: int) -> None:
    policies = read_json(f"deploy/artifact-cleanup-{environment}.json")
    delete = next((item for item in policies if item["action"]["type"] == "Delete"), None)
    keep = next((item for item in policies if item["action"]["type"] == "Keep"), None)
    if not delete or delete.get("condition") != {"tagState": "any", "olderThan": age}:
        fail(f"Invalid Artifact Registry delete policy for {environment}.")
    if not keep or keep.get("mostRecentVersions", {}).get("keepCount") != keep_count:
        fail(f"Invalid Artifact Registry rollback floor for {environment}.")


def validate_lifecycle(environment: str, age: int) -> None:
    lifecycle = read_json(f"deploy/cloud-build-lifecycle-{environment}.json")
    rules = lifecycle.get("rule", [])
    if rules != [{"action": {"type": "Delete"}, "condition": {"age": age}}]:
        fail(f"Invalid Cloud Build source lifecycle for {environment}.")


def main() -> None:
    if len(sys.argv) != 1:
        fail("Usage: verify-cost-guardrails.py")
    validate_artifact_policy("dev", "30d", 10)
    validate_artifact_policy("prod", "180d", 30)
    validate_lifecycle("dev", 14)
    validate_lifecycle("prod", 35)
    require_contains(
        "deploy/cloud-run.sh",
        ["--min=0", "--max=3", "--cpu-throttling", "owner=uinventario"],
    )
    require_contains(
        "deploy/database-backup-jobs.sh",
        ["--tasks=1", "--parallelism=1", "owner=uinventario"],
    )
    require_contains(
        "deploy/configure-cost-guardrails.sh",
        [
            "--no-immutable-tags",
            "--no-dry-run",
            "--clear-soft-delete",
            "--public-access-prevention",
            "manage-budget.py apply",
        ],
    )
    print(
        json.dumps(
            {
                "check": "cost-guardrail-config",
                "budgetEnforcement": "alert-only",
                "status": "passed",
            }
        )
    )


if __name__ == "__main__":
    main()
