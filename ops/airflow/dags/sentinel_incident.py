"""Read-only Airflow view of the Sentinel incident workflow.

The controller still probes, classifies, pauses for a comment, and opens the
pull request. These tasks only follow that order. When CONTROLLER_URL is set
they GET /api/health. They never start a fix, merge a pull request, or send mail.
"""

from __future__ import annotations

import os
from datetime import datetime
from urllib.request import Request, urlopen

from airflow import DAG
from airflow.operators.python import PythonOperator

STEPS = (
    "probe",
    "classify",
    "notify",
    "diagnose_and_open_issue",
    "wait_for_owner_comment",
    "fix_after_comment",
    "verify",
    "open_pull_request",
    "pause",
)

ALLOWED_GET = "/api/health"


def run_step(step: str) -> str:
    if step not in STEPS:
        raise RuntimeError(f"Unknown workflow step: {step}")
    base = os.environ.get("CONTROLLER_URL", "").strip().rstrip("/")
    if not base:
        return f"{step}: controller url unset; no request sent"
    target = f"{base}{ALLOWED_GET}"
    request = Request(target, method="GET")
    with urlopen(request, timeout=5) as response:
        response.read(1024)
        status = response.status
    return f"{step}: read {ALLOWED_GET} HTTP {status}"


with DAG(
    dag_id="sentinel_incident",
    description="Show the Sentinel incident order. Does not remediate.",
    start_date=datetime(2026, 11, 14),
    schedule=None,
    catchup=False,
    is_paused_upon_creation=True,
) as dag:
    previous = None
    for step_name in STEPS:
        task = PythonOperator(
            task_id=step_name,
            python_callable=run_step,
            op_kwargs={"step": step_name},
        )
        if previous is not None:
            previous >> task
        previous = task
