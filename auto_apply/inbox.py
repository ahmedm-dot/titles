"""Read email verification codes / links from an inbound.new mailbox so applications don't wait on a human.

Greenhouse emails an 8-character security code before it accepts an application, and Workday
sends a verification link when an account is created. Forward those emails (e.g. a Gmail filter on
"security code" / "verify") to an address on your inbound.new domain, and the runner picks them up.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

import httpx

API_BASE = "https://inbound.new/api/v2"

# A code is a lone 6-10 character token with a digit, or with mixed case (Greenhouse: "hlg9Qmoa").
_TOKEN = re.compile(r"(?<![\w/.@-])([A-Za-z0-9]{6,10})(?![\w/.@-])")
_CODE_CONTEXT = re.compile(r"code|verif|security|one[- ]time|otp", re.I)
_LINK = re.compile(r"https?://[^\s\"'<>)]+", re.I)
_LINK_WORDS = re.compile(r"verif|confirm|activat|validat|token", re.I)
_STOPWORDS = {"security", "password", "candidate", "verified", "application", "greenhouse", "workday"}


def _looks_like_code(tok: str) -> bool:
    if tok.lower() in _STOPWORDS:
        return False
    has_digit = any(c.isdigit() for c in tok)
    mixed = any(c.islower() for c in tok) and any(c.isupper() for c in tok)
    return has_digit or mixed


def extract_verification(subject: str, text: str) -> dict[str, str] | None:
    """{"code": ...} or {"link": ...} from a verification email, or None."""
    body = f"{subject}\n{text}"
    if _CODE_CONTEXT.search(body):
        # Prefer a token that sits on a line of its own, then one right after the word "code".
        for line in body.splitlines():
            m = _TOKEN.fullmatch(line.strip())
            if m and _looks_like_code(m.group(1)):
                return {"code": m.group(1)}
        after = re.search(r"code[^A-Za-z0-9]{0,40}([A-Za-z0-9]{6,10})\b", body, re.I)
        if after and _looks_like_code(after.group(1)):
            return {"code": after.group(1)}
    for url in _LINK.findall(body):
        if _LINK_WORDS.search(url):
            return {"link": html_lib.unescape(url.rstrip(".,"))}
    return None


def hints_for(job_url: str, company: str | None = None) -> list[str]:
    """Words that identify the employer in a verification email (company name, board token, host)."""
    words = set()
    if company:
        words.update(w.lower() for w in re.findall(r"[A-Za-z]{3,}", company))
    parsed = urlparse(job_url)
    host = parsed.hostname or ""
    parts = [p for p in re.split(r"[./]", host + parsed.path) if p]
    generic = {"www", "jobs", "job", "boards", "job-boards", "careers", "apply", "com", "io", "co",
               "greenhouse", "ashbyhq", "lever", "myworkdayjobs", "recruitee", "teamtailor", "personio"}
    for p in parts[:4]:
        p = p.lower()
        if p not in generic and not re.fullmatch(r"wd\d+|\d+", p) and len(p) >= 3:
            words.add(p)
    return sorted(words)


class CodeInbox:
    """Polls an inbound.new mailbox for verification emails that arrive after an application paused."""

    def __init__(self, api_key: str | None = None, address: str | None = None, base_url: str = API_BASE):
        self.api_key = api_key or os.environ.get("INBOUND_API_KEY")
        if not self.api_key:
            raise ValueError("set INBOUND_API_KEY for the verification-code inbox")
        self.address = address.lower() if address else None
        self.base_url = base_url
        self._used: set[str] = set()

    async def _get(self, http: httpx.AsyncClient, path: str, **params: Any) -> Any:
        r = await http.get(f"{self.base_url}{path}", params=params,
                           headers={"Authorization": f"Bearer {self.api_key}"})
        r.raise_for_status()
        return r.json()

    async def wait_for(self, hints: list[str], since: datetime, timeout_s: float = 300,
                       poll_s: float = 10) -> dict[str, str] | None:
        """Newest unused code/link received after `since` whose email mentions one of `hints`."""
        deadline = asyncio.get_running_loop().time() + timeout_s
        floor = since - timedelta(minutes=2)  # the email can land a little before the run reports
        async with httpx.AsyncClient(timeout=30) as http:
            while True:
                listing = await self._get(http, "/emails", type="received", limit=25)
                for item in listing.get("data", []):
                    if item["id"] in self._used:
                        continue
                    created = datetime.fromisoformat(item["created_at"].replace("Z", "+00:00"))
                    if created < floor:
                        continue
                    if self.address and self.address not in [a.lower() for a in item.get("to") or []] \
                            and self.address != (item.get("envelope_recipient") or "").lower():
                        continue
                    full = await self._get(http, f"/emails/{item['id']}")
                    full = full.get("data", full)
                    subject = full.get("subject") or ""
                    text = full.get("text") or re.sub(r"<[^>]+>", " ", full.get("html") or "")
                    haystack = f"{subject}\n{text}\n{item.get('from') or ''}".lower()
                    if hints and not any(h in haystack for h in hints):
                        continue
                    found = extract_verification(subject, text)
                    if found:
                        self._used.add(item["id"])
                        found["email_id"] = item["id"]
                        found["received_at"] = created.astimezone(timezone.utc).isoformat()
                        return found
                if asyncio.get_running_loop().time() >= deadline:
                    return None
                await asyncio.sleep(poll_s)
