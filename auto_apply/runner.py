"""Drive Browser Use Cloud (API v4) runs that apply to jobs with a candidate's CV."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Awaitable, Callable

from browser_use_sdk.v4 import AsyncBrowserUse, BrowserUseError

from .prompts import OUTPUT_SCHEMA, SUBMIT_TASK, build_apply_task, build_retry_upload_task

MODES = ("review", "dry-run", "auto")

# Statuses for which a failed CV upload is worth a retry run.
UPLOAD_RETRY_STATUSES = {"needs_user_input", "ready_to_submit", "failed"}

# Called in review mode with the agent's report; return True to submit.
ConfirmFn = Callable[[dict[str, Any]], Awaitable[bool]]


@dataclass
class ApplyConfig:
    mode: str = "review"
    # None lets Browser Use pick the account's default model, which also works on the free plan.
    model: str | None = None
    max_cost_usd: float = 3.0
    # None runs without a proxy; any ISO code (e.g. "us", "gb", "ae") picks a residential exit.
    proxy_country: str | None = "us"
    concurrency: int = 3
    run_timeout_s: float = 1800
    # Browser keep-alive after the fill run in review mode, so the approved submit
    # reuses the same filled-in page. Billed as browser time; API minimum is 120.
    review_window_s: int = 600
    # Follow-up runs that retry a failed CV upload in the same browser session.
    upload_retries: int = 2
    answers: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}, got {self.mode!r}")
        if self.review_window_s < 120:
            raise ValueError("review_window_s must be at least 120 seconds")


def parse_output(run: Any) -> dict[str, Any] | None:
    """Return the agent's structured report, falling back to JSON in the text result."""
    output = getattr(run, "output", None)
    if isinstance(output, dict):
        return output
    for raw in (output, getattr(run, "result", None)):
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
    return None


def _cost(run: Any) -> Decimal:
    try:
        return Decimal(str(getattr(run, "total_cost_usd", "0") or "0"))
    except InvalidOperation:
        return Decimal("0")


_COST_PARTS = {"llm": "llm_cost_usd", "browser": "browser_cost_usd", "proxy": "proxy_cost_usd",
               "search": "search_cost_usd"}


async def _release_browsers(client: AsyncBrowserUse, sessions: list[str]) -> bool:
    """Stop every still-open browser of these sessions; True when all are closed."""
    all_closed = True
    for sid in sessions:
        page = await client.browsers.list(agent_session_id=sid)
        for browser in page.items:
            if browser.status.value == "stopped":
                continue
            try:
                stopped = await client.browsers.stop(browser.id)
            except BrowserUseError:
                all_closed = False
                continue
            all_closed = all_closed and stopped.status.value == "stopped"
    return all_closed


async def _add_session_costs(client: AsyncBrowserUse, sessions: list[str], record: dict[str, Any]) -> None:
    parts = {k: Decimal("0") for k in _COST_PARTS}
    total = Decimal("0")
    for sid in sessions:
        cost = await client.sessions.cost(sid)
        total += Decimal(str(cost.total_cost_usd))
        for key, attr in _COST_PARTS.items():
            parts[key] += Decimal(str(getattr(cost, attr, "0") or "0"))
    record["cost_usd"] = str(total)
    record["cost_breakdown"] = {k: str(v) for k, v in parts.items()}


async def _run_and_wait(client: AsyncBrowserUse, cfg: ApplyConfig, task: str, **kwargs: Any) -> Any:
    created = await client.runs.create(
        task,
        model=cfg.model,
        output_schema=OUTPUT_SCHEMA,
        max_cost_usd=cfg.max_cost_usd,
        **kwargs,
    )
    try:
        return await client.runs.wait_for_completion(created.id, timeout=cfg.run_timeout_s)
    except (TimeoutError, asyncio.CancelledError):
        # Don't leave an agent clicking around (and billing) after we gave up on it.
        try:
            await client.runs.cancel(created.id)
        except BrowserUseError:
            pass
        raise


async def apply_to_job(
    client: AsyncBrowserUse,
    job_url: str,
    *,
    cv_name: str,
    workspace_id: str,
    cv_file_id: str,
    cfg: ApplyConfig,
    confirm: ConfirmFn | None = None,
) -> dict[str, Any]:
    """Apply to one job. Never raises for per-job failures; they land in the record."""
    record: dict[str, Any] = {
        "job_url": job_url,
        "mode": cfg.mode,
        "model": cfg.model,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "failed",
        "report": None,
        "run_ids": [],
        "session_id": None,
        "cost_usd": "0",
        "error": None,
    }
    total = Decimal("0")  # LLM cost reported by each run
    sessions: list[str] = []
    try:
        browser_settings = {"proxyCountryCode": cfg.proxy_country}
        fill = await _run_and_wait(
            client,
            cfg,
            build_apply_task(job_url, cv_name, cfg.answers, cfg.mode),
            workspace_id=workspace_id,
            attached_file_ids=[cv_file_id],
            browser_settings=browser_settings,
            **({"keep_alive": cfg.review_window_s} if cfg.mode == "review" else {}),
        )
        record["run_ids"].append(str(fill.id))
        record["session_id"] = str(fill.session_id)
        sessions.append(str(fill.session_id))
        total += _cost(fill)
        report = parse_output(fill)
        record["report"] = report

        if fill.status.value != "completed" or report is None:
            record["error"] = fill.error or f"run ended {fill.status.value} without a structured report"
            return record

        # A failed upload is usually a one-off browser glitch: retry in the same session
        # (the browser is still on the half-filled form) instead of giving up on the job.
        retries = 0
        # Only when the upload is what blocks the application: a closed posting or a
        # login wall won't be fixed by re-uploading.
        while (
            report.get("cv_upload") == "failed"
            and report.get("status") in UPLOAD_RETRY_STATUSES
            and retries < cfg.upload_retries
        ):
            retries += 1
            if retries < cfg.upload_retries:
                retry = await _run_and_wait(
                    client,
                    cfg,
                    build_retry_upload_task(cv_name, cfg.answers, cfg.mode),
                    session_id=fill.session_id,
                    attached_file_ids=[cv_file_id],
                )
            else:
                # Last try: a brand-new browser. When the file transfer into a browser
                # gets stuck, retrying in that same browser keeps hitting the same wall.
                retry = await _run_and_wait(
                    client,
                    cfg,
                    build_apply_task(job_url, cv_name, cfg.answers, cfg.mode),
                    workspace_id=workspace_id,
                    attached_file_ids=[cv_file_id],
                    browser_settings=browser_settings,
                )
                record["session_id"] = str(retry.session_id)
                sessions.append(str(retry.session_id))
            record["run_ids"].append(str(retry.id))
            total += _cost(retry)
            retry_report = parse_output(retry)
            if retry.status.value != "completed" or retry_report is None:
                break
            report = {**report, **retry_report}
            record["report"] = report
        record["upload_retries"] = retries
        record["status"] = report.get("status", "failed")

        if cfg.mode == "review" and record["status"] == "ready_to_submit" and confirm is not None:
            if await confirm(report):
                submit = await _run_and_wait(
                    client,
                    cfg,
                    SUBMIT_TASK,
                    session_id=fill.session_id,
                    attached_file_ids=[cv_file_id],
                )
                record["run_ids"].append(str(submit.id))
                total += _cost(submit)
                submit_report = parse_output(submit)
                if submit.status.value == "completed" and submit_report is not None:
                    # Keep the match analysis from the fill run if the submit run skipped it.
                    record["report"] = {**report, **submit_report}
                    record["status"] = submit_report.get("status", "failed")
                else:
                    record["status"] = "failed"
                    record["error"] = submit.error or "submit run returned no structured report"
            else:
                record["status"] = "declined_by_user"
    except (BrowserUseError, TimeoutError) as exc:
        record["error"] = str(exc)
    finally:
        record["cost_usd"] = str(total)
        record["cost_breakdown"] = {"llm": str(total)}
        # A run's cost is LLM only; browser time and proxy traffic are billed per
        # session, so the real total comes from the session cost endpoint. Browser
        # time is held up front and only settled when the browser closes, so close
        # it first: that also refunds the keep-alive time nobody will use.
        if sessions:
            try:
                record["cost_final"] = await _release_browsers(client, sessions)
                await _add_session_costs(client, sessions, record)
            except BrowserUseError:
                record["cost_note"] = "session cost unavailable; cost_usd is LLM only"
        record["finished_at"] = datetime.now(timezone.utc).isoformat()
    return record


async def apply_to_jobs(
    job_urls: list[str],
    cv_path: str | Path,
    cfg: ApplyConfig,
    *,
    confirm: ConfirmFn | None = None,
    client: AsyncBrowserUse | None = None,
    on_result: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, Any]]:
    """Upload the CV once, then apply to every job with bounded concurrency."""
    cv_path = Path(cv_path)
    if not cv_path.is_file():
        raise FileNotFoundError(cv_path)

    owns_client = client is None
    client = client or AsyncBrowserUse()
    try:
        workspace = await client.workspaces.create(name=f"auto-apply {cv_path.stem}")
        uploaded = await client.workspaces.upload(workspace.id, cv_path)
        cv_file_id = str(uploaded[0].id)

        sem = asyncio.Semaphore(max(1, cfg.concurrency))
        # Review prompts must not interleave on the terminal.
        confirm_lock = asyncio.Lock()

        async def locked_confirm(report: dict[str, Any]) -> bool:
            async with confirm_lock:
                return await confirm(report)  # type: ignore[misc]

        async def one(url: str) -> dict[str, Any]:
            async with sem:
                rec = await apply_to_job(
                    client,
                    url,
                    cv_name=cv_path.name,
                    workspace_id=str(workspace.id),
                    cv_file_id=cv_file_id,
                    cfg=cfg,
                    confirm=locked_confirm if confirm else None,
                )
            if on_result:
                on_result(rec)
            return rec

        return list(await asyncio.gather(*(one(u) for u in job_urls)))
    finally:
        if owns_client:
            await client.close()
