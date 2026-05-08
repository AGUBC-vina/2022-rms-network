#!/usr/bin/env python3
"""
Build the canonical wells CSV for the 2022 RMS Network dashboard from the
2026-05-02 monitoring-network spreadsheet.

Reads:
    data/2026-05-02 Network - USE.xlsx     - 80-row monitoring network table
Writes:
    data/vina_2022_monitoring_network.csv  - canonical well list w/ DWR site_codes
                                             and per-well 2022 GSP thresholds for
                                             the 17 wells flagged 2022 GWL RMS.

For wells whose state-well number is in the 2027 dashboard's known list we reuse
the site_code; for any unknown well we fall back to a DWR station_list lookup.
"""

import csv
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import openpyxl

PROJECT_ROOT = Path(__file__).parent.parent
XLSX = PROJECT_ROOT / "data" / "2026-05-02 Network - USE.xlsx"
OUT_CSV = PROJECT_ROOT / "data" / "vina_2022_monitoring_network.csv"

DWR_API = "https://data.cnra.ca.gov/api/3/action/datastore_search"
STATIONS_RESOURCE = "af157380-fb42-4abf-b72a-6f9f98868077"

# Site codes harvested from the prior dashboards' canonical files (2026 and the
# original cosmo1007/vina-subbasin-dashboard). Keyed by the spreadsheet's
# "SWN or Well Name" column.
KNOWN_SITE_CODES = {
    "20N03E33L001M": "395435N1216466W001",
    "20N03E31M001M": "395446N1216873W001",
    "20N02E24C001M": "395812N1217026W001",
    "20N02E24C002M": "395812N1217026W002",
    "20N02E24C003M": "395812N1217026W003",
    "20N02E08H003M": "396064N1217695W001",
    "20N02E09L001M": "396066N1217586W001",
    "20N02E08C001M": "396069N1217736W002",
    "20N01E10C002M": "396097N1218487W001",
    "20N02E06Q001M": "396127N1217883W001",
    "20N02E09G001M": "396154N1217391W001",
    "20N01E02H003M": "396158N1218221W001",
    "21N02E32E001M": "396339N1217845W001",
    "21N03E32B001M": "396396N1216634W001",
    "21N01E25K001M": "396420N1218128W001",
    "21N02E30L001M": "396422N1217994W001",
    "21N03E29J003M": "396454N1216588W001",
    "21N01E26K001M": "396454N1218313W001",
    "21N02E26E003M": "396468N1217263W001",
    "21N02E26E004M": "396468N1217263W002",
    "21N02E26E005M": "396468N1217263W003",
    "21N02E26E006M": "396468N1217263W004",
    "21N01E28F001M": "396490N1218726W001",
    "21N01E27D001M": "396511N1218607W001",
    "21N01E27B001M": "396528N1218526W001",
    "21N02E20P001M": "396568N1217818W001",
    "21N01E21C001M": "396654N1218780W001",
    "21N01E14Q002M": "396691N1218298W001",
    "21N01E13L002M": "396735N1218144W001",
    "21N01E13L003M": "396735N1218144W002",
    "21N01E13L004M": "396735N1218144W003",
    "21N01E13F001M": "396769N1218157W001",
    "21N02E18C001M": "396820N1217970W001",
    "21N02E18C002M": "396820N1217970W002",
    "21N02E18C003M": "396820N1217970W003",
    "21N01E12K001M": "396892N1218121W001",
    "21N01E12D001M": "396932N1218231W001",
    "21N01E10B003M": "396963N1218486W001",
    "CWSCH01b": "397284N1218374W001",
    "CWSCH02": "397284N1218374W002",
    "CWSCH03": "397284N1218374W003",
    "CWSCH07": "397284N1218374W004",
    "CWSCH04": "397284N1218374W005",
    "CWSCH05": "397284N1218374W006",
    "CWSCH06": "397284N1218374W007",
    "22N01E28J001M": "397317N1218649W001",
    "22N01E28J003M": "397317N1218649W002",
    "22N01E28J005M": "397317N1218649W003",
    "22N02E30C002M": "397383N1217982W001",
    "22N01E20K001M": "397445N1218905W001",
    "22N02E18J001M": "397619N1217891W001",
    "22N01E09B001M": "397818N1218718W001",
    "22N01W05M001M": "397871N1220100W001",
    "23N01W36P001M": "397972N1219297W001",
    "23N01W31M001M": "398028N1220294W001",
    "23N01W31M002M": "398028N1220294W002",
    "23N01W31M003M": "398028N1220294W003",
    "23N01W31M004M": "398028N1220294W004",
    "23N01E33A001M": "398097N1218630W001",
    "23N01E29P002M": "398133N1218913W001",
    "23N01W27L001M": "398180N1219669W001",
    "23N01W28M002M": "398188N1219912W001",
    "23N01W28M003M": "398188N1219912W002",
    "23N01W28M004M": "398188N1219912W003",
    "23N01W28M005M": "398188N1219912W004",
    "23N02W25C001M": "398222N1220401W001",
    "23N01W25G001M": "398223N1219276W001",
    "23N01W14R002M": "398411N1219399W001",
    "23N01W16E001M": "398501N1219934W001",
    "23N01W10M001M": "398619N1219746W001",
    "23N01W10E001M": "398640N1219723W001",
    "23N01E07H001M": "398648N1219049W002",
    "23N01W09E001M": "398651N1219930W001",
    "23N01W03H002M": "398782N1219570W001",
    "23N01W03H003M": "398782N1219570W002",
    "23N01W03H004M": "398782N1219570W003",
}

# Per-well 2022 GSP thresholds (MT, MO, IM-2027) for the 17 wells flagged
# "2022 GWL RMS = Yes" in the spreadsheet. Source: Vina Subbasin Reference
# Data.md, Section 1 (cross-checked against the original cosmo1007/vina-subbasin-
# dashboard's RMS_INFO table). All values are ft AMSL.
RMS_2022_THRESHOLDS = {
    # Vina North (6)
    "23N02W25C001M": {"mt_ft": 50,  "mo_ft": 130, "im_2027_ft": 130.0},
    "23N01W10E001M": {"mt_ft": 80,  "mo_ft": 136, "im_2027_ft": 137.0},
    "23N01E07H001M": {"mt_ft": 72,  "mo_ft": 136, "im_2027_ft": 140.0},
    "22N01W05M001M": {"mt_ft": 31,  "mo_ft": 115, "im_2027_ft": 116.0},
    "23N01W36P001M": {"mt_ft": 45,  "mo_ft": 108, "im_2027_ft": 110.0},
    "23N01E33A001M": {"mt_ft": 72,  "mo_ft": 125, "im_2027_ft": 128.0},
    # Vina Chico (5)
    "CWSCH01b":      {"mt_ft": 85,  "mo_ft": 106, "im_2027_ft": 107.0},
    "CWSCH02":       {"mt_ft": 85,  "mo_ft": 105, "im_2027_ft": 108.0},
    "CWSCH03":       {"mt_ft": 85,  "mo_ft": 108, "im_2027_ft": 109.0},
    "CWSCH07":       {"mt_ft": 85,  "mo_ft": 95,  "im_2027_ft": 97.0},
    "22N01E28J003M": {"mt_ft": 85,  "mo_ft": 111, "im_2027_ft": 113.0},
    # Vina South (6)
    "21N01E21C001M": {"mt_ft": 10,  "mo_ft": 64,  "im_2027_ft": 67.0},
    "21N02E18C003M": {"mt_ft": 65,  "mo_ft": 130, "im_2027_ft": 132.0},
    "20N01E10C002M": {"mt_ft": 20,  "mo_ft": 92,  "im_2027_ft": 93.0},
    "20N02E24C001M": {"mt_ft": 18,  "mo_ft": 77,  "im_2027_ft": 81.0},
    "20N02E09L001M": {"mt_ft": 30,  "mo_ft": 91,  "im_2027_ft": 93.0},
    "21N02E26E005M": {"mt_ft": 36,  "mo_ft": 95,  "im_2027_ft": 97.0},
}


def lookup_site_code_by_swn(swn: str):
    params = {
        "resource_id": STATIONS_RESOURCE,
        "filters": json.dumps({"swn": swn}),
        "limit": 5,
    }
    url = f"{DWR_API}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.load(resp)
    except Exception as e:
        print(f"  ! station lookup failed for {swn}: {e}", flush=True)
        return None
    records = data.get("result", {}).get("records", [])
    if not records:
        return None
    for r in records:
        if (r.get("basin_code") or "").startswith("5-021"):
            return r.get("site_code")
    return records[0].get("site_code")


def main() -> int:
    if not XLSX.exists():
        print(f"ERROR: spreadsheet not found at {XLSX}", file=sys.stderr)
        return 1

    wb = openpyxl.load_workbook(XLSX, data_only=True)
    sheet = wb.active

    rows = []
    headers = None
    for i, row in enumerate(sheet.iter_rows(values_only=True), start=1):
        if i == 1:
            headers = row
            continue
        if not any(c not in (None, "") for c in row):
            continue
        rec = dict(zip(headers, row))
        if not rec.get("SWN or Well Name"):
            continue
        rows.append(rec)

    print(f"Loaded {len(rows)} wells from spreadsheet")

    # Two non-DWR wells (proposed ISW sites) flagged in TAG Notes; not in CKAN.
    NON_DWR = {"TNC-MW-1", "FC-MW-2"}

    out_rows = []
    needs_lookup = []
    for r in rows:
        well_name = (r["SWN or Well Name"] or "").strip()
        site_code = KNOWN_SITE_CODES.get(well_name, "")
        no_dwr = well_name in NON_DWR
        if not site_code and not no_dwr:
            needs_lookup.append(well_name)
        is_2022 = (r["2022 GWL RMS?"] or "").strip().lower() == "yes"
        thr = RMS_2022_THRESHOLDS.get(well_name) if is_2022 else None
        out_rows.append({
            "well_name": well_name,
            "swn": well_name if not no_dwr else "",
            "site_code": site_code,
            "mgmt_area_full": (r["Mgmt Area"] or "").strip(),
            "mgmt_area": _short_ma(r["Mgmt Area"]),
            "well_depth": _f(r["Well Depth"]),
            "is_2022_gwl_rms": is_2022,
            "is_2026_gwl_rms": (r["2026 GWL RMS?"] or "").strip().lower() == "yes",
            "is_2026_isw_rms": (r["2026 ISW RMS?"] or "").strip().lower() == "yes" or no_dwr,
            "well_use": (r["DWR Well use"] or "").strip(),
            "well_type": (r["DWR Well Type"] or "").strip(),
            "basin": (r["Basin"] or "").strip(),
            "wcr_no": str(r["WCR #"]).strip() if r["WCR #"] not in (None, "") else "",
            "latitude": _f(r["latitude"]),
            "longitude": _f(r["longitude"]),
            "monitor_freq": (r["Monitor Freq"] or "").strip(),
            "multi_completion": (r["Multi-Compl."] or "").strip().lower() == "yes",
            "gse": _f(r["GSE"]),
            "rpe": _f(r["RPE"]),
            "screen_intervals": (r["Screen Intervals"] or "").strip(),
            "tag_notes": (r["TAG Notes"] or "").strip(),
            "mt_ft": thr["mt_ft"] if thr else "",
            "mo_ft": thr["mo_ft"] if thr else "",
            "im_2027_ft": thr["im_2027_ft"] if thr else "",
        })

    if needs_lookup:
        print(f"Looking up {len(needs_lookup)} unknown site_codes against DWR stations:")
        for w in needs_lookup:
            sc = lookup_site_code_by_swn(w)
            print(f"  {w}: {sc or '(not found)'}")
            if sc:
                for o in out_rows:
                    if o["well_name"] == w:
                        o["site_code"] = sc
                        break

    # Sanity: every 2022 RMS well in the table should have thresholds.
    n_2022 = sum(1 for r in out_rows if r["is_2022_gwl_rms"])
    n_2022_with_thr = sum(1 for r in out_rows if r["is_2022_gwl_rms"] and r["mt_ft"] != "")
    if n_2022 != n_2022_with_thr:
        missing = [r["well_name"] for r in out_rows if r["is_2022_gwl_rms"] and r["mt_ft"] == ""]
        print(f"WARNING: {n_2022 - n_2022_with_thr} 2022 RMS wells missing thresholds: {missing}")

    fieldnames = list(out_rows[0].keys())
    with open(OUT_CSV, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in out_rows:
            writer.writerow(r)

    print(f"\nWrote {OUT_CSV.relative_to(PROJECT_ROOT)}")
    print(f"  Total wells:            {len(out_rows)}")
    print(f"  With DWR site_code:     {sum(1 for r in out_rows if r['site_code'])}")
    print(f"  2022 GWL RMS (special): {n_2022}")
    return 0


def _f(v):
    if v in (None, ""):
        return ""
    try:
        return float(v)
    except (TypeError, ValueError):
        return ""


def _short_ma(s):
    if not s:
        return ""
    s = s.lower()
    if "north" in s:
        return "North"
    if "chico" in s:
        return "Chico"
    if "south" in s:
        return "South"
    return s


if __name__ == "__main__":
    sys.exit(main())
