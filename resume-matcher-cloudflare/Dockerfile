# Resume Matcher's official image (FastAPI backend + Next.js frontend + headless
# Chromium for PDF export), published by upstream at ghcr.io/srbhr/resume-matcher.
# Cloudflare Containers needs linux/amd64, which this image provides.
# Pin a release tag (e.g. :1.2.3) instead of :latest for reproducible deploys.
FROM --platform=linux/amd64 ghcr.io/srbhr/resume-matcher:latest

# The image serves everything on 3000 (the backend stays internal on 8000).
EXPOSE 3000
