import csv, glob, sys

DATA = "/home/user/titles/data"

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

ar_map = {}
for path in sorted(glob.glob(f"{DATA}/chunks/out/chunk_*_ar.csv")):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if row["conceptUri"].strip():
                ar_map[row["conceptUri"].strip()] = row["label_ar"].strip()

new_ar_path = f"{DATA}/ai_new_uris_ar.csv"
try:
    with open(new_ar_path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if row["conceptUri"].strip():
                ar_map[row["conceptUri"].strip()] = row["label_ar"].strip()
    print(f"Loaded extra Arabic translations from {new_ar_path}", file=sys.stderr)
except FileNotFoundError:
    print(f"WARNING: {new_ar_path} not found yet -- AI-matched occupations without prior Arabic coverage will have blank esco_label_ar", file=sys.stderr)

# AI match decisions: rank -> (conceptUri, confidence) for high/medium only
rank_to_ai = {}
for path in sorted(glob.glob(f"{DATA}/ai_chunks/out/matched_*.csv")):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            rank = row["rank"].strip()
            mid = row["matched_id"].strip()
            conf = row["confidence"].strip().lower()
            if rank and mid and conf in ("high", "medium"):
                try:
                    uri = id_to_uri[int(mid)]
                except (ValueError, KeyError):
                    continue
                rank_to_ai[rank] = (uri, conf)

print(f"AI matches to apply: {len(rank_to_ai)}", file=sys.stderr)

in_path = f"{DATA}/job_titles_esco_final.csv"
out_path = f"{DATA}/job_titles_esco_final_v2.csv"

stats = {"rule_based_kept": 0, "ai_matched_high": 0, "ai_matched_medium": 0, "still_unmatched": 0}
missing_ar = set()

with open(in_path, newline="", encoding="utf-8") as fin, \
     open(out_path, "w", newline="", encoding="utf-8") as fout:
    r = csv.DictReader(fin)
    fieldnames = [fn for fn in r.fieldnames if fn != "esco_label_ar"] + ["esco_label_fr", "esco_label_ar"]
    w = csv.DictWriter(fout, fieldnames=fieldnames)
    w.writeheader()
    for row in r:
        uri = row["esco_concept_uri"]
        if uri:
            # already matched by the rule-based pass -- keep it, just add FR
            stats["rule_based_kept"] += 1
        else:
            rank = row["rank"]
            ai = rank_to_ai.get(rank)
            if ai:
                uri, conf = ai
                row["esco_concept_uri"] = uri
                row["esco_label_en"] = uri_preferred_en.get(uri, "")
                row["esco_label_es"] = es_labels.get(uri, "")
                row["esco_label_pt"] = pt_labels.get(uri, "")
                row["esco_match_type"] = f"ai_matched_{conf}"
                row["esco_match_score"] = ""
                row["esco_matched_variant"] = ""
                stats[f"ai_matched_{conf}"] += 1
            else:
                stats["still_unmatched"] += 1

        row["esco_label_fr"] = fr_labels.get(uri, "") if uri else ""
        if uri:
            ar = ar_map.get(uri, "")
            if not ar:
                missing_ar.add(uri)
            row["esco_label_ar"] = ar
        else:
            row["esco_label_ar"] = ""
        w.writerow(row)

print("=== Final merge stats ===", file=sys.stderr)
for k, v in stats.items():
    print(f"{k}: {v}", file=sys.stderr)
print(f"Wrote {out_path}", file=sys.stderr)
if missing_ar:
    print(f"WARNING: {len(missing_ar)} matched occupations still missing Arabic:", file=sys.stderr)
    for u in list(missing_ar)[:20]:
        print("  ", u, uri_preferred_en.get(u, ""), file=sys.stderr)
