#!/usr/bin/env python3
"""
Fetch periodic groundwater-level measurements from DWR's CKAN datastore for the
80-well Vina monitoring network and emit the dashboard's data files.

Reads:
    data/vina_2022_monitoring_network.csv
Writes:
    js/measurements-data.js  - const MEASUREMENTS = { site_code: [...], ... }
    js/wells-data.js         - const WELLS = [ {site_code, ...metadata}, ... ]
                               and const MEASUREMENTS_FETCHED_AT = "..."
"""

import csv
import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

DWR_API = "https://data.cnra.ca.gov/api/3/action/datastore_search"
PERIODIC_RESOURCE_ID = "bfa9f262-24a1-45bd-8dc8-138bc8107266"

PROJECT_ROOT = Path(__file__).parent.parent
WELLS_CSV = PROJECT_ROOT / "data" / "vina_2022_monitoring_network.csv"
OUT_MEASUREMENTS_JS = PROJECT_ROOT / "js" / "measurements-data.js"
OUT_WELLS_JS = PROJECT_ROOT / "js" / "wells-data.js"


def fetch_periodic(site_code: str):
    out = []
    offset = 0
    while True:
        params = {
            "resource_id": PERIODIC_RESOURCE_ID,
            "filters": json.dumps({"site_code": site_code}),
            "limit": 1000,
            "offset": offset,
        }
        url = f"{DWR_API}?{urllib.parse.urlencode(params)}"
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.load(resp)
        except Exception as e:
            print(f"  ! {site_code} fetch failed at offset {offset}: {e}", flush=True)
            break
        if not data.get("success"):
            break
        recs = data.get("result", {}).get("records", [])
        if not recs:
            break
        out.extend(recs)
        if len(recs) < 1000:
            break
        offset += 1000
    return out


def process_records(records):
    processed = []
    for rec in records:
        if not rec.get("msmt_date"):
            continue
        date_str = str(rec["msmt_date"]).split("T")[0]
        try:
            gwe = float(rec["gwe"]) if rec.get("gwe") not in (None, "") else None
        except (TypeError, ValueError):
            gwe = None
        try:
            dtw = float(rec["gse_gwe"]) if rec.get("gse_gwe") not in (None, "") else None
        except (TypeError, ValueError):
            dtw = None
        processed.append({
            "d": date_str,
            "gwe": gwe,
            "dtw": dtw,
            "qa": rec.get("wlm_qa_desc"),
            "qd": rec.get("wlm_qa_detail") or "",
            "org": rec.get("wlm_org_name") or "",
        })
    processed.sort(key=lambda r: r["d"])
    return processed


def load_wells():
    rows = []
    with open(WELLS_CSV) as f:
        for r in csv.DictReader(f):
            for k in ("latitude", "longitude", "gse", "rpe", "well_depth",
                      "mt_ft", "mo_ft", "im_2027_ft"):
                if r[k] not in ("", None):
                    try:
                        r[k] = float(r[k])
                    except (TypeError, ValueError):
                        r[k] = None
                else:
                    r[k] = None
            for k in ("is_2022_gwl_rms", "is_2026_gwl_rms", "is_2026_isw_rms",
                      "multi_completion"):
                r[k] = (r[k] or "").lower() == "true"
            rows.append(r)
    return rows


def main() -> int:
    if not WELLS_CSV.exists():
        print(f"ERROR: {WELLS_CSV} missing - run build_wells_csv.py first", file=sys.stderr)
        return 1

    wells = load_wells()
    fetchable = [w for w in wells if w["site_code"]]
    no_dwr = [w for w in wells if not w["site_code"]]
    print(f"Loaded {len(wells)} wells ({len(fetchable)} with DWR site_codes; "
          f"{len(no_dwr)} without - {[w['well_name'] for w in no_dwr]})")

    measurements = {}
    counts = {"good": 0, "questionable": 0, "missing": 0, "other": 0}
    failures = []
    completed = 0

    def fetch_one(w):
        return w, process_records(fetch_periodic(w["site_code"]))

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(fetch_one, w): w for w in fetchable}
        for fut in as_completed(futures):
            w = futures[fut]
            try:
                _, processed = fut.result()
            except Exception as e:
                processed = []
                print(f"  ! {w['well_name']}: {e}", flush=True)
            completed += 1
            if not processed:
                failures.append(w["well_name"])
            measurements[w["site_code"]] = processed
            for r in processed:
                qa = (r["qa"] or "").lower()
                if "good" in qa:
                    counts["good"] += 1
                elif "question" in qa:
                    counts["questionable"] += 1
                elif "missing" in qa:
                    counts["missing"] += 1
                else:
                    counts["other"] += 1
            print(f"  [{completed:>2}/{len(fetchable)}] {w['well_name']:<22} "
                  f"{len(processed):>5} records", flush=True)

    for w in no_dwr:
        measurements[w["well_name"]] = []

    timestamp = datetime.now(timezone.utc).isoformat()

    OUT_MEASUREMENTS_JS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_MEASUREMENTS_JS, "w") as f:
        total = sum(counts.values())
        f.write("// Auto-generated by scripts/fetch_dwr_data.py - do not edit by hand.\n")
        f.write(f"// Source: DWR CKAN periodic measurements (resource {PERIODIC_RESOURCE_ID}).\n")
        f.write(f"// Fetched: {timestamp}\n")
        f.write(f"// Wells: {len(measurements)} | Records: {total} "
                f"({counts['good']} Good, {counts['questionable']} Questionable, "
                f"{counts['missing']} Missing, {counts['other']} other)\n")
        if failures:
            f.write(f"// Wells returning no DWR records: {', '.join(failures)}\n")
        f.write("\n")
        f.write(f"const MEASUREMENTS_FETCHED_AT = {json.dumps(timestamp)};\n")
        f.write(f"const MEASUREMENTS = {json.dumps(measurements, separators=(',', ':'))};\n")

    with open(OUT_WELLS_JS, "w") as f:
        f.write("// Auto-generated by scripts/fetch_dwr_data.py - do not edit by hand.\n")
        f.write(f"// Source: data/vina_2022_monitoring_network.csv ({len(wells)} wells).\n")
        f.write(f"// Generated: {timestamp}\n\n")
        f.write(f"const WELLS = {json.dumps(wells, separators=(',', ':'))};\n")

    print(f"\nWrote {OUT_MEASUREMENTS_JS.relative_to(PROJECT_ROOT)} ({len(measurements)} wells)")
    print(f"Wrote {OUT_WELLS_JS.relative_to(PROJECT_ROOT)} ({len(wells)} wells)")
    if failures:
        print(f"  Empty DWR result: {', '.join(failures)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
