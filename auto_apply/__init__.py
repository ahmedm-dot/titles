"""AI auto-apply: give it a CV and a job URL, get back a filled (or submitted)
application plus an ATS-style match report. Runs on Browser Use Cloud (API v4).
"""

from .runner import ApplyConfig, apply_to_jobs, apply_to_job

__all__ = ["ApplyConfig", "apply_to_jobs", "apply_to_job"]
