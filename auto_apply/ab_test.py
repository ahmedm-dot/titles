"""A/B test two application prompts on the same jobs, in dry-run mode.

    python -m auto_apply.ab_test --cv cv.pdf --jobs-file jobs.txt --answers answers.json

Default (paired): both variants fill every job but never submit (one employer
must never get two applications), with the same model, proxy, CV and answers.
--split: each job is randomly given to ONE variant, which runs it in --mode (e.g.
auto, to really submit); the report then compares the two groups. Automatic upload
retries are off so each run reflects its prompt alone. Writes ab_<ts>.json
(raw records) and ab_<ts>.md (comparison) to --out.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any

from browser_use_sdk.v4 import AsyncBrowserUse

from .cli import _read_jobs
from .runner import ApplyConfig, apply_to_jobs

REACHED_END = {"ready_to_submit", "submitted"}


def cv_to_text(path: Path) -> str:
    if path.suffix.lower() != ".pdf":
        return ""
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""
    return "\n".join(page.extract_text() or "" for page in PdfReader(path).pages)


def metrics(rec: dict[str, Any]) -> dict[str, Any]:
    rep = rec.get("report") or {}
    fields = rep.get("fields_filled") or []
    started = datetime.fromisoformat(rec["started_at"])
    finished = datetime.fromisoformat(rec.get("finished_at") or rec["started_at"])
    return {
        "status": rec["status"],
        "reached_end": rec["status"] in REACHED_END,
        "cv_upload": rep.get("cv_upload") or "-",
        "fields": len(fields),
        "generated": sum(f.get("source") == "generated" for f in fields),
        "unanswered": len(rep.get("unanswered_required_questions") or []),
        "match": (rep.get("match") or {}).get("score"),
        "cost": float(rec.get("cost_usd") or 0),
        "minutes": round((finished - started).total_seconds() / 60, 1),
        "emails": sorted({f["value"] for f in fields if "mail" in f.get("field", "").lower()}),
    }


def summarize(jobs: list[str], a: list[dict], b: list[dict]) -> str:
    ma, mb = [metrics(r) for r in a], [metrics(r) for r in b]
    lines = ["# Prompt A/B test (dry-run)", "", f"{len(jobs)} jobs, {a[0]['model'] or 'default model'}", "",
             "## Per job", "",
             "| Job | A status | B status | A CV | B CV | A fields / gen / unanswered | B fields / gen / unanswered | A $ | B $ | A min | B min |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for url, x, y in zip(jobs, ma, mb):
        lines.append(
            f"| {url} | {x['status']} | {y['status']} | {x['cv_upload']} | {y['cv_upload']} | "
            f"{x['fields']} / {x['generated']} / {x['unanswered']} | {y['fields']} / {y['generated']} / {y['unanswered']} | "
            f"{x['cost']:.3f} | {y['cost']:.3f} | {x['minutes']} | {y['minutes']} |")

    def agg(ms: list[dict]) -> dict[str, str]:
        n = len(ms)
        return {
            "Reached final submit step": f"{sum(m['reached_end'] for m in ms)}/{n}",
            "CV attached": f"{sum(m['cv_upload'] == 'uploaded' for m in ms)}/{n}",
            "Stopped for user input": f"{sum(m['status'] == 'needs_user_input' for m in ms)}/{n}",
            "Avg fields filled": f"{mean(m['fields'] for m in ms):.1f}",
            "Avg AI-written answers": f"{mean(m['generated'] for m in ms):.1f}",
            "Avg total cost ($)": f"{mean(m['cost'] for m in ms):.4f}",
            "Total cost ($)": f"{sum(m['cost'] for m in ms):.4f}",
            "Avg minutes": f"{mean(m['minutes'] for m in ms):.1f}",
        }

    ga, gb = agg(ma), agg(mb)
    lines += ["", "## Totals", "", "| Metric | A (current) | B (new) |", "|---|---|---|"]
    lines += [f"| {k} | {ga[k]} | {gb[k]} |" for k in ga]
    return "\n".join(lines) + "\n"


def split_jobs(jobs: list[str], seed: int) -> tuple[list[str], list[str]]:
    """Random, reproducible half/half assignment (A gets the extra job if odd)."""
    shuffled = jobs[:]
    random.Random(seed).shuffle(shuffled)
    half = (len(shuffled) + 1) // 2
    a, b = set(shuffled[:half]), set(shuffled[half:])
    return [j for j in jobs if j in a], [j for j in jobs if j in b]


def summarize_split(jobs_a: list[str], jobs_b: list[str], a: list[dict], b: list[dict], mode: str) -> str:
    ma, mb = [metrics(r) for r in a], [metrics(r) for r in b]
    lines = [f"# Prompt A/B test (split, {mode})", "",
             f"Each job ran with one prompt only: A {len(a)} jobs, B {len(b)} jobs.", "",
             "## Per job", "",
             "| Prompt | Job | Status | CV | Fields / gen / unanswered | Match | $ | min |",
             "|---|---|---|---|---|---|---|---|"]
    for name, urls, ms in (("A", jobs_a, ma), ("B", jobs_b, mb)):
        for url, m in zip(urls, ms):
            lines.append(f"| {name} | {url} | {m['status']} | {m['cv_upload']} | "
                         f"{m['fields']} / {m['generated']} / {m['unanswered']} | {m['match']} | "
                         f"{m['cost']:.3f} | {m['minutes']} |")

    def agg(ms: list[dict]) -> dict[str, str]:
        n = len(ms) or 1
        return {
            "Submitted": f"{sum(m['status'] == 'submitted' for m in ms)}/{len(ms)}",
            "Reached final submit step": f"{sum(m['reached_end'] for m in ms)}/{len(ms)}",
            "CV attached": f"{sum(m['cv_upload'] == 'uploaded' for m in ms)}/{len(ms)}",
            "Stopped for user input": f"{sum(m['status'] == 'needs_user_input' for m in ms)}/{len(ms)}",
            "Avg fields filled": f"{sum(m['fields'] for m in ms) / n:.1f}",
            "Avg AI-written answers": f"{sum(m['generated'] for m in ms) / n:.1f}",
            "Avg total cost ($)": f"{sum(m['cost'] for m in ms) / n:.4f}",
            "Total cost ($)": f"{sum(m['cost'] for m in ms):.4f}",
            "Avg minutes": f"{sum(m['minutes'] for m in ms) / n:.1f}",
        }

    ga, gb = agg(ma), agg(mb)
    lines += ["", "## Totals", "", "| Metric | A (current) | B (new) |", "|---|---|---|"]
    lines += [f"| {k} | {ga[k]} | {gb[k]} |" for k in ga]
    return "\n".join(lines) + "\n"


async def run_ab(args: argparse.Namespace) -> int:
    jobs = _read_jobs(args)
    answers = json.loads(Path(args.answers).read_text(encoding="utf-8")) if args.answers else {}
    cv = Path(args.cv)
    mode = args.mode if args.split else "dry-run"
    common = dict(mode=mode, model=args.model, max_cost_usd=args.max_cost,
                  proxy_country=None if args.proxy_country.lower() == "none" else args.proxy_country.lower(),
                  concurrency=args.concurrency, run_timeout_s=args.timeout, upload_retries=0,
                  answers=answers)
    cfg_a = ApplyConfig(prompt_variant="a", **common)
    cfg_b = ApplyConfig(prompt_variant="b", cv_text=cv_to_text(cv), application_email=args.email_b,
                        **common)
    jobs_a, jobs_b = split_jobs(jobs, args.seed) if args.split else (jobs, jobs)
    if args.split:
        print("A:", *jobs_a, sep="\n  ")
        print("B:", *jobs_b, sep="\n  ")

    async with AsyncBrowserUse() as client:
        a, b = await asyncio.gather(
            apply_to_jobs(jobs_a, cv, cfg_a, client=client,
                          on_result=lambda r: print(f"[A] {r['status']:<17} {r['job_url']}")),
            apply_to_jobs(jobs_b, cv, cfg_b, client=client,
                          on_result=lambda r: print(f"[B] {r['status']:<17} {r['job_url']}")),
        )

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}"
    (out / f"ab_{stamp}.json").write_text(json.dumps({"a": a, "b": b}, indent=2, ensure_ascii=False),
                                          encoding="utf-8")
    report = summarize_split(jobs_a, jobs_b, a, b, mode) if args.split else summarize(jobs, a, b)
    (out / f"ab_{stamp}.md").write_text(report, encoding="utf-8")
    print(report)
    print(f"Written to {out}/ab_{stamp}.json and .md")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m auto_apply.ab_test", description=__doc__.splitlines()[0])
    p.add_argument("--cv", required=True)
    p.add_argument("--job", action="append")
    p.add_argument("--jobs-file")
    p.add_argument("--answers")
    p.add_argument("--model", default=None)
    p.add_argument("--max-cost", type=float, default=1.5)
    p.add_argument("--proxy-country", default="us")
    p.add_argument("--concurrency", type=int, default=4, help="per variant")
    p.add_argument("--timeout", type=float, default=1800)
    p.add_argument("--out", default="results")
    p.add_argument("--split", action="store_true",
                   help="give each job to one variant only (required to really submit)")
    p.add_argument("--mode", choices=("dry-run", "auto"), default="auto",
                   help="mode for --split runs (paired runs are always dry-run)")
    p.add_argument("--seed", type=int, default=1, help="random seed for --split")
    p.add_argument("--email-b", default=None,
                   help="email for variant B instead of an AgentMail inbox")
    args = p.parse_args(argv)
    if not os.environ.get("BROWSER_USE_API_KEY"):
        print("error: set BROWSER_USE_API_KEY", file=sys.stderr)
        return 2
    return asyncio.run(run_ab(args))


if __name__ == "__main__":
    raise SystemExit(main())
