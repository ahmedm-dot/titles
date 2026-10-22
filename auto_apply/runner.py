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

from .prompts import OUTPUT_SCHEMA, SUBMIT_TASK, build_apply_task

MODES = ("review", "dry-run", "auto")

# Called in review mode with the agent's report; return True to submit.
ConfirmFn = Callable[[dict[str, Any]], Awaitable[bool]]


@dataclass
class ApplyConfig:
    mode: str = "review"
    model: str = "claude-sonnet-5-5"
    max_cost_usd: float = 3.0
    # None runs without a proxy; any ISO code (e.g. "us", "gb", "ae") picks a residential exit.
    proxy_country: str | None = "us"
    concurrency: int = 3
    run_timeout_s: float = 1800
    # Browser keep-alive after the fill run in review mode, so the approved submit
    # reuses the same filled-in page. Billed as browser time; API minimum is 120.
    review_window_s: int = 600
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
    total = Decimal("0")
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
        total += _cost(fill)
        report = parse_output(fill)
        record["report"] = report

        if fill.status.value != "completed" or report is None:
            record["error"] = fill.error or f"run ended {fill.status.value} without a structured report"
            return record
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
