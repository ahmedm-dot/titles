import csv, sys

DATA = "/home/user/titles/data"

# Compact candidate list: short numeric id -> preferredLabel (+ isco code for
# category context). Keeping this small (no altLabels) keeps per-agent input
# tokens manageable across ~20 parallel Haiku agents.
with open(f"{DATA}/esco_occupations_en.csv", newline="", encoding="utf-8") as f, \
     open(f"{DATA}/esco_candidates_compact.csv", "w", newline="", encoding="utf-8") as out:
    r = csv.DictReader(f)
    w = csv.writer(out)
    w.writerow(["id", "isco", "preferredLabel_en"])
    for i, row in enumerate(r, start=1):
        w.writerow([i, row["iscoGroup"], row["preferredLabel"]])

print("Wrote compact candidate list", file=sys.stderr)

# Unmatched rows to send to AI matching, keyed by stable 'rank'.
with open(f"{DATA}/job_titles_esco_final.csv", newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    unmatched = [row for row in r if not row["esco_concept_uri"]]

print(f"{len(unmatched)} unmatched rows", file=sys.stderr)

CHUNK = 2500
import os
os.makedirs(f"{DATA}/ai_chunks", exist_ok=True)
os.makedirs(f"{DATA}/ai_chunks/out", exist_ok=True)
n = len(unmatched)
nchunks = (n + CHUNK - 1) // CHUNK
for i in range(nchunks):
    rows = unmatched[i*CHUNK:(i+1)*CHUNK]
    with open(f"{DATA}/ai_chunks/unmatched_{i:02d}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["rank", "title", "family", "seniority"])
        for row in rows:
            w.writerow([row["rank"], row["title"], row["family"], row["seniority"]])

print(f"Wrote {nchunks} chunks of up to {CHUNK} rows", file=sys.stderr)
