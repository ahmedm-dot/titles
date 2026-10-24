"""Command line: python -m auto_apply --cv cv.pdf --job https://... [--job ...]"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .runner import MODES, ApplyConfig, apply_to_jobs, continue_session


def _read_jobs(args: argparse.Namespace) -> list[str]:
    jobs = list(args.job or [])
    if args.jobs_file:
        for line in Path(args.jobs_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                jobs.append(line)
    # Keep order, drop duplicates so nobody applies twice to the same posting.
    return list(dict.fromkeys(jobs))


def format_report(rec: dict[str, Any]) -> str:
    rep = rec.get("report") or {}
    job = rep.get("job") or {}
    match = rep.get("match") or {}
    lines = [
        "=" * 72,
        f"{job.get('title') or '?'} @ {job.get('company') or '?'}  [{job.get('ats_platform') or '?'}]",
        f"URL:    {rec['job_url']}",
        f"Status: {rec['status']}    Cost: ${rec['cost_usd']}    Session: {rec.get('session_id') or '-'}",
    ]
    parts = rec.get("cost_breakdown") or {}
    if len(parts) > 1:
        lines.append("Cost:   " + "  ".join(f"{k} ${v}" for k, v in parts.items() if v and float(v)))
        if rec.get("cost_final") is False:
            lines.append("        (provisional: a browser was still open, browser time may be refunded)")
    if match:
        lines.append(f"Match:  {match.get('score', '?')}/100 — {match.get('summary', '')}")
        if match.get("missing_keywords"):
            lines.append(f"        Missing keywords: {', '.join(match['missing_keywords'])}")
    if rep.get("cv_upload"):
        retried = f" after {rec['upload_retries']} retr{'y' if rec['upload_retries'] == 1 else 'ies'}" if rec.get("upload_retries") else ""
        lines.append(f"CV:     {rep['cv_upload']}{retried}")
    for f in rep.get("fields_filled") or []:
        lines.append(f"  • {f.get('field')}: {f.get('value')}  ({f.get('source')})")
    for q in rep.get("unanswered_required_questions") or []:
        lines.append(f"  ! NEEDS INPUT: {q.get('question')} — {q.get('reason')}")
    if rep.get("confirmation"):
        lines.append(f"Confirmation: {rep['confirmation']}")
    if rep.get("notes"):
        lines.append(f"Notes: {rep['notes']}")
    if rec.get("error"):
        lines.append(f"Error: {rec['error']}")
    return "\n".join(lines)


async def _terminal_confirm(report: dict[str, Any]) -> bool:
    job = report.get("job") or {}
    print(format_report({"job_url": job.get("url", ""), "status": "ready_to_submit",
                         "cost_usd": "…", "report": report}))
    answer = await asyncio.to_thread(input, "Submit this application? [y/N] ")
    return answer.strip().lower() in {"y", "yes"}


def _resume(args: argparse.Namespace, cfg: ApplyConfig, job_url: str) -> int:
    from browser_use_sdk.v4 import AsyncBrowserUse

    async def go() -> dict[str, Any]:
        async with AsyncBrowserUse() as client:
            reason = "verified" if args.resume_session else "answers"
            return await continue_session(client, args.resume_session or args.continue_session, job_url,
                                          Path(args.cv).name, cfg, reason=reason)

    rec = asyncio.run(go())
    print(format_report(rec))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"resume_{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json"
    out_file.write_text(json.dumps([rec], indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Result written to {out_file}")
    return 0 if rec["status"] != "failed" else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m auto_apply",
        description="Apply to jobs with your CV using a Browser Use Cloud agent.",
    )
    p.add_argument("--cv", required=True, help="Path to the CV (PDF or DOCX)")
    p.add_argument("--job", action="append", help="Job posting URL (repeatable)")
    p.add_argument("--jobs-file", help="Text file with one job URL per line")
    p.add_argument("--answers", help="JSON file with answers to common application questions")
    p.add_argument(
        "--mode",
        choices=MODES,
        default="review",
        help="review: fill, show you the result, submit only if you approve (default). "
        "dry-run: fill but never submit. auto: submit without asking.",
    )
    p.add_argument("--prompt-variant", choices=("a", "b"), default="a",
                   help="a: built-in prompt (default). b: prompt_variants/b.txt with an AgentMail inbox")
    p.add_argument("--model", default=None,
                   help="Browser Use v4 model id (default: the account's default model)")
    p.add_argument("--max-cost", type=float, default=ApplyConfig.max_cost_usd,
                   help="USD budget per job session (default %(default)s)")
    p.add_argument("--proxy-country", default="us",
                   help='Residential proxy country code, or "none" to disable')
    p.add_argument("--concurrency", type=int, default=ApplyConfig.concurrency)
    p.add_argument("--timeout", type=float, default=ApplyConfig.run_timeout_s,
                   help="Seconds to wait for each agent run")
    p.add_argument("--out", default="results", help="Directory for the JSON results file")
    p.add_argument("--account-password-env", metavar="VAR",
                   help="env var holding a password for sites that need an account (Workday...); "
                        "passed as a secret binding, never in the prompt")
    p.add_argument("--resume-session", metavar="SESSION_ID",
                   help="continue a session that stopped at waiting_for_verification (one --job)")
    p.add_argument("--continue-session", metavar="SESSION_ID",
                   help="continue a session that stopped for missing answers, with the updated --answers (one --job)")
    p.add_argument("--hold", action="store_true",
                   help="keep the browser open when a run stops for input (or a dry-run ends), "
                        "so --continue-session finishes the same form")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    jobs = _read_jobs(args)
    if not jobs:
        print("error: give at least one --job or a --jobs-file", file=sys.stderr)
        return 2
    if not os.environ.get("BROWSER_USE_API_KEY"):
        print("error: set BROWSER_USE_API_KEY (create one at "
              "https://cloud.browser-use.com/settings?tab=api-keys&new=1)", file=sys.stderr)
        return 2
    answers = json.loads(Path(args.answers).read_text(encoding="utf-8")) if args.answers else {}

    cfg = ApplyConfig(
        mode=args.mode,
        model=args.model,
        max_cost_usd=args.max_cost,
        proxy_country=None if args.proxy_country.lower() == "none" else args.proxy_country.lower(),
        concurrency=args.concurrency,
        run_timeout_s=args.timeout,
        answers=answers,
        prompt_variant=args.prompt_variant,
    )
    if cfg.prompt_variant == "b":
        from .ab_test import cv_to_text

        cfg.cv_text = cv_to_text(Path(args.cv))
    if args.account_password_env:
        cfg.account_password = os.environ.get(args.account_password_env)
        if not cfg.account_password:
            print(f"error: ${args.account_password_env} is empty", file=sys.stderr)
            return 2
    cfg.hold_for_followup = args.hold
    if args.resume_session or args.continue_session:
        if len(jobs) != 1:
            print("error: --resume-session / --continue-session take exactly one --job", file=sys.stderr)
            return 2
        return _resume(args, cfg, jobs[0])
    if cfg.mode == "review" and not sys.stdin.isatty():
        print("error: review mode needs an interactive terminal; use --mode dry-run or auto",
              file=sys.stderr)
        return 2

    print(f"Applying to {len(jobs)} job(s) in {cfg.mode} mode with {cfg.model or 'the default model'}…")
    results = asyncio.run(
        apply_to_jobs(
            jobs,
            args.cv,
            cfg,
            confirm=_terminal_confirm if cfg.mode == "review" else None,
            on_result=lambda rec: print(format_report(rec)),
        )
    )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"applications_{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.json"
    out_file.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")

    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print("=" * 72)
    print("Summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print(f"Results written to {out_file}")
    return 0 if all(r["status"] != "failed" for r in results) else 1
