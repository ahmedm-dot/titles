import csv, re, sys
from collections import defaultdict

DATA = "/home/user/titles/data"

# Only true noise words are dropped. Modifiers like "senior", "head", "deputy"
# are semantically load-bearing for occupation titles and must NOT be stripped,
# otherwise unrelated specific ESCO occupations collapse onto generic titles.
NOISE = {"a","an","the","of","and","or","for","in","to","at","on","with","&"}

def norm_tokens(s):
    s = s.lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return [t for t in s.split() if t and t not in NOISE]

def singularize(tok):
    if len(tok) > 4 and tok.endswith("ies"):
        return tok[:-3] + "y"
    if len(tok) > 4 and tok.endswith("ses"):
        return tok[:-2]
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
        return tok[:-1]
    return tok

def sing_tokens(s):
    return [singularize(t) for t in norm_tokens(s)]

def norm_key(s):
    toks = sing_tokens(s)
    return " ".join(sorted(toks)), " ".join(toks), toks

# Generic single/double-word role titles that ESCO does not carry as a
# standalone occupation (ESCO occupations are specific, e.g. "sales manager",
# not bare "manager"). These are only ever accepted on an exact label match.
GENERIC_BARE = {
    "manager","teacher","engineer","specialist","operator","analyst",
    "coordinator","director","assistant","supervisor","technician",
    "consultant","worker","clerk","inspector","associate","representative",
    "administrator","officer","executive","planner","designer","developer",
    "advisor","adviser","agent","lead","president","controller","auditor",
}

# ---- Load ESCO occupations ----
def load_lang(lang):
    d = {}
    with open(f"{DATA}/esco_occupations_{lang}.csv", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            d[row["conceptUri"]] = row["preferredLabel"]
    return d

en_rows = []
with open(f"{DATA}/esco_occupations_en.csv", newline="", encoding="utf-8") as f:
    r = csv.DictReader(f)
    for row in r:
        en_rows.append(row)

es_labels = load_lang("es")
pt_labels = load_lang("pt")

# exact_index/ordered_index are filled in two passes so a title that is
# literally an occupation's preferredLabel always wins over one that merely
# collides with some *other* occupation's altLabel (ESCO altLabels routinely
# include over-generic synonyms, e.g. "teacher" is an altLabel of the very
# specific "politics lecturer" concept).
exact_index = {}
ordered_index = {}
exact_source = {}   # key -> "preferred" | "alt"
pref_exact_index = {}
pref_ordered_index = {}
token_index = defaultdict(set)
lastword_index = defaultdict(set)
uri_variant_tokens = defaultdict(list)  # uri -> list of (variant_text, tokens_list, last_word)
uri_preferred_en = {}

for row in en_rows:
    uri = row["conceptUri"]
    uri_preferred_en[uri] = row["preferredLabel"]
    v = row["preferredLabel"].strip()
    skey, okey, toks = norm_key(v)
    if toks:
        exact_index[skey] = uri
        ordered_index[okey] = uri
        exact_source[skey] = "preferred"
        exact_source[okey] = "preferred"
        pref_exact_index[skey] = uri
        pref_ordered_index[okey] = uri

for row in en_rows:
    uri = row["conceptUri"]
    variants = [row["preferredLabel"]]
    if row["altLabels"]:
        variants += [v for v in row["altLabels"].split("\n") if v.strip()]
    for v in variants:
        v = v.strip()
        if not v:
            continue
        skey, okey, toks = norm_key(v)
        if not toks:
            continue
        if skey not in exact_index:
            exact_index[skey] = uri
            exact_source[skey] = "alt"
        if okey not in ordered_index:
            ordered_index[okey] = uri
            exact_source[okey] = "alt"
        last = toks[-1]
        uri_variant_tokens[uri].append((v, toks, last))
        for t in set(toks):
            token_index[t].add(uri)
        lastword_index[last].add(uri)

def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0

def best_fuzzy(title_toks):
    if not title_toks:
        return None, 0.0, None
    title_set = set(title_toks)
    last = title_toks[-1]
    # Hard filter: candidate must share the head/last word with the title,
    # otherwise matches drift onto semantically unrelated occupations.
    candidates = lastword_index.get(last, set())
    if not candidates:
        return None, 0.0, None
    best_uri, best_score, best_variant = None, 0.0, None
    for uri in candidates:
        for variant, vtoks, vlast in uri_variant_tokens[uri]:
            vset = set(vtoks)
            score = jaccard(title_set, vset)
            # penalize large length mismatches between title and label
            ratio = min(len(title_set), len(vset)) / max(len(title_set), len(vset))
            score *= (0.5 + 0.5 * ratio)
            if score > best_score:
                best_score, best_uri, best_variant = score, uri, variant
    return best_uri, best_score, best_variant

def match_title(title_norm):
    skey, okey, toks = norm_key(title_norm)
    if not toks:
        return None, "no_match", 0.0, None

    is_generic_bare = len(toks) <= 2 and all(t in GENERIC_BARE for t in toks)

    if is_generic_bare:
        # Bare generic roles ("Teacher", "Manager", "Technician"...) are only
        # trusted against another occupation's *preferredLabel* -- altLabel
        # hits on these are almost always ESCO over-generalizing a narrow
        # occupation's synonyms, not a real match for the bare title.
        if okey in pref_ordered_index:
            return pref_ordered_index[okey], "exact_preferred", 1.0, None
        if skey in pref_exact_index:
            return pref_exact_index[skey], "exact_preferred_reordered", 1.0, None
        return None, "no_match_generic", 0.0, None

    if okey in ordered_index:
        mtype = "exact_preferred" if exact_source[okey] == "preferred" else "exact_altlabel"
        return ordered_index[okey], mtype, 1.0, None
    if skey in exact_index:
        mtype = "exact_preferred_reordered" if exact_source[skey] == "preferred" else "exact_altlabel_reordered"
        return exact_index[skey], mtype, 1.0, None

    uri, score, variant = best_fuzzy(toks)
    if uri is None:
        return None, "no_match", 0.0, None
    # Spot-checks: >=0.65 is usually right, 0.45-0.65 is a mixed bag (roughly
    # coin-flip), below that is mostly wrong. Both fuzzy bands are kept (never
    # silently dropped) but labeled by confidence so a consumer can choose a
    # cutoff -- treat "fuzzy_low_conf" as suggestions that need human review,
    # not as auto-applied labels.
    if score >= 0.65:
        return uri, "fuzzy_medium_conf", score, variant
    if score >= 0.45:
        return uri, "fuzzy_low_conf", score, variant
    return None, "no_match", score, variant

def main():
    in_path = f"{DATA}/job_titles_full.csv"
    out_path = f"{DATA}/job_titles_esco_matched.csv"
    matched_uris = set()
    stats = defaultdict(int)
    with open(in_path, newline="", encoding="utf-8") as fin, \
         open(out_path, "w", newline="", encoding="utf-8") as fout:
        r = csv.DictReader(fin)
        fieldnames = r.fieldnames + [
            "esco_match_type", "esco_match_score", "esco_concept_uri",
            "esco_label_en", "esco_label_es", "esco_label_pt", "esco_matched_variant"
        ]
        w = csv.DictWriter(fout, fieldnames=fieldnames)
        w.writeheader()
        for i, row in enumerate(r):
            uri, mtype, score, variant = match_title(row["norm"])
            stats[mtype] += 1
            out = dict(row)
            out["esco_match_type"] = mtype
            out["esco_match_score"] = f"{score:.3f}"
            if uri:
                matched_uris.add(uri)
                out["esco_concept_uri"] = uri
                out["esco_label_en"] = uri_preferred_en.get(uri, "")
                out["esco_label_es"] = es_labels.get(uri, "")
                out["esco_label_pt"] = pt_labels.get(uri, "")
                out["esco_matched_variant"] = variant or ""
            else:
                out["esco_concept_uri"] = ""
                out["esco_label_en"] = ""
                out["esco_label_es"] = ""
                out["esco_label_pt"] = ""
                out["esco_matched_variant"] = ""
            w.writerow(out)
            if (i+1) % 10000 == 0:
                print(f"...{i+1} rows processed", file=sys.stderr)

    print("=== Match stats ===", file=sys.stderr)
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"{k}: {v}", file=sys.stderr)
    print(f"Distinct ESCO occupations matched: {len(matched_uris)}", file=sys.stderr)

    with open(f"{DATA}/esco_matched_distinct_en.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["conceptUri", "preferredLabel_en"])
        for uri in sorted(matched_uris, key=lambda u: uri_preferred_en.get(u,"")):
            w.writerow([uri, uri_preferred_en.get(uri, "")])

if __name__ == "__main__":
    main()
