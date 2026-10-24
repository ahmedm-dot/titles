"""Task prompts and the structured-output schema sent to the Browser Use agent."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# Every status the agent may end a run with. "ready_to_submit" only appears in
# review / dry-run modes, where the agent must stop before the final click.
STATUSES = [
    "submitted",
    "ready_to_submit",
    "needs_user_input",
    "blocked_login",
    "waiting_for_verification",
    "blocked_captcha",
    "job_closed",
    "failed",
]

FIELD_SOURCES = ["cv", "answers", "generated"]

CV_UPLOAD_STATES = ["uploaded", "failed", "no_upload_field"]

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "status",
        "job",
        "match",
        "fields_filled",
        "unanswered_required_questions",
        "cv_upload",
        "confirmation",
        "notes",
    ],
    "properties": {
        "status": {"type": "string", "enum": STATUSES},
        "job": {
            "type": "object",
            "additionalProperties": False,
            "required": ["title", "company", "location", "url", "ats_platform"],
            "properties": {
                "title": _STR,
                "company": _STR,
                "location": _STR,
                "url": _STR,
                "ats_platform": {
                    **_STR,
                    "description": "e.g. Greenhouse, Lever, Workday, Ashby, LinkedIn Easy Apply, custom",
                },
            },
        },
        "match": {
            "type": "object",
            "additionalProperties": False,
            "required": ["score", "matched_skills", "missing_keywords", "summary"],
            "properties": {
                "score": {"type": "integer", "minimum": 0, "maximum": 100},
                "matched_skills": _STR_LIST,
                "missing_keywords": _STR_LIST,
                "summary": _STR,
            },
        },
        "fields_filled": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["field", "value", "source"],
                "properties": {
                    "field": _STR,
                    "value": _STR,
                    "source": {"type": "string", "enum": FIELD_SOURCES},
                },
            },
        },
        "unanswered_required_questions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["question", "reason"],
                "properties": {"question": _STR, "reason": _STR},
            },
        },
        "cv_upload": {
            "type": "string",
            "enum": CV_UPLOAD_STATES,
            "description": "Whether the CV file is attached to the form at the end of the run.",
        },
        "confirmation": {
            **_STR,
            "description": "Confirmation message or reference number shown after submitting; empty string if not submitted.",
        },
        "notes": _STR,
    },
}

# Attaching the CV without moving a file into the browser: live runs showed the
# workspace-to-browser transfer timing out while file inputs only take files from
# the browser's Downloads folder. Building the File inside the page sidesteps both.
UPLOAD_FALLBACK = (
    'read "{cv_name}" in your workspace and base64-encode it; then, in the page, decode it into a '
    'Uint8Array, create a File (name "{cv_name}", type "application/pdf" for a PDF), put it in a new '
    "DataTransfer, assign dataTransfer.files to the resume input[type=file], and dispatch 'input' and "
    "'change' events (bubbles: true). If the field is a drop zone, dispatch dragenter/dragover/drop with "
    "that DataTransfer instead. Then check that the form shows the file name as attached."
)

_RULES = """\
Rules — follow all of them:
1. Use ONLY facts from the attached CV file "{cv_name}" and the applicant answers below. Never invent \
employers, dates, degrees, certifications, skills, salary figures, or legal/eligibility answers.
2. When a form has a resume/CV upload field, upload the attached file "{cv_name}". Do not paste the CV \
as text when an upload is offered. If the upload fails (e.g. the file transfer into the browser times \
out or the file input only accepts files from the browser's Downloads folder), use this fallback: \
{upload_fallback} If it still fails, never submit without the CV: set cv_upload to "failed" and finish with status "needs_user_input". Set cv_upload to \
"uploaded" once the form shows the file attached, or "no_upload_field" if the form has no file field.
3. Free-text questions (e.g. "Why do you want to work here?", cover letter boxes) may be written by you, \
grounded in the CV and the job description: concise, specific, professional, first person. Mark those \
fields with source "generated".
4. If a REQUIRED question cannot be answered from the CV or the answers, do not guess: leave it, list it \
in unanswered_required_questions, and finish with status "needs_user_input". Before finishing, fill everything \
else you can and keep going through the later pages/steps as far as the site allows, so that ALL unanswerable \
questions are collected in one report rather than one at a time.
5. For optional demographic / EEO / diversity questions, pick "Decline to self-identify" (or the closest \
equivalent) unless the applicant answers say otherwise.
6. If the page requires signing in or creating an account: when the secret "account_password" is \
available to you, sign in (or create the account) with the candidate's email from the applicant answers \
and type the secret account_password into the password fields - never write the password anywhere \
else; if no such secret is available, stop with status "blocked_login". If the site asks to verify the \
email address (a link or code sent to the candidate's email), do NOT click resend and do not change the \
email: stop with status "waiting_for_verification" and say in notes whether a link or a code was sent \
and to which address. If a CAPTCHA blocks you, stop with "blocked_captcha". If the posting is closed or \
missing, stop with "job_closed".
7. Do not sign up for newsletters or job alerts, and do not apply to any job other than this one. If the \
application offers to fill the form from a resume ("Autofill with Resume", "Upload resume to autofill", \
"Apply with resume"), use that option with the attached CV first, then check every autofilled field \
against the CV and the applicant answers and correct wrong or missing values.
8. Before you finish, read the job description and score how well the CV matches it (0-100, as an ATS \
would): list the skills from the posting that the CV clearly shows, and the important posting keywords \
the CV is missing.
"""

_SUBMIT_INSTRUCTIONS = {
    "auto": (
        "When every required field is filled, submit the application. After submitting, record any "
        'confirmation text or reference number and finish with status "submitted".'
    ),
    "review": (
        "Fill in every field you can, going through every page/step of the form, but DO NOT click the "
        "final submit/send button. Stop on the final review step with everything filled in and finish "
        'with status "ready_to_submit". A human will review your report before submission.'
    ),
    "dry-run": (
        "Fill in every field you can, going through every page/step of the form, but DO NOT click the "
        "final submit/send button under any circumstances. Finish with status \"ready_to_submit\"."
    ),
}


# First fallback when a public CV link is available: browser file inputs often only accept files
# from the browser's own Downloads folder, and opening the link downloads the CV there.
LINK_FALLBACK = (
    'open {cv_url} in a NEW browser tab so the browser downloads "{cv_name}" into its Downloads folder, return '
    "to the application tab, and attach that downloaded file to the resume field (choose it from the Downloads "
    "folder in the file picker / file input). Only use this link for the CV; never send the CV or any candidate "
    "data to any other site."
)


def _upload_fallback(cv_name: str, cv_url: str | None = None) -> str:
    in_page = UPLOAD_FALLBACK.format(cv_name=cv_name)
    if not cv_url:
        return in_page
    return LINK_FALLBACK.format(cv_name=cv_name, cv_url=cv_url) + " If that does not work: " + in_page


def _rules(cv_name: str, cv_url: str | None = None) -> str:
    return _RULES.format(cv_name=cv_name, upload_fallback=_upload_fallback(cv_name, cv_url))


def _answers_block(answers: dict[str, Any]) -> str:
    return json.dumps(answers, indent=2, ensure_ascii=False) if answers else "(none provided)"


def build_apply_task(job_url: str, cv_name: str, answers: dict[str, Any], mode: str,
                     cv_url: str | None = None) -> str:
    """The task for the first run: open the posting and fill (and maybe submit) the form."""
    if mode not in _SUBMIT_INSTRUCTIONS:
        raise ValueError(f"unknown mode {mode!r}")
    answers_block = _answers_block(answers)
    return (
        f"You are applying to a job on behalf of a candidate.\n\n"
        f"Job posting: {job_url}\n"
        f"Candidate CV: the attached file \"{cv_name}\".\n\n"
        f"Open the job posting, find its application form (click \"Apply\" if needed) and complete it "
        f"for the candidate.\n\n"
        f"{_SUBMIT_INSTRUCTIONS[mode]}\n\n"
        f"{_rules(cv_name, cv_url)}\n"
        f"Applicant answers (authoritative; use these for questions the CV does not cover, such as work "
        f"authorization, sponsorship, notice period, salary expectations, relocation, phone, links):\n"
        f"{answers_block}\n"
    )


def build_retry_upload_task(cv_name: str, answers: dict[str, Any], mode: str,
                            cv_url: str | None = None) -> str:
    """Follow-up in the same session after the agent reported cv_upload "failed"."""
    return (
        f"The CV upload failed in your previous attempt. You are still on the same application in the same "
        f"browser. Upload the attached file \"{cv_name}\" to the resume/CV field again. Do not repeat the "
        f"browser file transfer that timed out; go straight to this method: "
        f"{_upload_fallback(cv_name, cv_url)} Keep every other field as it is; "
        f"if the form was reset or the page navigated away, open the posting again and refill it.\n\n"
        f"{_SUBMIT_INSTRUCTIONS[mode]}\n\n"
        f"{_rules(cv_name, cv_url)}\n"
        f"Applicant answers:\n{_answers_block(answers)}\n"
        f"Report the full application again (all fields, match analysis, cv_upload)."
    )


_CONTINUE_REASONS = {
    "verified": "The candidate has now verified the email address for this application account.",
    "answers": ("The candidate has now answered the questions you could not answer; the updated applicant "
                "answers are below. Fill those fields and anything else still empty."),
}


def build_continue_task(cv_name: str, answers: dict[str, Any], mode: str, reason: str = "answers",
                        cv_url: str | None = None) -> str:
    """Follow-up in the same session: the browser (if still open) still holds the half-filled form."""
    return (
        f"{_CONTINUE_REASONS[reason]} Continue the same application from where it stopped: the form you "
        "already filled should still be open - keep what is already correct. If the page was closed or reset, "
        "go back to the job posting / application page, sign in with the candidate's email and the secret "
        "account_password if the site needs an account, and complete it.\n\n"
        f"{_SUBMIT_INSTRUCTIONS[mode]}\n\n"
        f"{_rules(cv_name, cv_url)}\n"
        f"Applicant answers:\n{_answers_block(answers)}\n"
        "Report the full application again (all fields, match analysis, cv_upload)."
    )


def build_resume_after_verification_task(cv_name: str, answers: dict[str, Any], mode: str) -> str:
    """Follow-up in the same session once the candidate has verified the email."""
    return build_continue_task(cv_name, answers, mode, reason="verified")


SUBMIT_TASK = (
    "The applicant has reviewed the filled application and approved it. Submit it now: click the final "
    "submit/send button without changing any field. If the form was reset or the page navigated away, "
    "refill it exactly as before following the same rules, then submit. Record any confirmation text or "
    'reference number and finish with status "submitted". Report every field again in fields_filled.'
)


# ---------------------------------------------------------------------------
# Prompt variant B: an external prompt kept verbatim in prompt_variants/b.txt,
# rendered with this tool's inputs. Only three things are added around it,
# none inside it: the posting URL (B assumes the browser already shows it), a
# no-submit override for dry-run / review modes, and a reporting footer so B's
# runs fill the same OUTPUT_SCHEMA as variant A and can be compared.
# ---------------------------------------------------------------------------

_VARIANT_DIR = Path(__file__).parent / "prompt_variants"

# With agentmail enabled, Browser Use gives the agent an inbox address in its
# context; we can't know it before the run, so the template names it instead.
AGENTMAIL_EMAIL = "the AgentMail inbox email address provided in your context"

_B_NO_SUBMIT = (
    "TEST-MODE OVERRIDE (takes precedence over everything below): this is a dry run. Follow every "
    "instruction below exactly, through every screen, but do NOT click the final submit/send button "
    "of the application. When the final submit click is the only step left, stop: for this run that "
    'counts as COMPLETE, and you report status "ready_to_submit".'
)

_B_REPORT = (
    "REPORTING: when you finish, report in the required output format. status: \"submitted\" (a "
    "confirmation is visible), \"ready_to_submit\" (dry run, only the final click left), "
    "\"job_closed\" (you terminated per the TERMINATION section), \"blocked_login\" / "
    "\"blocked_captcha\" (could not get past sign-in or a CAPTCHA), \"needs_user_input\" (a required "
    "answer was missing), or \"failed\". cv_upload: \"uploaded\" / \"failed\" / \"no_upload_field\". "
    "fields_filled: every field and the value entered, with source cv / answers / generated. match: "
    "score 0-100 of how well the candidate fits the posting, the posting's skills the candidate shows, "
    "and the important posting keywords the candidate lacks."
)


def build_variant_b_task(
    job_url: str, cv_name: str, cv_text: str, answers: dict[str, Any], mode: str,
    email: str | None = None,
) -> str:
    if mode not in _SUBMIT_INSTRUCTIONS:
        raise ValueError(f"unknown mode {mode!r}")
    template = (_VARIANT_DIR / "b.txt").read_text(encoding="utf-8")
    values = {
        "totp_identifier": email or AGENTMAIL_EMAIL,
        "resume": f'the attached file "{cv_name}"',
        "parsed_resume": cv_text or f'(see the attached file "{cv_name}")',
        "candidate_info": _answers_block(answers),
    }
    body = re.sub(r"\{\{(\w+)\}\}", lambda m: values[m.group(1)], template)
    parts = [f"Job posting: {job_url}\nOpen this URL first.\n"]
    if mode != "auto":
        parts.append(_B_NO_SUBMIT + "\n")
    parts += [body, "", _B_REPORT]
    if mode != "auto":
        parts.append("\n" + _B_NO_SUBMIT)
    return "\n".join(parts)
