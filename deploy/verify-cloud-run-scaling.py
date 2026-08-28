#!/usr/bin/env python3
import json
import shutil
import subprocess
import sys


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


if len(sys.argv) != 3:
    fail("Usage: verify-cloud-run-scaling.py <project-id> <region>")

project_id, region = sys.argv[1:]
gcloud = shutil.which("gcloud") or shutil.which("gcloud.cmd")
if not gcloud:
    fail("gcloud CLI is not available.")
raw = subprocess.check_output(
    [
        gcloud,
        "run",
        "services",
        "describe",
        "uinventario-api",
        f"--project={project_id}",
        f"--region={region}",
        "--format=json",
    ],
    text=True,
)
service = json.loads(raw)
template = service.get("spec", {}).get("template", {})
service_annotations = service.get("metadata", {}).get("annotations", {})
template_annotations = template.get("metadata", {}).get("annotations", {})
container_concurrency = template.get("spec", {}).get("containerConcurrency")

min_scale = service_annotations.get(
    "run.googleapis.com/minScale",
    template_annotations.get("autoscaling.knative.dev/minScale", "0"),
)
max_scale = service_annotations.get(
    "run.googleapis.com/maxScale",
    template_annotations.get("autoscaling.knative.dev/maxScale"),
)
if min_scale != "0":
    fail(f"Cloud Run minimum instances must be 0; got {min_scale!r}.")
if max_scale != "3":
    fail(f"Cloud Run maximum instances must be 3; got {max_scale!r}.")
if container_concurrency != 40:
    fail(f"Cloud Run containerConcurrency must be 40; got {container_concurrency!r}.")

print(
    json.dumps(
        {
            "check": "cloud-run-scaling",
            "minInstances": 0,
            "maxInstances": 3,
            "containerConcurrency": 40,
            "status": "passed",
        }
    )
)
