import csv, glob, sys

DATA = "/home/user/titles/data"

rank_to_tr = {}
for path in sorted(glob.glob(f"{DATA}/translate_chunks/out/titles_*_tr.csv")):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            rank = row["rank"].strip()
            if rank:
                rank_to_tr[rank] = row

print(f"Loaded {len(rank_to_tr)} direct translations", file=sys.stderr)

in_path = f"{DATA}/job_titles_esco_final.csv"
out_path = f"{DATA}/job_titles_esco_final_v3.csv"

missing = 0
with open(in_path, newline="", encoding="utf-8") as fin, \
     open(out_path, "w", newline="", encoding="utf-8") as fout:
    r = csv.DictReader(fin)
    fieldnames = r.fieldnames + ["title_es", "title_pt", "title_fr", "title_ar"]
    w = csv.DictWriter(fout, fieldnames=fieldnames)
    w.writeheader()
    for row in r:
        if not row["esco_concept_uri"]:
            tr = rank_to_tr.get(row["rank"])
            if tr:
                row["title_es"] = tr["title_es"]
                row["title_pt"] = tr["title_pt"]
                row["title_fr"] = tr["title_fr"]
                row["title_ar"] = tr["title_ar"]
            else:
                missing += 1
                row["title_es"] = row["title_pt"] = row["title_fr"] = row["title_ar"] = ""
        else:
            row["title_es"] = row["title_pt"] = row["title_fr"] = row["title_ar"] = ""
        w.writerow(row)

print(f"Wrote {out_path}", file=sys.stderr)
print(f"Unmatched rows missing a direct translation: {missing}", file=sys.stderr)
