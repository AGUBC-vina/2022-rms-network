#!/usr/bin/env python3
"""
Convert the 2022 RMS Network shapefile into js/polygons-data.js for the dashboard.

Source: data/2022_RMS_Network.{shp,dbf,prj,shx,cpg} - 15 Voronoi polygons in
NAD83(2011) California Albers (meters), with attributes:
    rId, Map_label, Area, Region.

Steps:
  1. Read the shapefile, reproject every ring from California Albers -> WGS84
     (lat/lon).
  2. Dissolve the 3 Chico cells (28J005M, 18J001M, 33A001M) into a single
     "Chico" polygon (per project owner's reference figure - Chico is shown
     as one polygon).
  3. For each output polygon, attach the canonical RMS well's full SWN so the
     dashboard can render polygon headers with both the short and full IDs.

Output: js/polygons-data.js - defines const RMS_POLYGONS = [...].
"""

import json
import sys
from pathlib import Path

import shapefile
from pyproj import Transformer
from shapely.geometry import Polygon as ShPolygon
from shapely.ops import unary_union

PROJECT_ROOT = Path(__file__).parent.parent
SHP_BASE = PROJECT_ROOT / "data" / "2022_RMS_Network"
PRJ_FILE = PROJECT_ROOT / "data" / "2022_RMS_Network.prj"
OUTPUT_JS = PROJECT_ROOT / "js" / "polygons-data.js"

# Drop rings smaller than this many square meters. Several shapefile records
# carry tiny disconnected sliver rings (a few square meters to a few acres)
# along basin/region boundaries - cartographic noise from the Voronoi
# computation, not meaningful polygons. 50 acres = 202,343 m^2.
MIN_RING_AREA_M2 = 50 * 4046.86

# Map_label -> full State Well Number for the 12 unique RMS-well polygons in
# Vina-North and Vina-South. (Chico is dissolved into a single polygon below
# and gets a list of its 5 RMS wells.)
SHORT_TO_SWN = {
    # Vina-North
    "05M001M": "22N01W05M001M",
    "07H001M": "23N01E07H001M",
    "10E001M": "23N01W10E001M",
    "25C001M": "23N02W25C001M",
    "36P001M": "23N01W36P001M",
    "33A001M": "23N01E33A001M",
    # Vina-South
    "09L001M": "20N02E09L001M",
    "10C002M": "20N01E10C002M",
    "18C003M": "21N02E18C003M",
    "21C001M": "21N01E21C001M",
    "24C001M": "20N02E24C001M",
    "26E005M": "21N02E26E005M",
}

# The 5 RMS wells inside the dissolved Chico polygon.
CHICO_RMS_WELLS = [
    "CWSCH01b",
    "CWSCH02",
    "CWSCH03",
    "CWSCH07",
    "22N01E28J003M",
]

# Region as authored in the shapefile -> short MA name used in the dashboard.
REGION_TO_MA = {
    "Vina-North": "North",
    "Vina-South": "South",
    "Chico": "Chico",
}


def read_shapefile_records():
    """Read the shapefile and filter out cartographic-noise sliver rings
    (any ring whose Albers-meters area is below MIN_RING_AREA_M2)."""
    sf = shapefile.Reader(str(SHP_BASE))
    field_names = [f[0] for f in sf.fields[1:]]
    out = []
    skipped = 0
    for rec, shape in zip(sf.records(), sf.shapes()):
        attrs = dict(zip(field_names, rec))
        rings = []
        parts = list(shape.parts) + [len(shape.points)]
        for i in range(len(parts) - 1):
            ring = shape.points[parts[i]:parts[i + 1]]
            if len(ring) < 3:
                continue
            # Compute area in source-CRS meters^2 to filter slivers.
            area = ShPolygon(ring).buffer(0).area
            if area < MIN_RING_AREA_M2:
                skipped += 1
                continue
            rings.append(ring)
        out.append((attrs, rings))
    if skipped:
        print(f"  (filtered {skipped} sliver ring(s) below {MIN_RING_AREA_M2/4046.86:.0f} acres)")
    return out


def project_ring_to_wgs84(ring_xy, transformer):
    """ring_xy: [(x, y), ...] in California Albers meters.
    Returns [[lat, lng], ...] in WGS84."""
    out = []
    for x, y in ring_xy:
        lng, lat = transformer.transform(x, y)
        out.append([lat, lng])
    return out


def dissolve_chico(chico_records, transformer):
    """Merge the 3 Chico cells into one polygon (in WGS84 lat/lon)."""
    geoms = []
    for _attrs, rings in chico_records:
        for ring in rings:
            wgs = project_ring_to_wgs84(ring, transformer)
            # Shapely expects (x, y) = (lng, lat). Convert.
            shp = ShPolygon([(pt[1], pt[0]) for pt in wgs])
            if shp.is_valid and shp.area > 0:
                geoms.append(shp)
    if not geoms:
        return []
    merged = unary_union(geoms).buffer(0)

    # Extract pieces, drop any disconnected MultiPolygon piece smaller than
    # ~50 acres (shapely's union can leave tiny artifacts at sub-cell
    # boundary discrepancies).
    out_rings = []
    pieces = [merged] if merged.geom_type == "Polygon" else list(merged.geoms)
    for piece in pieces:
        # Convert WGS84 area to acres approximately: degrees-squared -> m^2 via
        # cos(lat) projection. Easier: skip pieces with negligible degree-area.
        # 50 ac ~= 0.0000165 degree^2 at this latitude.
        if piece.area < 1.7e-5:
            continue
        out_rings.append([[y, x] for x, y in list(piece.exterior.coords)])
    return out_rings


def display_label(map_label: str) -> str:
    """Polygon labels in the dashboard match the GSA reference figure: drop
    the trailing 'M' (e.g., '05M001M' -> '05M001'). 'Chico' stays as-is."""
    if not map_label or map_label == "Chico":
        return map_label
    if map_label.endswith("M") and len(map_label) > 1:
        return map_label[:-1]
    return map_label


def main() -> int:
    if not (PROJECT_ROOT / "data" / "2022_RMS_Network.shp").exists():
        print(f"ERROR: shapefile not found at {SHP_BASE}.shp", file=sys.stderr)
        return 1
    if not PRJ_FILE.exists():
        print(f"ERROR: prj not found at {PRJ_FILE}", file=sys.stderr)
        return 1

    src_crs = PRJ_FILE.read_text()
    transformer = Transformer.from_crs(src_crs, "EPSG:4326", always_xy=True)

    records = read_shapefile_records()
    print(f"Loaded {len(records)} records from shapefile")

    by_region = {"Vina-North": [], "Vina-South": [], "Chico": []}
    for attrs, rings in records:
        by_region.setdefault(attrs["Region"], []).append((attrs, rings))

    polygons = []

    # Vina-North and Vina-South: 1 polygon per record, label = Map_label
    # (display label drops the trailing 'M' to match the GSA reference figure).
    for region in ("Vina-North", "Vina-South"):
        for attrs, rings in by_region[region]:
            label_raw = (attrs["Map_label"] or "").strip()
            full_swn = SHORT_TO_SWN.get(label_raw, label_raw)
            wgs_rings = [project_ring_to_wgs84(r, transformer) for r in rings]
            polygons.append({
                "zone_label": display_label(label_raw),
                "rms_wells_2022": [full_swn],
                "ma": REGION_TO_MA[region],
                "rings": wgs_rings,
                "area_acres": attrs.get("Area", 0),
            })

    # Chico: dissolve the 3 cells into a single polygon.
    chico_rings = dissolve_chico(by_region["Chico"], transformer)
    if chico_rings:
        chico_acres_total = sum(int(a.get("Area", 0)) for a, _ in by_region["Chico"])
        polygons.append({
            "zone_label": "Chico",
            "rms_wells_2022": list(CHICO_RMS_WELLS),
            "ma": "Chico",
            "rings": chico_rings,
            "area_acres": chico_acres_total,
        })

    OUTPUT_JS.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_JS, "w") as f:
        f.write("// Auto-generated by scripts/build_polygons.py - do not edit by hand.\n")
        f.write(f"// Source: data/2022_RMS_Network.shp ({len(records)} records, dissolved Chico).\n")
        f.write(f"// Polygon count: {len(polygons)} (Vina-North 6, Vina-South 6, Chico 1).\n\n")
        f.write(f"const RMS_POLYGONS = {json.dumps(polygons, separators=(',', ':'))};\n")

    print(f"Wrote {OUTPUT_JS.relative_to(PROJECT_ROOT)} ({len(polygons)} polygons)")
    by_ma = {}
    for p in polygons:
        by_ma[p["ma"]] = by_ma.get(p["ma"], 0) + 1
    for ma, n in sorted(by_ma.items()):
        print(f"  {ma}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
