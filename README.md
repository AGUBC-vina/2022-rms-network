# Vina Subbasin 2022 RMS Network Dashboard

An interactive groundwater conditions dashboard for the Vina Subbasin (DWR Basin
5-021.57), built around the **2022 GSP Representative Monitoring Site (RMS)
network** (`rms/2022_RMS_Network.shp`) and the **80-well monitoring universe**
(`data/2026-05-02 Network - USE.xlsx`).

The page uses the revised 2022 polygon boundaries per the GSA's reference figure 
and surfaces every well in the 80-well network alongside the 17 wells designated 
2022 GWL RMS in the GSP.

## What it shows

- **§5.2 Interactive Map** — 13 RMS zone polygons colored by Management Area
  (North 6, South 6, Chico 1) with all 80 wells in the network plotted as
  classified markers (large blue circles for the 17 2022 GWL RMS wells, small
  gray dots for supplemental wells, count badges for nested-completion sites).
  Live counts of total wells / 2022 GWL RMS / continuous monitoring / polygons.
- **§5.3 Polygon Hydrograph & Well Detail** — click any polygon to see GWE
  traces for every well inside it. For each 2022 GWL RMS well in the polygon,
  the per-well **MT** (red dashed), **MO** (green dashed), and **IM-2027**
  (purple dotted) thresholds are drawn, labeled by State Well Number. Drought
  periods (1991–93, 2012–15, 2020–22) are shaded. A sortable detail table below
  the chart shows RMS / continuous flags, record range, quality flags, well use,
  depth, GSE, and last good reading per well.
- **§5.4 Representativeness Comparison** — paired same-month GWE readings
  between the polygon's 2022 GWL RMS reference well and each test well, plotted
  against a 1:1 line with Pearson R² when n ≥ 5. When a polygon has more than
  one 2022 GWL RMS well (Chico has five), a dropdown switches the reference.

## Polygon network (13 polygons)

Sourced from `rms/2022_RMS_Network.shp` (NAD83(2011) California Albers) — the
shapefile authored from 2022 GSP Appendix 3B has 15 records; the 3 Chico cells
(28J005M, 18J001M, 33A001M) are dissolved into a single Chico polygon to match
the GSA reference figure. Six cartographic-noise sliver rings (3 in 33A001M,
1 in 18C003M, 2 in 28J005M, all under 25 acres each) are filtered out by
`scripts/build_polygons.py`. Polygon labels strip the trailing `M` from the
shapefile's `Map_label` to match the GSA reference (`05M001M` → `05M001`).

| Region | Count | Display label (RMS well) |
| --- | --- | --- |
| Vina-North | 6 | 05M001 (22N01W05M001M), 07H001 (23N01E07H001M), 10E001 (23N01W10E001M), 25C001 (23N02W25C001M), 36P001 (23N01W36P001M), 33A001 (23N01E33A001M) |
| Vina-South | 6 | 09L001 (20N02E09L001M), 10C002 (20N01E10C002M), 18C003 (21N02E18C003M), 21C001 (21N01E21C001M), 24C001 (20N02E24C001M), 26E005 (21N02E26E005M) |
| Chico | 1 | Chico — contains 5 RMS wells: CWSCH01b, CWSCH02, CWSCH03, CWSCH07, 22N01E28J003M |

## Polygon membership rules

Each well in the 80-well network is assigned to exactly one polygon for
hydrograph display:

1. **2022 GWL RMS wells** are always assigned to their *named* polygon (the
   polygon whose `rms_wells_2022` lists the well), regardless of geography.
   This handles two known edge cases:
   - **23N01E33A001M** is named for the Vina-North 33A001M polygon, but its
     lat/lon falls geographically inside the dissolved Chico polygon. It
     stays with Vina-North.
   - **20N01E10C002M** is named for the Vina-South 10C002M polygon, but its
     lat/lon falls just outside that polygon's southern boundary (the 5-021.70
     basin-boundary edge case noted in the GSP Annual Report). It stays with
     Vina-South 10C002M.
2. **Non-RMS wells** use point-in-polygon. If a well falls inside multiple
   polygons, the polygon whose Management Area matches the spreadsheet's `Mgmt
   Area` for the well wins.
3. **Non-RMS wells outside all polygons** snap to the nearest polygon centroid
   in the same Management Area (or nearest overall if no MA match).

The membership map is computed in `js/main.js → buildPolygonMembership()` at
page load.

## Marker legend

| Marker | Meaning |
| --- | --- |
| Large blue circle (with white center) | 2022 GWL RMS well |
| Small gray dot | Supplemental monitoring well |
| Orange count badge | Multi-well (nested completion) site — number of wells at that pad |

## Repository layout

```
.
├── index.html                              dashboard page
├── README.md                               this file
├── data/
│   ├── 2022_RMS_Network.{shp,dbf,prj,shx,cpg}    source shapefile (15 records)
│   ├── 2026-05-02 Network - USE.xlsx             source spreadsheet (80 wells)
│   └── vina_2022_monitoring_network.csv          canonical wells CSV (auto-built)
├── js/
│   ├── wells-data.js                       const WELLS = [...]            (auto)
│   ├── polygons-data.js                    const RMS_POLYGONS = [...]     (auto)
│   ├── measurements-data.js                const MEASUREMENTS = {...}     (auto, ~26 MB)
│   └── main.js                             map / hydrograph / table logic
├── rms/
│   ├── 2022_RMS_Network.{shp,dbf,prj,shx,cpg}    original shapefile + README
│   └── README.txt
├── scripts/
│   ├── build_wells_csv.py                  spreadsheet → CSV (resolves DWR site_codes)
│   ├── build_polygons.py                   shapefile → js/polygons-data.js
│   ├── fetch_dwr_data.py                   DWR CKAN → js/{wells,measurements}-data.js
│   └── serve.sh                            local dev server (python http.server :8765)
└── .github/workflows/
    └── refresh-data.yml                    daily DWR refresh + GitHub Pages deploy
```

## Per-well 2022 GSP thresholds

The MT, MO, and IM-2027 values for the 17 2022 GWL RMS wells are hard-coded in
`scripts/build_wells_csv.py → RMS_2022_THRESHOLDS`, sourced from
`Vina Subbasin Reference Data.md` §1 (2022 GSP / 2025 Annual Report). They are
embedded into each RMS well's row in `js/wells-data.js` and rendered as
horizontal lines on the polygon hydrograph.

## Regenerating data files

```bash
# 1. Build canonical wells CSV from the spreadsheet (resolves DWR site_codes).
python3 scripts/build_wells_csv.py

# 2. Build polygons-data.js from the shapefile (dissolves the 3 Chico cells).
python3 scripts/build_polygons.py

# 3. Pull periodic measurements from DWR CKAN and emit wells-data.js +
#    measurements-data.js (takes ~1–2 min — 78 fetchable wells).
python3 scripts/fetch_dwr_data.py
```

`fetch_dwr_data.py` regenerates both `wells-data.js` and `measurements-data.js`
together so they always reference the same well roster.

## GitHub Pages deployment

1. Push this folder to a GitHub repo (e.g. `cosmo1007/2022-rms-network`).
2. Settings → Pages → Source = `Deploy from a branch`, branch = `main`,
   folder = `/ (root)`.
3. After ~1 minute the dashboard is live at
   `https://<owner>.github.io/<repo>/`.
4. The included GitHub Action (`.github/workflows/refresh-data.yml`) runs
   `scripts/fetch_dwr_data.py` on a daily cron and commits the regenerated
   `js/{wells,measurements}-data.js` files.

## Sources

- Periodic groundwater measurements: California DWR SGMA Data Viewer (CKAN
  resource `bfa9f262-24a1-45bd-8dc8-138bc8107266`).
- DWR station list (used to resolve `site_code` for two wells not in the prior
  dashboard's roster): CKAN resource `af157380-fb42-4abf-b72a-6f9f98868077`.
- 2022 RMS polygon network: `rms/2022_RMS_Network.shp` (Vina GSA / 2022 GSP
  Appendix 3B).
- 80-well roster + RMS designations: `2026-05-02 Network - USE.xlsx` (TAG
  AGUBC).
- Per-well MT/MO/IM-2027 thresholds: `Vina Subbasin Reference Data.md` §1
  (2025 Annual Report values).

## Known caveats

- **23N01E33A001M** appears in both the Vina-North and Chico cells in the
  source shapefile; the dashboard treats it as Vina-North per the polygon's
  named RMS well and the GSA's intent.
- **Sliver rings filtered.** The source shapefile carries six tiny disconnected
  rings (3 in Vina-North 33A001M, 1 in Vina-South 18C003M, 2 in Chico 28J005M)
  ranging from a few square meters to ~21 acres — cartographic noise from the
  Voronoi computation along basin boundaries. The 50-acre filter in
  `build_polygons.py` removes them so the dashboard shows clean, contiguous
  polygons.
- **20N01E10C002M** is coded `5-021.70` (Butte) by DWR but is treated as a
  Vina South RMS well per the GSP. The named-polygon override keeps it inside
  the Vina-South 10C002M polygon's hydrograph even though its lat/lon lies
  just outside the polygon ring.
- **22N01E20K001M and FC-MW-2** are tagged "01-Vina-North" in the spreadsheet
  but their lat/lon falls inside the dissolved Chico polygon. They are
  displayed in the Chico polygon's hydrograph (geographic assignment beats
  spreadsheet MA for non-RMS wells).
- **CWSCH wells** are a nested completion at one pad (identical lat/lon).
  They appear as a single map marker with a "4" badge and stack visually if
  zoomed; clicking the marker shows all four in the popup.

## License

**Code.** The build and refresh scripts, the dashboard HTML/CSS/JS, and any
GitHub Actions workflows are released under the MIT License. See
[`LICENSE`](LICENSE).

**Content.** The written analysis, figures, tables, and derived values are
released by Agricultural Groundwater Users of Butte County (AGUBC) under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
See [`LICENSE-CONTENT`](LICENSE-CONTENT). Attribute to AGUBC and link back to
this repository.

**Underlying data.** The third-party datasets named elsewhere in this README are
not AGUBC's to license. They remain subject to their own terms, and neither
license above extends to them.
