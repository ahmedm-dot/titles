"""Task prompts and the structured-output schema sent to the Browser Use agent."""

from __future__ import annotations

import json
from typing import Any

# Every status the agent may end a run with. "ready_to_submit" only appears in
# review / dry-run modes, where the agent must stop before the final click.
STATUSES = [
    "submitted",
    "ready_to_submit",
    "needs_user_input",
    "blocked_login",
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

_RULES = """\
Rules — follow all of them:
1. Use ONLY facts from the attached CV file "{cv_name}" and the applicant answers below. Never invent \
employers, dates, degrees, certifications, skills, salary figures, or legal/eligibility answers.
2. When a form has a resume/CV upload field, upload the attached file "{cv_name}". Do not paste the CV \
as text when an upload is offered. If the upload fails, try again; if it still fails, never submit \
without the CV: set cv_upload to "failed" and finish with status "needs_user_input". Set cv_upload to \
"uploaded" once the form shows the file attached, or "no_upload_field" if the form has no file field.
3. Free-text questions (e.g. "Why do you want to work here?", cover letter boxes) may be written by you, \
grounded in the CV and the job description: concise, specific, professional, first person. Mark those \
fields with source "generated".
4. If a REQUIRED question cannot be answered from the CV or the answers, do not guess: leave it, list it \
in unanswered_required_questions, and finish with status "needs_user_input".
5. For optional demographic / EEO / diversity questions, pick "Decline to self-identify" (or the closest \
equivalent) unless the applicant answers say otherwise.
6. If the page requires signing in or creating an account and no credentials were provided, stop with \
status "blocked_login". If a CAPTCHA blocks you, stop with "blocked_captcha". If the posting is closed or \
missing, stop with "job_closed".
7. Do not sign up for newsletters or job alerts, and do not apply to any job other than this one.
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


def _answers_block(answers: dict[str, Any]) -> str:
    return json.dumps(answers, indent=2, ensure_ascii=False) if answers else "(none provided)"


def build_apply_task(job_url: str, cv_name: str, answers: dict[str, Any], mode: str) -> str:
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
        f"{_RULES.format(cv_name=cv_name)}\n"
        f"Applicant answers (authoritative; use these for questions the CV does not cover, such as work "
        f"authorization, sponsorship, notice period, salary expectations, relocation, phone, links):\n"
        f"{answers_block}\n"
    )


def build_retry_upload_task(cv_name: str, answers: dict[str, Any], mode: str) -> str:
    """Follow-up in the same session after the agent reported cv_upload "failed"."""
    return (
        f"The CV upload failed in your previous attempt. You are still on the same application in the same "
        f"browser. Upload the attached file \"{cv_name}\" to the resume/CV field again. Try a different way "
        f"than before: wait for the page to finish loading, clear any half-finished upload, and use the "
        f"field's own upload button, or its drag-and-drop area / file input. Keep every other field as it is; "
        f"if the form was reset or the page navigated away, open the posting again and refill it.\n\n"
        f"{_SUBMIT_INSTRUCTIONS[mode]}\n\n"
        f"{_RULES.format(cv_name=cv_name)}\n"
        f"Applicant answers:\n{_answers_block(answers)}\n"
        f"Report the full application again (all fields, match analysis, cv_upload)."
    )


SUBMIT_TASK = (
    "The applicant has reviewed the filled application and approved it. Submit it now: click the final "
    "submit/send button without changing any field. If the form was reset or the page navigated away, "
    "refill it exactly as before following the same rules, then submit. Record any confirmation text or "
    'reference number and finish with status "submitted". Report every field again in fields_filled.'
)
