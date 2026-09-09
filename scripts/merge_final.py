import csv, glob, sys

DATA = "/home/user/titles/data"

ar_map = {}
total_ar_rows = 0
for path in sorted(glob.glob(f"{DATA}/chunks/out/chunk_*_ar.csv")):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            uri = row["conceptUri"].strip()
            ar = row["label_ar"].strip()
            if uri:
                ar_map[uri] = ar
                total_ar_rows += 1

print(f"Loaded {total_ar_rows} Arabic translations covering {len(ar_map)} distinct occupations", file=sys.stderr)

in_path = f"{DATA}/job_titles_esco_matched.csv"
out_path = f"{DATA}/job_titles_esco_final.csv"

missing_ar = set()
with open(in_path, newline="", encoding="utf-8") as fin, \
     open(out_path, "w", newline="", encoding="utf-8") as fout:
    r = csv.DictReader(fin)
    fieldnames = r.fieldnames + ["esco_label_ar"]
    w = csv.DictWriter(fout, fieldnames=fieldnames)
    w.writeheader()
    for row in r:
        uri = row["esco_concept_uri"]
        ar = ""
        if uri:
            ar = ar_map.get(uri, "")
            if not ar:
                missing_ar.add(uri)
        row["esco_label_ar"] = ar
        w.writerow(row)

print(f"Wrote {out_path}", file=sys.stderr)
if missing_ar:
    print(f"WARNING: {len(missing_ar)} matched occupations have no Arabic translation:", file=sys.stderr)
    for u in list(missing_ar)[:20]:
        print("  ", u, file=sys.stderr)
