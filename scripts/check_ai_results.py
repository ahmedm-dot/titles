import csv, glob, sys

DATA = "/home/user/titles/data"

# id -> conceptUri (id assignment matches scripts/prepare_ai_match_inputs.py: enumerate from 1)
en_rows = []
with open(f"{DATA}/esco_occupations_en.csv", newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    for row in r:
        en_rows.append(row)

id_to_uri = {i: row["conceptUri"] for i, row in enumerate(en_rows, start=1)}
uri_preferred_en = {row["conceptUri"]: row["preferredLabel"] for row in en_rows}

def load_lang(lang):
    d = {}
    with open(f"{DATA}/esco_occupations_{lang}.csv", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            d[row["conceptUri"]] = row["preferredLabel"]
    return d

es_labels = load_lang("es")
pt_labels = load_lang("pt")
fr_labels = load_lang("fr")

# Arabic translations done so far (from the earlier 2,476-occupation batch)
ar_map = {}
for path in sorted(glob.glob(f"{DATA}/chunks/out/chunk_*_ar.csv")):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if row["conceptUri"].strip():
                ar_map[row["conceptUri"].strip()] = row["label_ar"].strip()

# Load AI match results
import os
expected_chunks = 20
found = sorted(glob.glob(f"{DATA}/ai_chunks/out/matched_*.csv"))
print(f"Found {len(found)}/{expected_chunks} AI match output files", file=sys.stderr)

rank_to_match = {}
for path in found:
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            rank = row["rank"].strip()
            mid = row["matched_id"].strip()
            conf = row["confidence"].strip().lower()
            if rank:
                rank_to_match[rank] = (mid, conf)

print(f"Loaded {len(rank_to_match)} AI match decisions", file=sys.stderr)

# Determine newly-used conceptUris that still need Arabic translation
new_uris_needing_ar = set()
accepted = 0
for rank, (mid, conf) in rank_to_match.items():
    if mid and conf in ("high", "medium"):
        try:
            uri = id_to_uri[int(mid)]
        except (ValueError, KeyError):
            continue
        accepted += 1
        if uri not in ar_map:
            new_uris_needing_ar.add(uri)

print(f"AI accepted matches (high+medium): {accepted}", file=sys.stderr)
print(f"New distinct ESCO occupations needing Arabic translation: {len(new_uris_needing_ar)}", file=sys.stderr)

with open(f"{DATA}/ai_new_uris_needing_ar.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["conceptUri", "preferredLabel_en"])
    for uri in sorted(new_uris_needing_ar, key=lambda u: uri_preferred_en.get(u, "")):
        w.writerow([uri, uri_preferred_en.get(uri, "")])

print("Wrote data/ai_new_uris_needing_ar.csv -- translate this before the final merge if non-empty.", file=sys.stderr)
