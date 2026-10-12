#!/usr/bin/env python3
"""
Convert a GEDCOM family-tree export into the privacy-filtered data.json used by
/family-history/.

    python3 scripts/family-history/gedcom_to_json.py my-tree.ged \
        -o family-history/data.json --root "Arthur Vance"

PRIVACY (this site and repo are public):
  * Only people who are DECEASED are written out. Everyone else is dropped completely
    (no name, no id, no mention), and every link to them is removed.
  * A person counts as deceased only if the file records a death/burial, or they were born
    more than --living-cutoff years ago (default 110). Anyone with no dates at all is treated
    as living. People marked private (RESN) are always dropped.
  * Only name, sex, birth/death/marriage dates and places, and occupation are kept. Notes are
    left out unless --include-notes is given. House-numbered address parts are removed from
    places and at most the last four parts are kept, unless --keep-places is given.
  * The report printed at the end contains COUNTS ONLY, never names.

Never commit the .ged file itself (.gitignore blocks it).
"""
import argparse
import datetime
import json
import re
import sys

MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------- reading
def read_text(path):
    raw = open(path, "rb").read()
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig")
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")   # ANSI / ANSEL-ish exports


LINE = re.compile(r"^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s(.*))?$")


class Node:
    __slots__ = ("level", "xref", "tag", "value", "kids")

    def __init__(self, level, xref, tag, value):
        self.level, self.xref, self.tag, self.value, self.kids = level, xref, tag, value or "", []

    def get(self, tag):
        for k in self.kids:
            if k.tag == tag:
                return k
        return None

    def all(self, tag):
        return [k for k in self.kids if k.tag == tag]

    def text(self):
        """Value including CONC/CONT continuation lines."""
        out = self.value
        for k in self.kids:
            if k.tag == "CONC":
                out += k.value
            elif k.tag == "CONT":
                out += "\n" + k.value
        return out


def parse(text):
    roots, stack = [], []
    for line in text.splitlines():
        line = line.lstrip("﻿")
        m = LINE.match(line)
        if not m:
            continue
        lvl, xref, tag, val = int(m.group(1)), m.group(2), m.group(3).upper(), m.group(4)
        node = Node(lvl, xref, tag, val)
        while stack and stack[-1].level >= lvl:
            stack.pop()
        if stack:
            stack[-1].kids.append(node)
        else:
            roots.append(node)
        stack.append(node)
    return roots


# ---------------------------------------------------------------- values
def clean_xref(x):
    return x.strip("@") if x else None


def parse_name(node):
    n = node.get("NAME") if node else None
    if not n:
        return "", "", ""
    given = (n.get("GIVN").value.strip() if n.get("GIVN") else "")
    sur = (n.get("SURN").value.strip() if n.get("SURN") else "")
    m = re.match(r"^\s*(.*?)\s*/([^/]*)/\s*(.*?)\s*$", n.value)
    if m:
        given = given or m.group(1).strip()
        sur = sur or m.group(2).strip()
        suffix = m.group(3).strip()
    else:
        given = given or n.value.strip()
        suffix = ""
    # Genealogy sites use "Unknown" / "[Unknown]" as a placeholder surname or given name.
    unk = re.compile(r"^\[?\s*(unknown|unk|\?+)\s*\]?$", re.I)
    if unk.match(sur):
        sur = ""
        suffix = (suffix + " (surname unknown)").strip() if given and not unk.match(given) else suffix
    if unk.match(given):
        given = "Unknown" if not sur else ""
    full = " ".join(p for p in (given, sur, suffix) if p)
    return re.sub(r"\s+", " ", full), given, sur


def parse_date(raw):
    """Returns (display text, year or None, ISO date if complete else None)."""
    if not raw:
        return "", None, None
    s = re.sub(r"\s+", " ", raw.strip())
    iso = None

    def one(part):
        nonlocal iso
        m = re.match(r"^(?:(\d{1,2})\s+)?(?:([A-Za-z]{3})[A-Za-z]*\s+)?(\d{3,4})(?:/\d{2})?$", part.strip())
        if not m:
            return part.strip()
        d, mon, y = m.group(1), (m.group(2) or "").upper(), m.group(3)
        if mon in MONTHS and d:
            try:
                iso = datetime.date(int(y), MONTHS[mon], int(d)).isoformat()
            except ValueError:
                pass
            return f"{int(d)} {MONTH_NAMES[MONTHS[mon] - 1]} {y}"
        if mon in MONTHS:
            return f"{MONTH_NAMES[MONTHS[mon] - 1]} {y}"
        return y

    up = s.upper()
    mod = None
    for key, word in (("ABT", "c."), ("ABOUT", "c."), ("CAL", "c."), ("EST", "c."),
                      ("BEF", "before"), ("AFT", "after")):
        if up.startswith(key + " "):
            mod = word
            s = s[len(key) + 1:]
            break
    between = re.match(r"^BET\s+(.+?)\s+AND\s+(.+)$", s, re.I)
    if between:
        text = f"between {one(between.group(1))} and {one(between.group(2))}"
        iso = None
    else:
        text = one(s)
        if mod:
            text, iso = f"{mod} {text}", None
    years = re.findall(r"\b(\d{4})\b", text)
    return text, (int(years[0]) if years else None), iso


def trim_place(p, keep):
    """Drop house-numbered address parts ("14 Mill Lane", "11") from the front and keep at most
    the last four parts (town, county, country...). --keep-places leaves the text untouched."""
    p = re.sub(r"\s+", " ", (p or "").strip().strip(","))
    if keep or not p:
        return p
    parts = [x.strip() for x in p.split(",") if x.strip()]
    while len(parts) > 1 and re.match(r"^\d", parts[0]):
        parts.pop(0)
    return ", ".join(parts[-4:])


def event(node, tag, keep_places):
    ev = node.get(tag) if node else None
    if not ev:
        return None
    t, y, iso = parse_date(ev.get("DATE").value if ev.get("DATE") else "")
    pl = trim_place(ev.get("PLAC").value if ev.get("PLAC") else "", keep_places)
    out = {}
    if t:
        out["t"] = t
    if y:
        out["y"] = y
    if iso:
        out["i"] = iso
    if pl:
        out["p"] = pl
    return out or None


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="GEDCOM -> privacy-filtered family-history data.json")
    ap.add_argument("gedcom")
    ap.add_argument("-o", "--out", default="family-history/data.json")
    ap.add_argument("--root", help="Default person shown: a name (or part of one) or a GEDCOM id such as I12")
    ap.add_argument("--title", default="Family History")
    ap.add_argument("--living-cutoff", type=int, default=110,
                    help="People with no death record born more recently than this many years ago are treated as living")
    ap.add_argument("--include", action="append", default=[], metavar="ID",
                    help="Also include this living person by GEDCOM id, with NAME ONLY (no dates, places or links). "
                         "Use only for someone who has agreed, e.g. yourself.")
    ap.add_argument("--link-living", action="store_true",
                    help="Where a living person is the only link between two kept people (e.g. a parent between a "
                         "deceased grandparent and an included grandchild), show a nameless \"Living\" placeholder "
                         "so the tree stays connected. Nothing about them is written except that link.")
    ap.add_argument("--keep-places", action="store_true", help="Keep full place text (street addresses included)")
    ap.add_argument("--include-notes", action="store_true", help="Include notes (review them first)")
    a = ap.parse_args()

    recs = parse(read_text(a.gedcom))
    indi = {clean_xref(r.xref): r for r in recs if r.tag == "INDI" and r.xref}
    fam = {clean_xref(r.xref): r for r in recs if r.tag == "FAM" and r.xref}
    this_year = datetime.date.today().year

    include = {x.strip().strip("@") for x in a.include}

    # Relationship maps from the raw file (used for inference and for linking placeholders).
    kids_of, parents_of = {}, {}
    for fid, fr in fam.items():
        ps = [clean_xref(x.value.strip()) for t in ("HUSB", "WIFE") for x in fr.all(t)]
        cs = [clean_xref(c.value.strip()) for c in fr.all("CHIL")]
        for pp in ps:
            for cc in cs:
                kids_of.setdefault(pp, []).append(cc)
                parents_of.setdefault(cc, []).append(pp)

    def birth_year(rec):
        return (event(rec, "BIRT", True) or {}).get("y")

    def base_dead(rec):
        by = birth_year(rec)
        return bool(rec.get("DEAT") is not None or rec.get("BURI") is not None or rec.get("CREM") is not None
                    or (by is not None and by <= this_year - a.living_cutoff))

    # An undated person whose child was born long ago must be deceased too (a parent is at least ~15
    # years older than their child), so infer that rather than leaving a hole in the tree.
    inferred = set()
    for pid, rec in indi.items():
        if base_dead(rec) or pid in include:
            continue
        ys = [birth_year(indi[c]) for c in kids_of.get(pid, []) if c in indi and birth_year(indi[c])]
        if ys and min(ys) <= this_year - a.living_cutoff + 15:
            inferred.add(pid)
    people, stats = {}, {"total": len(indi), "deceased": 0, "living_or_unknown": 0, "private": 0, "included": 0}
    for pid, r in indi.items():
        if pid in include:
            # Explicitly requested living person: name only. No dates, places or living relatives.
            full, given, sur = parse_name(r)
            p = {"n": full or "Unknown", "s": sur}
            sex = (r.get("SEX").value.strip().upper()[:1] if r.get("SEX") else "")
            if sex in ("M", "F"):
                p["x"] = sex
            famc = r.get("FAMC")
            if famc:
                p["famc"] = clean_xref(famc.value.strip())
            p["fams"] = []
            people[pid] = p
            stats["included"] += 1
            continue
        resn = r.get("RESN")
        if resn and resn.value.strip().lower() in ("privacy", "confidential", "locked"):
            stats["private"] += 1
            continue
        b = event(r, "BIRT", a.keep_places)
        d = event(r, "DEAT", a.keep_places)
        dead = base_dead(r) or pid in inferred
        if not dead:
            stats["living_or_unknown"] += 1
            continue
        stats["deceased"] += 1
        full, given, sur = parse_name(r)
        p = {"n": full or "Unknown", "s": sur}
        sex = (r.get("SEX").value.strip().upper()[:1] if r.get("SEX") else "")
        if sex in ("M", "F"):
            p["x"] = sex
        if b:
            p["b"] = b
        if d:
            p["d"] = d
        occ = r.get("OCCU")
        if occ and occ.text().strip():
            p["o"] = re.sub(r"\s+", " ", occ.text().strip())[:80]
        if a.include_notes:
            notes = [n.text().strip() for n in r.all("NOTE") if n.text().strip()]
            if notes:
                p["note"] = "\n\n".join(notes)[:1500]
        famc = r.get("FAMC")
        if famc:
            p["famc"] = clean_xref(famc.value.strip())
        p["fams"] = [clean_xref(f.value.strip()) for f in r.all("FAMS")]
        people[pid] = p

    # Optional nameless placeholders so a living person between two kept people doesn't cut the tree in two.
    placeholders = {}
    if a.link_living:
        for pid, rec in indi.items():
            if pid in people or (rec.get("RESN") and rec.get("RESN").value.strip().lower() in ("privacy", "confidential", "locked")):
                continue
            up = any(pp in people for pp in parents_of.get(pid, []))
            down = any(cc in people for cc in kids_of.get(pid, []))
            if up and down:
                placeholders[pid] = {"n": "Living", "living": True}
                famc = rec.get("FAMC")
                if famc:
                    placeholders[pid]["famc"] = clean_xref(famc.value.strip())
                placeholders[pid]["fams"] = [clean_xref(f.value.strip()) for f in rec.all("FAMS")]
        people.update(placeholders)

    families = {}
    for fid, r in fam.items():
        h = clean_xref(r.get("HUSB").value.strip()) if r.get("HUSB") else None
        w = clean_xref(r.get("WIFE").value.strip()) if r.get("WIFE") else None
        kids = [clean_xref(c.value.strip()) for c in r.all("CHIL")]
        h = h if h in people else None
        w = w if w in people else None
        kids = [c for c in kids if c in people]
        if not (h or w or kids):
            continue
        f = {}
        if h:
            f["h"] = h
        if w:
            f["w"] = w
        if kids:
            f["c"] = kids
        m = event(r, "MARR", a.keep_places)
        if m:
            f["m"] = m
        if r.get("DIV") is not None:
            f["div"] = True
        families[fid] = f

    # Drop references to families that no longer exist or that a person isn't actually part of.
    for pid, p in people.items():
        if p.get("famc") not in families or pid not in families[p["famc"]].get("c", []):
            p.pop("famc", None)
        p["fams"] = [f for f in p.get("fams", []) if f in families and pid in (families[f].get("h"), families[f].get("w"))]
        if not p["fams"]:
            del p["fams"]

    # Choose the default focus person.
    root = None
    if a.root:
        key = a.root.strip()
        if key.strip("@") in people:
            root = key.strip("@")
        else:
            hits = [i for i, p in people.items() if key.lower() in p["n"].lower()]
            if hits:
                root = hits[0]
            else:
                print(f"WARNING: --root '{key}' did not match any deceased person; picking one automatically.", file=sys.stderr)
    if not root and people:
        def reach(pid):
            seen, todo = {pid}, [pid]
            while todo:
                x = todo.pop()
                p = people[x]
                nxt = []
                if p.get("famc"):
                    nxt += [families[p["famc"]].get("h"), families[p["famc"]].get("w")]
                for f in p.get("fams", []):
                    nxt += [families[f].get("h"), families[f].get("w")] + families[f].get("c", [])
                for n in nxt:
                    if n and n not in seen:
                        seen.add(n)
                        todo.append(n)
            return len(seen)
        root = max(people, key=reach)

    years = [y for p in people.values() for y in (p.get("b", {}).get("y"), p.get("d", {}).get("y")) if y]
    out = {
        "meta": {
            "title": a.title,
            "updated": datetime.date.today().isoformat(),
            "privacy": "Deceased people only",
            "root": root,
            "people": sum(1 for p in people.values() if not p.get("living")),
            "from": min(years) if years else None,
            "to": max(years) if years else None,
        },
        "people": people,
        "families": families,
    }
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    print(f"Read {stats['total']} people from the GEDCOM.")
    print(f"  Kept (deceased):                      {stats['deceased']}")
    print(f"  Dropped (living, or no dates at all): {stats['living_or_unknown']}")
    print(f"  Dropped (marked private):             {stats['private']}")
    if inferred:
        print(f"  Inferred deceased (undated, but a child born long ago): {len(inferred)}")
    if placeholders:
        print(f"  Nameless 'Living' placeholders (links only):          {len(placeholders)}")
    if stats["included"]:
        print(f"  Included by request (name only):      {stats['included']}")
    print(f"  Families written:                     {len(families)}")
    print(f"  Default focus person id:              {root}")
    print(f"Wrote {a.out}. Review it before committing; it will be public.")


if __name__ == "__main__":
    main()
