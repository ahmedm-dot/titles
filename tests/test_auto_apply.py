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


class FakeSessions:
    async def cost(self, session_id):
        return SimpleNamespace(total_cost_usd="0.50", llm_cost_usd="0.30", browser_cost_usd="0.05",
                               proxy_cost_usd="0.15", search_cost_usd="0")


class FakeBrowsers:
    def __init__(self):
        self.stopped = []

    async def list(self, agent_session_id):
        status = "stopped" if agent_session_id in self.stopped else "active"
        return SimpleNamespace(items=[SimpleNamespace(id=f"br-{agent_session_id}",
                                                      status=SimpleNamespace(value=status))])

    async def stop(self, browser_id):
        self.stopped.append(browser_id.removeprefix("br-"))
        return SimpleNamespace(status=SimpleNamespace(value="stopped"))


def fake_client(reports):
    return SimpleNamespace(runs=FakeRuns(reports), workspaces=FakeWorkspaces(), sessions=FakeSessions(),
                           browsers=FakeBrowsers())


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
    # Both runs share one session, so its cost (LLM + browser + proxy) counts once.
    assert rec["cost_usd"] == "0.50"
    assert rec["cost_breakdown"] == {"llm": "0.30", "browser": "0.05", "proxy": "0.15", "search": "0"}
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


def test_failed_upload_is_retried_in_same_session(cv):
    failed = {**REPORT, "status": "needs_user_input", "cv_upload": "failed"}
    fixed = {**REPORT, "status": "submitted", "cv_upload": "uploaded", "confirmation": "ok"}
    client = fake_client([failed, failed, fixed])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="auto"), client=client))
    assert rec["status"] == "submitted" and rec["upload_retries"] == 2
    # First retry stays in the session; the last one starts over in a fresh browser.
    assert [c.get("session_id") for c in client.runs.created] == [None, "sess-1", None]
    assert "upload failed" in client.runs.created[1]["task"]
    assert "submit the application" in client.runs.created[1]["task"]
    assert client.runs.created[2]["workspace_id"] == "ws-1"


def test_upload_retries_are_capped(cv):
    failed = {**REPORT, "status": "needs_user_input", "cv_upload": "failed"}
    client = fake_client([failed, failed, failed])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv,
                              ApplyConfig(mode="auto", upload_retries=2), client=client))
    assert rec["status"] == "needs_user_input" and len(client.runs.created) == 3


def test_successful_upload_is_not_retried(cv):
    client = fake_client([{**REPORT, "cv_upload": "uploaded"}])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client))
    assert rec["upload_retries"] == 0 and len(client.runs.created) == 1


def test_closed_job_is_not_retried_for_upload(cv):
    client = fake_client([{**REPORT, "status": "job_closed", "cv_upload": "failed"}])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="auto"), client=client))
    assert rec["status"] == "job_closed" and len(client.runs.created) == 1


def test_fresh_browser_retry_adds_its_session_cost(cv):
    failed = {**REPORT, "status": "needs_user_input", "cv_upload": "failed"}
    client = fake_client([failed, failed, {**REPORT, "status": "submitted", "cv_upload": "uploaded"}])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="auto"), client=client))
    assert rec["cost_usd"] == "1.00"  # original session + the fresh-browser session


def test_browsers_are_closed_before_cost_is_read(cv):
    client = fake_client([REPORT])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client))
    assert client.browsers.stopped == ["sess-1"]
    assert rec["cost_final"] is True


def test_variant_b_renders_template_and_enables_agentmail(cv):
    client = fake_client([REPORT])
    cfg = ApplyConfig(mode="dry-run", prompt_variant="b", cv_text="Ahmed Mamdouh, Product Manager",
                      answers={"notice_period": "Immediately"})
    run(apply_to_jobs(["https://jobs.example/1"], cv, cfg, client=client))
    sent = client.runs.created[0]
    task = sent["task"]
    assert sent["agentmail"] is True
    assert "{{" not in task and "https://jobs.example/1" in task
    assert "DO NOT GIVE UP EARLY" in task and "Ahmed Mamdouh, Product Manager" in task
    assert "AgentMail inbox" in task and '"Immediately"' in task
    assert task.count("TEST-MODE OVERRIDE") == 2  # dry-run: never submit


def test_variant_a_does_not_enable_agentmail(cv):
    client = fake_client([REPORT])
    run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client))
    assert "agentmail" not in client.runs.created[0]


def test_ab_summary_counts():
    from auto_apply.ab_test import summarize
    base = {"model": None, "started_at": "2026-10-22T12:00:00+00:00",
            "finished_at": "2026-10-22T12:03:00+00:00", "cost_usd": "0.05"}
    a = [{**base, "status": "ready_to_submit", "report": {**REPORT, "cv_upload": "uploaded"}}]
    b = [{**base, "status": "needs_user_input", "report": {**REPORT, "cv_upload": "failed"}}]
    md = summarize(["https://jobs.example/1"], a, b)
    assert "| Reached final submit step | 1/1 | 0/1 |" in md
    assert "| CV attached | 1/1 | 0/1 |" in md


def test_split_gives_each_job_to_exactly_one_variant():
    from auto_apply.ab_test import split_jobs
    jobs = [f"https://jobs.example/{i}" for i in range(8)]
    a, b = split_jobs(jobs, seed=1)
    assert len(a) == len(b) == 4 and not set(a) & set(b) and set(a) | set(b) == set(jobs)
    assert split_jobs(jobs, seed=1) == (a, b)  # reproducible


def test_variant_b_with_fixed_email_skips_agentmail(cv):
    client = fake_client([REPORT])
    cfg = ApplyConfig(mode="auto", prompt_variant="b", application_email="me@example.com")
    run(apply_to_jobs(["https://jobs.example/1"], cv, cfg, client=client))
    sent = client.runs.created[0]
    assert "agentmail" not in sent and "me@example.com" in sent["task"]
    assert "AgentMail" not in sent["task"] and "TEST-MODE OVERRIDE" not in sent["task"]


def test_account_password_goes_only_into_a_secret_binding(cv):
    client = fake_client([REPORT])
    cfg = ApplyConfig(mode="auto", account_password="S3cret!pw")
    run(apply_to_jobs(["https://acme.wd5.myworkdayjobs.com/careers/job/X"], cv, cfg, client=client))
    sent = client.runs.created[0]
    assert "S3cret!pw" not in sent["task"] and "account_password" in sent["task"]
    [b] = sent["secret_bindings"]
    assert b["source"]["value"] == "S3cret!pw" and b["allowedDomains"] == ["acme.wd5.myworkdayjobs.com"]
    assert sent["keep_alive"] == 900


def test_waiting_for_verification_keeps_the_browser_open(cv):
    client = fake_client([{**REPORT, "status": "waiting_for_verification", "cv_upload": "uploaded"}])
    cfg = ApplyConfig(mode="auto", account_password="pw")
    [rec] = run(apply_to_jobs(["https://acme.wd5.myworkdayjobs.com/x"], cv, cfg, client=client))
    assert rec["status"] == "waiting_for_verification"
    assert client.browsers.stopped == [] and rec["cost_final"] is False


def test_resume_after_verification_continues_the_same_session():
    from auto_apply.runner import resume_after_verification
    client = fake_client([{**REPORT, "status": "submitted"}])
    cfg = ApplyConfig(mode="auto", account_password="pw")
    rec = run(resume_after_verification(client, "sess-1", "https://acme.wd5.myworkdayjobs.com/x", "cv.pdf", cfg))
    sent = client.runs.created[0]
    assert rec["status"] == "submitted" and sent["session_id"] == "sess-1"
    assert "verified the email" in sent["task"] and sent["secret_bindings"][0]["alias"] == "account_password"
    assert client.browsers.stopped == ["sess-1"]  # closed once the job is done


def test_hold_keeps_browser_open_when_answers_are_missing(cv):
    client = fake_client([{**REPORT, "status": "needs_user_input", "cv_upload": "uploaded"}])
    cfg = ApplyConfig(mode="dry-run", hold_for_followup=True)
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, cfg, client=client))
    assert client.runs.created[0]["keep_alive"] == 900
    assert client.browsers.stopped == [] and rec["cost_final"] is False


def test_without_hold_the_browser_is_released(cv):
    client = fake_client([{**REPORT, "status": "needs_user_input", "cv_upload": "uploaded"}])
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client))
    assert "keep_alive" not in client.runs.created[0] and client.browsers.stopped == ["sess-1"]


def test_continue_session_with_new_answers_finishes_the_same_form():
    from auto_apply.runner import continue_session
    client = fake_client([{**REPORT, "status": "submitted"}])
    cfg = ApplyConfig(mode="auto", answers={"relocation": "Yes"})
    rec = run(continue_session(client, "sess-1", "https://jobs.example/1", "cv.pdf", cfg))
    sent = client.runs.created[0]
    assert rec["status"] == "submitted" and sent["session_id"] == "sess-1"
    assert "answered the questions" in sent["task"] and '"relocation": "Yes"' in sent["task"]
    assert client.browsers.stopped == ["sess-1"]


def test_proxy_only_on_lever_by_default(cv):
    cfg = ApplyConfig(mode="dry-run", proxy_country="pl")
    assert cfg.browser_settings("https://jobs.lever.co/acme/123") == {"proxyCountryCode": "pl"}
    assert cfg.browser_settings("https://jobs.eu.lever.co/acme/123") == {"proxyCountryCode": "pl"}
    assert cfg.browser_settings("https://acme.wd5.myworkdayjobs.com/x") == {"proxyCountryCode": None}
    assert cfg.browser_settings("https://jobs.ashbyhq.com/acme/1") == {"proxyCountryCode": None}
    assert cfg.browser_settings("https://notlever.co.evil.com/x") == {"proxyCountryCode": None}
    everywhere = ApplyConfig(mode="dry-run", proxy_country="pl", proxy_everywhere=True)
    assert everywhere.browser_settings("https://jobs.ashbyhq.com/acme/1") == {"proxyCountryCode": "pl"}
    client = fake_client([REPORT])
    run(apply_to_jobs(["https://jobs.ashbyhq.com/acme/1"], cv, cfg, client=client))
    assert client.runs.created[0]["browser_settings"] == {"proxyCountryCode": None}


def test_cv_link_is_the_first_upload_fallback(cv):
    url = "https://drive.google.com/uc?export=download&id=abc"
    client = fake_client([REPORT])
    run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run", cv_url=url), client=client))
    task = client.runs.created[0]["task"]
    assert url in task and "Downloads folder" in task
    assert task.index(url) < task.index("DataTransfer")  # link first, in-page method second
    # without a link the prompt is unchanged
    client2 = fake_client([REPORT])
    run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client2))
    assert "drive.google.com" not in client2.runs.created[0]["task"]


def test_required_fields_only_by_default(cv):
    client = fake_client([REPORT])
    run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run"), client=client))
    task = client.runs.created[0]["task"]
    assert "Fill ONLY required fields" in task and "Leave every optional field empty" in task
    client2 = fake_client([REPORT])
    run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="dry-run", required_only=False), client=client2))
    t2 = client2.runs.created[0]["task"]
    assert "Fill ONLY required fields" not in t2 and "For optional demographic" in t2


def test_uncovered_list_questions_take_first_option(cv):
    from auto_apply.prompts import FIELD_SOURCES, build_apply_task

    task = build_apply_task("https://x", "cv.pdf", {}, "auto")
    assert "FIRST real option" in task and "work authorization" in task
    assert "candidate's own experience" in task
    assert "first_option" in FIELD_SOURCES


def test_no_block_rule_is_opt_in(cv):
    from auto_apply.prompts import build_apply_task, build_continue_task

    assert "OVERRIDES rule 4" not in build_apply_task("https://x", "cv.pdf", {}, "auto")
    assert "OVERRIDES rule 4" in build_apply_task("https://x", "cv.pdf", {}, "auto", never_block=True)
    assert "Never invent contact details" in build_continue_task("cv.pdf", {}, "auto", never_block=True)


GREENHOUSE_CODE_EMAIL = (
    "Security code for your application to Geotab",
    "Hi Ahmed,\n\nCopy and paste this code into the security code field on your application:\n\n"
    "hlg9Qmoa\n\nAfter you enter the code, resubmit your application.\n",
)


def test_extract_greenhouse_code_and_workday_link():
    from auto_apply.inbox import extract_verification

    assert extract_verification(*GREENHOUSE_CODE_EMAIL) == {"code": "hlg9Qmoa"}
    link = extract_verification("Verify your candidate account",
                                "Click https://iqvia.wd1.myworkdayjobs.com/IQVIA/activate/abc123?x=1 to verify.")
    assert link == {"link": "https://iqvia.wd1.myworkdayjobs.com/IQVIA/activate/abc123?x=1"}
    assert extract_verification("Thanks for applying", "We received your application.") is None


def test_hints_identify_the_employer():
    from auto_apply.inbox import hints_for

    assert "geotab" in hints_for("https://job-boards.greenhouse.io/geotab/jobs/5459998008", "Geotab")
    assert "iqvia" in hints_for("https://iqvia.wd1.myworkdayjobs.com/IQVIA/job/Warsaw/PM_R1")


def test_verification_code_from_inbox_continues_the_same_session(cv):
    waiting = {**REPORT, "status": "waiting_for_verification",
               "job": {**REPORT["job"], "company": "Geotab"}}
    client = fake_client([waiting, {**REPORT, "status": "submitted"}])
    seen = {}

    class FakeInbox:
        async def wait_for(self, hints, since, timeout_s):
            seen["hints"] = hints
            return {"code": "hlg9Qmoa"}

    cfg = ApplyConfig(mode="auto", code_inbox=FakeInbox(), hold_for_followup=True)
    [rec] = run(apply_to_jobs(["https://job-boards.greenhouse.io/geotab/jobs/1"], cv, cfg, client=client))
    assert rec["status"] == "submitted" and rec["inbox_rounds"] == 1
    follow_up = client.runs.created[1]
    assert follow_up["session_id"] == "sess-1" and "hlg9Qmoa" in follow_up["task"]
    assert "geotab" in seen["hints"]


def test_concurrency_limit_waits_for_a_slot(cv, monkeypatch):
    from browser_use_sdk.v4 import BrowserUseError

    import auto_apply.runner as runner

    monkeypatch.setattr(runner, "SLOT_WAIT_S", 0)
    client = fake_client([{**REPORT, "status": "submitted"}])
    real_create, calls = client.runs.create, []

    async def flaky_create(task, **kw):
        calls.append(1)
        if len(calls) == 1:
            raise BrowserUseError(429, "Too many concurrent active sessions.")
        return await real_create(task, **kw)

    client.runs.create = flaky_create
    [rec] = run(apply_to_jobs(["https://jobs.example/1"], cv, ApplyConfig(mode="auto"), client=client))
    assert rec["status"] == "submitted" and len(calls) == 2
