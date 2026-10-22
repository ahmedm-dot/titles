"""Offline tests for auto_apply: a fake v4 client stands in for Browser Use Cloud."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from auto_apply.cli import _read_jobs, build_parser, format_report
from auto_apply.prompts import OUTPUT_SCHEMA, build_apply_task
from auto_apply.runner import ApplyConfig, apply_to_jobs, parse_output

REPORT = {
    "status": "ready_to_submit",
    "job": {"title": "Data Analyst", "company": "Acme", "location": "Remote",
            "url": "https://jobs.example/1", "ats_platform": "Greenhouse"},
    "match": {"score": 78, "matched_skills": ["SQL"], "missing_keywords": ["dbt"],
              "summary": "Strong SQL, no dbt."},
    "fields_filled": [{"field": "Resume", "value": "cv.pdf", "source": "cv"}],
    "unanswered_required_questions": [],
    "confirmation": "",
    "notes": "",
}


class FakeRuns:
    def __init__(self, reports):
        self.reports = list(reports)
        self.created = []

    async def create(self, task, **kw):
        self.created.append({"task": task, **kw})
        n = len(self.created)
        return SimpleNamespace(id=f"run-{n}")

    async def wait_for_completion(self, run_id, timeout):
        rep = self.reports.pop(0)
        return SimpleNamespace(
            id=run_id, session_id="sess-1",
            status=SimpleNamespace(value="completed" if rep is not None else "failed"),
            output=rep, result=None, error=None if rep is not None else "boom",
            total_cost_usd="0.40",
        )

    async def cancel(self, run_id):
        pass


class FakeWorkspaces:
    async def create(self, name):
        return SimpleNamespace(id="ws-1")

    async def upload(self, ws_id, path):
        return [SimpleNamespace(id="file-1")]


def fake_client(reports):
    return SimpleNamespace(runs=FakeRuns(reports), workspaces=FakeWorkspaces())


@pytest.fixture
def cv(tmp_path):
    p = tmp_path / "cv.pdf"
    p.write_bytes(b"%PDF-1.4 fake")
    return p


def run(coro):
    return asyncio.run(coro)


def test_dry_run_never_submits(cv):
    client = fake_client([REPORT])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client))
    assert rec["status"] == "ready_to_submit"
    assert len(client.runs.created) == 1
    first = client.runs.created[0]
    assert "DO NOT click the final submit" in first["task"]
    assert first["attached_file_ids"] == ["file-1"] and first["workspace_id"] == "ws-1"
    assert first["output_schema"] is OUTPUT_SCHEMA
    assert "keep_alive" not in first


def test_review_approved_submits_in_same_session(cv):
    submitted = {**REPORT, "status": "submitted", "confirmation": "Ref 42", "match": {}}
    client = fake_client([REPORT, submitted])

    async def yes(report):
        return True

    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="review"),
                              client=client, confirm=yes))
    assert rec["status"] == "submitted"
    assert rec["cost_usd"] == "0.80"
    assert client.runs.created[0]["keep_alive"] == 600
    assert client.runs.created[1]["session_id"] == "sess-1"
    assert rec["report"]["confirmation"] == "Ref 42"


def test_review_declined(cv):
    client = fake_client([REPORT])

    async def no(report):
        return False

    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="review"),
                              client=client, confirm=no))
    assert rec["status"] == "declined_by_user"
    assert len(client.runs.created) == 1


def test_failed_run_is_recorded_not_raised(cv):
    client = fake_client([None])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="auto"), client=client))
    assert rec["status"] == "failed" and rec["error"] == "boom"


def test_auto_mode_prompt_allows_submit():
    task = build_apply_task("https://x", "cv.pdf", {"notice_period": "2 weeks"}, "auto")
    assert "submit the application" in task and "2 weeks" in task


def test_parse_output_falls_back_to_json_result():
    r = SimpleNamespace(output=None, result=json.dumps(REPORT))
    assert parse_output(r)["status"] == "ready_to_submit"
    assert parse_output(SimpleNamespace(output=None, result="not json")) is None


def test_jobs_are_deduplicated(tmp_path):
    f = tmp_path / "jobs.txt"
    f.write_text("# c\nhttps://a\n\nhttps://b\nhttps://a\n")
    args = build_parser().parse_args(["--cv", "x", "--job", "https://b", "--jobs-file", str(f)])
    assert _read_jobs(args) == ["https://b", "https://a"]


def test_format_report_shows_gaps():
    out = format_report({"job_url": "u", "status": "needs_user_input", "cost_usd": "1",
                         "report": {**REPORT, "unanswered_required_questions":
                                    [{"question": "Clearance?", "reason": "not in CV"}]}})
    assert "NEEDS INPUT: Clearance?" in out and "78/100" in out
