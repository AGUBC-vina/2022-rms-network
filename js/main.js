// Vina Subbasin 2022 RMS Network Dashboard - main app.
//
// Polygon-driven UX: clicking an RMS zone polygon renders a comparison
// hydrograph (with per-RMS-well MT/MO/IM-2027 lines), a sortable detail
// table, and a §5.4 representativeness scatter for every well in the zone.
//
// Globals expected in scope (loaded by index.html before this script):
//   WELLS                     - array of 80 well records (data/vina_2022_monitoring_network.csv)
//   MEASUREMENTS              - { site_code -> [{ d, gwe, dtw, qa, qd, org }] }
//   MEASUREMENTS_FETCHED_AT   - ISO timestamp of the last DWR refresh
//   RMS_POLYGONS              - 13 polygons w/ rings, ma, zone_label, rms_wells_2022

const MA_COLORS = {
    North: '#1f4ee0',
    South: '#2ca02c',
    Chico: '#e07b1f',
    Other: '#888888',
};

const TRACE_COLORS = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b',
    '#e377c2', '#7f7f7f', '#bcbd22', '#17becf', '#aec7e8', '#ffbb78',
    '#98df8a', '#ff9896', '#c5b0d5', '#c49c94', '#f7b6d2', '#dbdb8d',
];

const DROUGHTS = [
    { x0: '1991-01-01', x1: '1993-12-31', label: '1991-93 drought' },
    { x0: '2012-01-01', x1: '2015-12-31', label: '2012-15 drought' },
    { x0: '2020-01-01', x1: '2022-12-31', label: '2020-22 drought' },
];

function droughtShapes() {
    return DROUGHTS.map(d => ({
        type: 'rect', xref: 'x', yref: 'paper',
        x0: d.x0, x1: d.x1, y0: 0, y1: 1,
        fillcolor: 'rgba(255, 152, 0, 0.10)', line: { width: 0 },
        layer: 'below',
    }));
}

// Module state
let map;
let allWells = [];
let polygonLayer = null;
let polygonShapes = [];          // polygonShapes[idx] = [LeafletPolygon, ...]
let polygonMembership = {};      // polygonMembership[idx] = [well, ...]
let selectedPolygonIdx = null;
let highlightLayer = null;
let siteGroups = {};             // siteKey -> [well, ...]
let wellSiteMap = {};            // wellKey -> siteKey

let currentSelection = null;

// -------------------- Helpers --------------------

function wellKey(well) { return well.site_code || well.well_name; }

function isContinuous(well) {
    return (well.monitor_freq || '').toLowerCase().includes('hourly');
}

// Ray-casting point-in-polygon. point: [lat, lng], ring: [[lat,lng], ...].
function pointInRing(point, ring) {
    const x = point[1], y = point[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][1], yi = ring[i][0];
        const xj = ring[j][1], yj = ring[j][0];
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi || 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function ringCentroidLatLng(ring) {
    let sx = 0, sy = 0;
    ring.forEach(([lat, lng]) => { sy += lat; sx += lng; });
    return [sy / ring.length, sx / ring.length];
}

function polygonCentroid(polygon) {
    // Pick the largest ring (by point count) as the representative outer ring.
    const ring = polygon.rings.slice().sort((a, b) => b.length - a.length)[0];
    return ringCentroidLatLng(ring);
}

function haversineKm(a, b) {
    const toRad = (d) => (d * Math.PI / 180);
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]), lat2 = toRad(b[0]);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function siteKey(well) {
    if (well.latitude == null || well.longitude == null) return wellKey(well);
    return `${well.latitude.toFixed(5)}|${well.longitude.toFixed(5)}`;
}

function buildSiteGroups() {
    const groups = {};
    const map = {};
    for (const w of allWells) {
        const key = siteKey(w);
        if (!groups[key]) groups[key] = [];
        groups[key].push(w);
        map[wellKey(w)] = key;
    }
    return { groups, map };
}

// -------------------- Polygon membership --------------------
//
// Rules:
//   1. A 2022 GWL RMS well is always assigned to its named polygon (the
//      polygon whose `rms_wells_2022` lists this well's name) - regardless
//      of whether the well's lat/lon falls inside that polygon's geometry.
//      This handles the dual-region 23N01E33A001M case (named for the
//      Vina-North 33A001M polygon but geographically inside the dissolved
//      Chico polygon) and the basin-boundary edge case 20N01E10C002M (named
//      for the Vina-South 10C002M polygon but lat/lon falls just outside).
//   2. Non-RMS wells use point-in-polygon. If matching multiple polygons,
//      prefer the polygon whose MA matches the well's `mgmt_area`; else
//      take the first match.
//   3. If a non-RMS well falls outside all polygons, snap it to the nearest
//      polygon centroid in the same MA (else nearest overall).

function buildPolygonMembership() {
    const out = {};
    RMS_POLYGONS.forEach((_, i) => { out[i] = []; });

    // Index for rule 1: RMS well name -> polygon index it's named for.
    const rmsNamedPolygon = {};
    RMS_POLYGONS.forEach((p, idx) => {
        (p.rms_wells_2022 || []).forEach(name => {
            rmsNamedPolygon[name] = idx;
        });
    });

    // Pre-compute polygon centroids for nearest-polygon snap.
    const polyCentroids = RMS_POLYGONS.map(p => polygonCentroid(p));

    for (const w of allWells) {
        // Rule 1: 2022 RMS well -> named polygon.
        if (w.is_2022_gwl_rms && rmsNamedPolygon[w.well_name] != null) {
            out[rmsNamedPolygon[w.well_name]].push(w);
            continue;
        }
        if (w.latitude == null || w.longitude == null) continue;
        const pt = [w.latitude, w.longitude];

        // Rule 2: point-in-polygon, MA tiebreaker.
        const matches = [];
        RMS_POLYGONS.forEach((p, idx) => {
            for (const ring of p.rings) {
                if (pointInRing(pt, ring)) {
                    matches.push(idx);
                    break;
                }
            }
        });
        if (matches.length > 0) {
            const sameMa = matches.find(i => RMS_POLYGONS[i].ma === w.mgmt_area);
            const chosen = sameMa != null ? sameMa : matches[0];
            out[chosen].push(w);
            continue;
        }

        // Rule 3: snap to nearest polygon in same MA.
        let bestIdx = -1, bestDist = Infinity;
        RMS_POLYGONS.forEach((p, idx) => {
            if (p.ma !== w.mgmt_area) return;
            const d = haversineKm(pt, polyCentroids[idx]);
            if (d < bestDist) { bestDist = d; bestIdx = idx; }
        });
        if (bestIdx === -1) {
            // Fall back to nearest overall.
            RMS_POLYGONS.forEach((p, idx) => {
                const d = haversineKm(pt, polyCentroids[idx]);
                if (d < bestDist) { bestDist = d; bestIdx = idx; }
            });
        }
        if (bestIdx !== -1) out[bestIdx].push(w);
    }

    return out;
}

// -------------------- Init --------------------

function initializeWells() {
    if (typeof WELLS === 'undefined') {
        console.error('WELLS not defined - ensure js/wells-data.js is loaded first.');
        return;
    }
    allWells = WELLS.slice();

    document.getElementById('well-count').textContent = allWells.length;
    document.getElementById('rms-count').textContent = allWells.filter(w => w.is_2022_gwl_rms).length;
    document.getElementById('cont-count').textContent = allWells.filter(w => isContinuous(w)).length;
    document.getElementById('polygon-count').textContent = (typeof RMS_POLYGONS !== 'undefined') ? RMS_POLYGONS.length : '?';
}

function initMap() {
    map = L.map('map').setView([39.73, -121.85], 11);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    const sg = buildSiteGroups();
    siteGroups = sg.groups;
    wellSiteMap = sg.map;

    if (typeof RMS_POLYGONS !== 'undefined') {
        polygonMembership = buildPolygonMembership();
        addPolygonLayer();
    }

    Object.values(siteGroups).forEach((wells) => {
        if (wells[0].latitude == null) return;
        const lat = wells[0].latitude;
        const lng = wells[0].longitude;
        const isRms = wells.some(w => w.is_2022_gwl_rms);
        const isMulti = wells.length > 1;

        const icon = buildSiteIcon(isRms, isMulti ? wells.length : 0);
        const marker = L.marker([lat, lng], { icon }).bindPopup(buildSitePopupHtml(wells));
        if (isRms) marker.setZIndexOffset(1000);
        marker.addTo(map);
    });

    const bounds = allWells
        .filter(w => w.latitude != null && w.longitude != null)
        .map(w => [w.latitude, w.longitude]);
    if (bounds.length > 0) {
        map.fitBounds(L.latLngBounds(bounds), { padding: [50, 50] });
    }
}

function buildSiteIcon(isRms, multiCount) {
    let iconHtml;
    if (isRms) {
        iconHtml = `<svg width="28" height="28" viewBox="0 0 28 28">
            <circle cx="14" cy="14" r="11" fill="#1e40af" stroke="white" stroke-width="2.5"/>
            <circle cx="14" cy="14" r="4.5" fill="white"/>
        </svg>`;
    } else {
        iconHtml = `<svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="6.5" fill="#777" stroke="white" stroke-width="2"/>
        </svg>`;
    }

    const size = isRms ? 28 : 20;
    if (multiCount > 1) {
        const html = `
            <div class="cluster-marker" style="position:relative;">
                ${iconHtml}
                <div class="cluster-badge">${multiCount}</div>
            </div>`;
        return L.divIcon({
            className: '',
            html,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        });
    }

    return L.divIcon({
        className: '',
        html: iconHtml,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    });
}

function buildSitePopupHtml(wells) {
    if (wells.length === 1) {
        const w = wells[0];
        return `
            <div style="min-width:240px;">
                <strong>${w.well_name}</strong>
                ${pillsForWell(w)}
                <div style="margin-top:6px; font-size:12px; color:#555;">
                    Mgmt Area: <strong>${w.mgmt_area || '-'}</strong><br>
                    Use: ${w.well_use || '-'}<br>
                    Depth: ${w.well_depth ? `${Math.round(w.well_depth)} ft` : '-'}<br>
                    GSE: ${w.gse != null ? `${w.gse.toFixed(2)} ft` : '-'}<br>
                    Frequency: ${w.monitor_freq || '-'}<br>
                    ${w.tag_notes ? `<em style="color:#666;">${w.tag_notes}</em>` : ''}
                </div>
            </div>`;
    }
    const rows = wells.slice()
        .sort((a, b) => (b.well_depth || 0) - (a.well_depth || 0))
        .map(w => `
            <div style="margin-bottom:6px;">
                <strong>${w.well_name}</strong> ${pillsForWell(w)}<br>
                <span style="font-size:12px; color:#555;">Depth: ${w.well_depth ? `${Math.round(w.well_depth)} ft` : '-'} &middot; Use: ${w.well_use || '-'} &middot; Freq: ${w.monitor_freq || '-'}</span>
            </div>`).join('');
    const lat = wells[0].latitude.toFixed(4);
    const lng = wells[0].longitude.toFixed(4);
    return `
        <div style="min-width:280px;">
            <strong>Nested site - ${wells.length} wells</strong><br>
            <span style="color:#666; font-size:11px;">${lat}, ${lng}</span>
            <hr style="margin:6px 0;">
            ${rows}
        </div>`;
}

function pillsForWell(w) {
    const parts = [];
    if (w.is_2022_gwl_rms) parts.push('<span class="pill pill-rms">2022 GWL RMS</span>');
    if (isContinuous(w)) parts.push('<span class="pill pill-cont">Hourly</span>');
    if (w.multi_completion) parts.push('<span class="pill pill-nested" title="Part of a nested/multi-completion well">Nested</span>');
    return parts.join(' ');
}

function addPolygonLayer() {
    polygonLayer = L.layerGroup();
    polygonShapes = [];

    RMS_POLYGONS.forEach((p, idx) => {
        const color = MA_COLORS[p.ma] || MA_COLORS.Other;
        const shapes = [];

        p.rings.forEach((ring) => {
            const poly = L.polygon(ring, {
                color: color,
                weight: 2,
                opacity: 0.85,
                fillColor: color,
                fillOpacity: 0.18,
            });

            poly.on('click', () => selectPolygon(idx));
            poly.on('mouseover', () => {
                if (selectedPolygonIdx !== idx) poly.setStyle({ fillOpacity: 0.30 });
            });
            poly.on('mouseout', () => {
                if (selectedPolygonIdx !== idx) poly.setStyle({ fillOpacity: 0.18 });
            });

            poly.bindTooltip(`${p.zone_label} &middot; ${p.ma}`, { sticky: true, direction: 'top' });

            polygonLayer.addLayer(poly);
            shapes.push(poly);
        });

        polygonShapes.push(shapes);
    });

    polygonLayer.addTo(map);
}

function applyPolygonStyles() {
    polygonShapes.forEach((shapes, idx) => {
        const p = RMS_POLYGONS[idx];
        const color = MA_COLORS[p.ma] || MA_COLORS.Other;
        const isSelected = (idx === selectedPolygonIdx);
        shapes.forEach((poly) => {
            poly.setStyle({
                color: color,
                weight: isSelected ? 4 : 2,
                opacity: isSelected ? 1.0 : 0.85,
                fillColor: color,
                fillOpacity: isSelected ? 0.40 : 0.18,
            });
            if (isSelected) poly.bringToFront();
        });
    });
}

function highlightWellsInPolygon(wellsWithColor) {
    if (highlightLayer) {
        map.removeLayer(highlightLayer);
        highlightLayer = null;
    }
    if (!wellsWithColor.length) return;
    highlightLayer = L.layerGroup();

    const bySite = {};
    for (const wc of wellsWithColor) {
        const key = siteKey(wc.well);
        if (!bySite[key]) bySite[key] = [];
        bySite[key].push(wc);
    }

    Object.values(bySite).forEach((group) => {
        if (group[0].well.latitude == null) return;
        const lat = group[0].well.latitude;
        const lng = group[0].well.longitude;
        const color = group[0].color;
        const count = group.length;

        if (count === 1) {
            const circle = L.circleMarker([lat, lng], {
                radius: 18,
                color,
                weight: 3,
                fillOpacity: 0,
                interactive: false,
            });
            highlightLayer.addLayer(circle);
        } else {
            const icon = L.divIcon({
                className: '',
                html: `
                    <div class="hl-ring" style="--ring-color: ${color};">
                        <div class="hl-ring-circle"></div>
                        <div class="hl-ring-badge">${count}</div>
                    </div>`,
                iconSize: [44, 44],
                iconAnchor: [22, 22],
            });
            const m = L.marker([lat, lng], { icon, interactive: false });
            highlightLayer.addLayer(m);
        }
    });

    highlightLayer.addTo(map);
}

// -------------------- Measurements helpers --------------------

function getMeasurements(well) {
    if (typeof MEASUREMENTS === 'undefined') return [];
    if (well.site_code) return MEASUREMENTS[well.site_code] || [];
    return MEASUREMENTS[well.well_name] || [];
}

function measurementSummary(records) {
    const good = records.filter(r => r.qa && r.qa.toLowerCase().includes('good') && r.gwe !== null);
    const questionable = records.filter(r => r.qa && r.qa.toLowerCase().includes('question'));
    const missing = records.filter(r => r.qa && r.qa.toLowerCase().includes('missing'));
    const dates = good.map(r => r.d).sort();
    const lastGood = good.length ? good[good.length - 1] : null;
    return {
        total: records.length,
        good: good.length,
        questionable: questionable.length,
        missing: missing.length,
        firstYear: dates.length ? dates[0].slice(0, 4) : null,
        lastYear: dates.length ? dates[dates.length - 1].slice(0, 4) : null,
        lastGoodDate: lastGood ? lastGood.d : null,
        lastGoodGwe: lastGood ? lastGood.gwe : null,
    };
}

// -------------------- Representativeness helpers --------------------

function pairMeasurementsByMonth(rmsRecords, testRecords) {
    const goodOnly = (records) => records.filter(r => r.qa && r.qa.toLowerCase().includes('good') && r.gwe !== null);
    const bucketize = (records) => {
        const m = {};
        for (const r of records) {
            const ym = r.d.slice(0, 7);
            if (!m[ym]) m[ym] = [];
            m[ym].push(r.gwe);
        }
        return m;
    };
    const rmsByMonth = bucketize(goodOnly(rmsRecords));
    const testByMonth = bucketize(goodOnly(testRecords));
    const pairs = [];
    for (const ym in rmsByMonth) {
        if (testByMonth[ym]) {
            const x = rmsByMonth[ym].reduce((a, b) => a + b, 0) / rmsByMonth[ym].length;
            const y = testByMonth[ym].reduce((a, b) => a + b, 0) / testByMonth[ym].length;
            pairs.push({ ym, x, y });
        }
    }
    pairs.sort((a, b) => a.ym.localeCompare(b.ym));
    return pairs;
}

function pearsonR(pairs) {
    const n = pairs.length;
    if (n < 3) return null;
    const meanX = pairs.reduce((a, p) => a + p.x, 0) / n;
    const meanY = pairs.reduce((a, p) => a + p.y, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (const p of pairs) {
        const dx = p.x - meanX, dy = p.y - meanY;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
    }
    if (dx2 === 0 || dy2 === 0) return null;
    return num / Math.sqrt(dx2 * dy2);
}

// -------------------- Polygon selection --------------------

function selectPolygon(idx) {
    selectedPolygonIdx = idx;
    applyPolygonStyles();

    const polygon = RMS_POLYGONS[idx];
    const wells = polygonMembership[idx] || [];
    const wellsWithColor = wells.map((w, i) => ({
        well: w,
        color: TRACE_COLORS[i % TRACE_COLORS.length],
    }));

    const rows = wellsWithColor.map(({ well, color }) => {
        const records = getMeasurements(well);
        const stats = measurementSummary(records);
        return {
            well, color, stats,
            sort: {
                name: (well.well_name || '').toLowerCase(),
                rms: well.is_2022_gwl_rms ? 0 : 1,
                continuous: isContinuous(well) ? 0 : 1,
                record: stats.firstYear ? parseInt(stats.firstYear, 10) : 9999,
                flags: stats.questionable + stats.missing,
                use: (well.well_use || '').toLowerCase(),
                depth: (well.well_depth != null) ? well.well_depth : -1,
                gse: (well.gse != null) ? well.gse : -1,
                last: (stats.lastGoodGwe != null) ? stats.lastGoodGwe : -99999,
            },
        };
    });

    const visibility = {};
    wellsWithColor.forEach(({ well }) => { visibility[wellKey(well)] = true; });

    const rmsRefs = wellsWithColor.filter(wc => wc.well.is_2022_gwl_rms);
    const selectedRmsRef = rmsRefs.length > 0 ? wellKey(rmsRefs[0].well) : null;

    currentSelection = {
        polygon, polygonIdx: idx,
        wellsWithColor,
        traceIndices: {},
        visibility,
        sortCol: 'rms',  // RMS-first by default
        sortDir: 'asc',
        rows,
        selectedRmsRef,
    };

    highlightWellsInPolygon(wellsWithColor);
    renderSection53();
    renderSection54();
}

function renderSection53() {
    const sel = currentSelection;
    const container = document.getElementById('hydrograph-container');
    const polygon = sel.polygon;
    const wellCount = sel.wellsWithColor.length;
    const rmsList = (polygon.rms_wells_2022 || []).join(', ') || '-';

    const headerHtml = `
        <div class="selected-polygon-header">
            <h3>${polygon.zone_label} &mdash; ${polygon.ma} Management Area</h3>
            <div class="meta">${wellCount} well${wellCount === 1 ? '' : 's'} in zone</div>
            <div class="smc-line">
                <strong>2022 GWL RMS well${polygon.rms_wells_2022.length === 1 ? '' : 's'}:</strong> ${rmsList}
            </div>
        </div>`;

    if (wellCount === 0) {
        container.innerHTML = headerHtml + `<div class="empty-state">No monitoring wells fall within this polygon.</div>`;
        return;
    }

    container.innerHTML = headerHtml + `
        <div class="hydro-controls">
            <span>Toggle wells:</span>
            <button id="show-all-wells" class="ctrl-btn">Show all</button>
            <button id="hide-all-wells" class="ctrl-btn">Hide all</button>
            <span style="margin-left:auto; color:#888; font-size:12px;">Tip: click any column header below to sort.</span>
        </div>
        <div id="plotly-chart"></div>
        <div id="well-detail-table"></div>
    `;

    renderPolygonHydrograph();
    renderWellDetailTable();

    document.getElementById('show-all-wells').addEventListener('click', () => toggleAllWells(true));
    document.getElementById('hide-all-wells').addEventListener('click', () => toggleAllWells(false));
}

function renderPolygonHydrograph() {
    const sel = currentSelection;
    const polygon = sel.polygon;
    const wellsWithColor = sel.wellsWithColor;
    const traceIndices = {};
    const traces = [];
    const today = new Date().toISOString().slice(0, 10);
    const xs = ['1990-01-01', today];

    let traceIdx = 0;
    let anyGood = false;

    wellsWithColor.forEach(({ well, color }) => {
        const indices = [];
        const records = getMeasurements(well);
        const good = records.filter(r => r.qa && r.qa.toLowerCase().includes('good') && r.gwe !== null);

        if (good.length > 0) {
            anyGood = true;
            const namePill = well.is_2022_gwl_rms ? ' (RMS)' : '';
            traces.push({
                x: good.map(r => r.d),
                y: good.map(r => r.gwe),
                mode: 'lines+markers',
                name: well.well_name + namePill,
                line: { color, width: 1.5 },
                marker: { size: 5, color },
                hovertemplate: `<b>${well.well_name}</b><br>%{x}<br>%{y:.2f} ft AMSL<extra></extra>`,
                visible: sel.visibility[wellKey(well)] ? true : 'legendonly',
            });
            indices.push(traceIdx++);
        }

        // Per-well thresholds for 2022 RMS wells (each owned by the well's
        // toggle so toggling the well hides its threshold lines too).
        if (well.is_2022_gwl_rms) {
            const addThr = (value, kind, lineColor, dash) => {
                if (value == null || value === '') return;
                traces.push({
                    x: xs, y: [value, value],
                    mode: 'lines',
                    name: `${well.well_name} ${kind}: ${value} ft`,
                    line: { color: lineColor, width: 1.5, dash },
                    hovertemplate: `${well.well_name} ${kind}: ${value} ft AMSL<extra></extra>`,
                    visible: sel.visibility[wellKey(well)] ? true : 'legendonly',
                });
                indices.push(traceIdx++);
            };
            addThr(well.mo_ft, 'MO', '#2e7d32', 'dash');
            addThr(well.mt_ft, 'MT', '#c62828', 'dash');
            addThr(well.im_2027_ft, 'IM-2027', '#6a1b9a', 'dot');
        }

        traceIndices[wellKey(well)] = indices;
    });

    sel.traceIndices = traceIndices;

    if (!anyGood) {
        Plotly.newPlot('plotly-chart', [], {
            title: { text: `No "Good" measurements available for wells in ${polygon.zone_label}`, x: 0.5 },
            annotations: [{
                text: 'DWR has no Good periodic measurements for any well in this polygon.',
                xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false,
                font: { size: 14, color: '#999' },
            }],
            margin: { t: 50, b: 60, l: 60, r: 20 },
        }, { responsive: true });
        return;
    }

    const layout = {
        title: { text: `Groundwater Elevation - ${polygon.zone_label} (${wellsWithColor.length} well${wellsWithColor.length === 1 ? '' : 's'})`, x: 0.5, xanchor: 'center' },
        xaxis: {
            title: 'Date',
            type: 'date',
            range: ['1990-01-01', today],
            rangeslider: { visible: true, thickness: 0.05 },
        },
        yaxis: { title: 'Groundwater Elevation (ft AMSL)' },
        hovermode: 'x unified',
        shapes: droughtShapes(),
        margin: { t: 60, b: 90, l: 70, r: 30 },
        legend: { orientation: 'h', y: -0.20 },
    };

    Plotly.newPlot('plotly-chart', traces, layout, { responsive: true });
}

function toggleWell(siteCode, visible) {
    const sel = currentSelection;
    if (!sel) return;
    sel.visibility[siteCode] = visible;
    const newVis = visible ? true : 'legendonly';

    // Hydrograph (§5.3)
    const indices = sel.traceIndices[siteCode] || [];
    if (indices.length > 0) {
        Plotly.restyle('plotly-chart', { visible: newVis }, indices);
    }

    // Representativeness chart (§5.4) - same well's scatter points
    const repIndices = (sel.repTraceIndices || {})[siteCode] || [];
    if (repIndices.length > 0 && document.querySelector('#rep-chart .main-svg')) {
        Plotly.restyle('rep-chart', { visible: newVis }, repIndices);
    }
}

function toggleAllWells(visible) {
    const sel = currentSelection;
    if (!sel) return;
    Object.keys(sel.visibility).forEach((sc) => { sel.visibility[sc] = visible; });
    const newVis = visible ? true : 'legendonly';

    const allHydroIdx = [];
    Object.values(sel.traceIndices).forEach((arr) => arr.forEach(i => allHydroIdx.push(i)));
    if (allHydroIdx.length > 0) {
        Plotly.restyle('plotly-chart', { visible: newVis }, allHydroIdx);
    }

    const allRepIdx = [];
    Object.values(sel.repTraceIndices || {}).forEach((arr) => arr.forEach(i => allRepIdx.push(i)));
    if (allRepIdx.length > 0 && document.querySelector('#rep-chart .main-svg')) {
        Plotly.restyle('rep-chart', { visible: newVis }, allRepIdx);
    }

    document.querySelectorAll('input[data-well-toggle]').forEach((cb) => {
        cb.checked = visible;
    });
}

// -------------------- Sortable detail table --------------------

const TABLE_COLUMNS = [
    { key: '__show', label: 'Show', sortable: false, className: 'show-col' },
    { key: 'name',       label: 'Well Name' },
    { key: 'rms',        label: '2022 RMS' },
    { key: 'continuous', label: 'Continuous' },
    { key: 'record',     label: 'Record' },
    { key: 'flags',      label: 'Quality Flags' },
    { key: 'use',        label: 'Well Use' },
    { key: 'depth',      label: 'Depth' },
    { key: 'gse',        label: 'GSE (ft AMSL)' },
    { key: 'last',       label: 'Most Recent Good Reading' },
];

function sortRows(rows, col, dir) {
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = a.sort[col];
        const vb = b.sort[col];
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
        return String(va).localeCompare(String(vb)) * sign;
    });
}

function renderWellDetailTable() {
    const sel = currentSelection;
    if (!sel) return;

    const sortedRows = sortRows(sel.rows, sel.sortCol, sel.sortDir);

    const headerHtml = TABLE_COLUMNS.map((col) => {
        if (col.sortable === false || col.key === '__show') {
            return `<th class="${col.className || ''}">${col.label}</th>`;
        }
        const isActive = (sel.sortCol === col.key);
        const arrow = isActive ? (sel.sortDir === 'asc' ? '▲' : '▼') : '▲';
        const arrowClass = isActive ? 'sort-arrow' : 'sort-arrow inactive';
        return `<th class="sortable" data-col="${col.key}">${col.label}<span class="${arrowClass}">${arrow}</span></th>`;
    }).join('');

    const bodyHtml = sortedRows.map(({ well, color, stats }) => {
        const checked = sel.visibility[wellKey(well)] ? 'checked' : '';
        const rmsPill = well.is_2022_gwl_rms
            ? '<span class="pill pill-rms">Yes</span>'
            : '<span class="pill pill-supp">No</span>';
        const contPill = isContinuous(well)
            ? '<span class="pill pill-cont">Hourly</span>'
            : '<span class="pill pill-supp">' + (well.monitor_freq || '-') + '</span>';
        const noDwr = !well.site_code;
        const recordTxt = noDwr ? '<em style="color:#999;">no DWR data</em>' : (stats.firstYear ? `${stats.firstYear}-${stats.lastYear}` : '-');
        const goodTxt = noDwr ? '' : `${stats.good} Good`;
        const flagsTxt = noDwr
            ? '<span style="color:#999;">-</span>'
            : ((stats.questionable + stats.missing) > 0
                ? `<span class="pill pill-flag">${stats.questionable} Q / ${stats.missing} M</span>`
                : '<span style="color:#999;">-</span>');
        const depth = (well.well_depth != null) ? `${Math.round(well.well_depth)} ft` : '-';
        const gse = (well.gse != null) ? `${well.gse.toFixed(2)}` : '-';
        const lastReading = noDwr
            ? '<em style="color:#999;">-</em>'
            : (stats.lastGoodGwe != null
                ? `${stats.lastGoodGwe.toFixed(2)} ft<br><span style="color:#888; font-size:11px;">${stats.lastGoodDate}</span>`
                : '-');
        const sitePeers = (siteGroups[wellSiteMap[wellKey(well)]] || []).length;
        const nestedPill = sitePeers > 1
            ? ` <span class="pill pill-nested" title="This site has ${sitePeers} wells screened at different depths.">Nested &times;${sitePeers}</span>`
            : '';
        return `
            <tr>
                <td class="show-col">
                    <input type="checkbox" data-well-toggle data-site="${wellKey(well)}" ${checked}>
                </td>
                <td class="well-name-cell" style="color:${color};">
                    <span class="color-swatch" style="background:${color};"></span>${well.well_name}${nestedPill}
                </td>
                <td>${rmsPill}</td>
                <td>${contPill}</td>
                <td>${recordTxt}${goodTxt ? `<br><span style="color:#888; font-size:11px;">${goodTxt}</span>` : ''}</td>
                <td>${flagsTxt}</td>
                <td>${well.well_use || '-'}</td>
                <td>${depth}</td>
                <td>${gse}</td>
                <td>${lastReading}</td>
            </tr>`;
    }).join('');

    document.getElementById('well-detail-table').innerHTML = `
        <table>
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${bodyHtml}</tbody>
        </table>`;

    document.querySelectorAll('#well-detail-table th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
            const col = th.getAttribute('data-col');
            if (sel.sortCol === col) {
                sel.sortDir = sel.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                sel.sortCol = col;
                sel.sortDir = 'asc';
            }
            renderWellDetailTable();
        });
    });

    document.querySelectorAll('#well-detail-table input[data-well-toggle]').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const site = e.target.getAttribute('data-site');
            toggleWell(site, e.target.checked);
        });
    });
}

// -------------------- Section 5.4: Representativeness --------------------

function renderSection54() {
    const container = document.getElementById('rep-content');
    if (!container) return;
    const sel = currentSelection;

    if (!sel) {
        container.innerHTML = `<div class="empty-state">Click a polygon on the map above to view the representativeness comparison.</div>`;
        return;
    }

    const rmsRefs = sel.wellsWithColor.filter(wc => wc.well.is_2022_gwl_rms && wc.well.site_code);
    if (rmsRefs.length === 0) {
        container.innerHTML = `<div class="empty-state">This polygon has no 2022 GWL RMS well with DWR data to use as a reference.</div>`;
        return;
    }
    if (sel.wellsWithColor.length < 2) {
        container.innerHTML = `<div class="empty-state">Only the RMS well is in this polygon - no test wells to compare against.</div>`;
        return;
    }

    if (!sel.selectedRmsRef || !rmsRefs.find(wc => wellKey(wc.well) === sel.selectedRmsRef)) {
        sel.selectedRmsRef = wellKey(rmsRefs[0].well);
    }

    let controlsHtml = '';
    if (rmsRefs.length > 1) {
        controlsHtml = `
            <div class="hydro-controls">
                <label for="rep-rms-select"><strong>2022 GWL RMS reference:</strong></label>
                <select id="rep-rms-select" class="rep-rms-select">
                    ${rmsRefs.map(wc => `
                        <option value="${wellKey(wc.well)}" ${wellKey(wc.well) === sel.selectedRmsRef ? 'selected' : ''}>${wc.well.well_name}</option>
                    `).join('')}
                </select>
                <span style="color:#888; font-size:12px; margin-left:auto;">All other wells in the polygon are plotted as test wells.</span>
            </div>`;
    }

    container.innerHTML = controlsHtml + `<div id="rep-chart"></div>`;

    if (rmsRefs.length > 1) {
        const sel2 = document.getElementById('rep-rms-select');
        if (sel2) {
            sel2.addEventListener('change', (e) => {
                currentSelection.selectedRmsRef = e.target.value;
                renderRepresentativenessChart();
            });
        }
    }

    renderRepresentativenessChart();
}

function renderRepresentativenessChart() {
    const sel = currentSelection;
    const refWc = sel.wellsWithColor.find(wc => wellKey(wc.well) === sel.selectedRmsRef);
    if (!refWc) return;
    const refWell = refWc.well;
    const refName = refWell.well_name;
    const rmsRecords = getMeasurements(refWell);

    const traces = [];
    const allValues = [];
    const repTraceIndices = {};   // wellKey -> [Plotly trace idx, ...]
    let traceIdx = 0;

    sel.wellsWithColor.forEach(({ well, color }) => {
        if (wellKey(well) === wellKey(refWell)) return;
        const testRecords = getMeasurements(well);
        const pairs = pairMeasurementsByMonth(rmsRecords, testRecords);
        if (pairs.length === 0) return;

        const r = pearsonR(pairs);
        const r2 = (r !== null && pairs.length >= 5) ? `, R²=${(r * r).toFixed(2)}` : '';
        const label = `${well.well_name} (n=${pairs.length}${r2})`;

        pairs.forEach(p => { allValues.push(p.x); allValues.push(p.y); });

        traces.push({
            x: pairs.map(p => p.x),
            y: pairs.map(p => p.y),
            mode: 'markers',
            name: label,
            marker: { color, size: 7, line: { color: 'white', width: 1 } },
            customdata: pairs.map(p => p.ym),
            hovertemplate: `<b>${well.well_name}</b><br>%{customdata}<br>${refName}: %{x:.2f} ft<br>Test: %{y:.2f} ft<extra></extra>`,
            visible: sel.visibility[wellKey(well)] ? true : 'legendonly',
        });
        repTraceIndices[wellKey(well)] = [traceIdx];
        traceIdx++;
    });

    sel.repTraceIndices = repTraceIndices;

    const target = document.getElementById('rep-chart');
    if (!target) return;

    if (traces.length === 0 || allValues.length === 0) {
        Plotly.newPlot('rep-chart', [], {
            title: { text: `No paired same-month readings available for ${refName}`, x: 0.5 },
            annotations: [{
                text: 'No test wells in this polygon share a measurement month with this RMS well.',
                xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false,
                font: { size: 14, color: '#999' },
            }],
            margin: { t: 50, b: 60, l: 60, r: 20 },
        }, { responsive: true });
        return;
    }

    const minV = Math.min(...allValues);
    const maxV = Math.max(...allValues);
    const pad = Math.max(1, (maxV - minV) * 0.05);
    const lo = minV - pad, hi = maxV + pad;

    traces.push({
        x: [lo, hi], y: [lo, hi],
        mode: 'lines',
        name: '1:1 (perfect representativeness)',
        line: { color: '#999', dash: 'dash', width: 2 },
        hoverinfo: 'skip',
    });

    const layout = {
        title: { text: `Representativeness vs. ${refName} (2022 GWL RMS reference)`, x: 0.5 },
        xaxis: { title: `${refName} GWE (ft AMSL)`, range: [lo, hi], zeroline: false },
        yaxis: { title: 'Test well GWE (ft AMSL)', range: [lo, hi], zeroline: false, scaleanchor: 'x', scaleratio: 1 },
        hovermode: 'closest',
        margin: { t: 60, b: 80, l: 70, r: 30 },
        legend: { orientation: 'h', y: -0.18 },
    };

    Plotly.newPlot('rep-chart', traces, layout, { responsive: true });
}

// -------------------- Refresh time --------------------

function updateRefreshTime() {
    const el = document.getElementById('refresh-time');
    if (typeof MEASUREMENTS_FETCHED_AT === 'string') {
        const dt = new Date(MEASUREMENTS_FETCHED_AT);
        el.textContent = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString();
    } else {
        el.textContent = 'Unknown - run scripts/fetch_dwr_data.py';
    }
}

// -------------------- Boot --------------------

window.addEventListener('DOMContentLoaded', () => {
    updateRefreshTime();
    initializeWells();
    initMap();

    const toggle = document.getElementById('polygon-toggle');
    if (toggle) {
        toggle.addEventListener('change', () => {
            if (!polygonLayer) return;
            if (toggle.checked) polygonLayer.addTo(map);
            else map.removeLayer(polygonLayer);
        });
    }
});
