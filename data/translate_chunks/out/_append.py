import csv, sys
IN = '/home/user/titles/data/translate_chunks/titles_00.csv'
OUT = '/home/user/titles/data/translate_chunks/out/titles_00_tr.csv'
start, end = int(sys.argv[1]), int(sys.argv[2])
src = sys.stdin.read().splitlines()
tr = {}
for line in src:
    if not line.strip():
        continue
    parts = line.split('|')
    assert len(parts) == 5, line
    tr[parts[0].strip()] = [p.strip() for p in parts[1:]]
with open(IN, newline='', encoding='utf-8') as f:
    rows = list(csv.DictReader(f))
batch = rows[start:end]
ranks = [r['rank'] for r in batch]
assert set(ranks) == set(tr.keys()), (set(ranks) ^ set(tr.keys()))
write_header = not __import__('os').path.exists(OUT)
with open(OUT, 'a', newline='', encoding='utf-8') as f:
    w = csv.writer(f)
    if write_header:
        w.writerow(['rank', 'title_es', 'title_pt', 'title_fr', 'title_ar'])
    for r in batch:
        w.writerow([r['rank']] + tr[r['rank']])
print('appended', len(batch), 'rows; total items so far ->', end)
