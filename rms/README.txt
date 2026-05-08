2022 RMS Polygon Network — Vina Subbasin
=========================================

Source: 2022 Vina GSA Groundwater Sustainability Plan, Appendix 3B

Contents
--------
  2022_RMS_Network.shp / .shx / .dbf / .prj / .cpg   Shapefile (15 polygons)
  2022 RMS Network.png                                Reference map
  README.txt                                          This file

Polygon network
---------------
The shapefile contains 15 Voronoi polygons, one per Representative Monitoring
Site (RMS) well, grouped into three management regions:

  - Vina-North  (6 polygons)
  - Vina-South  (6 polygons)
  - Chico       (3 polygons)

The well 33A001 appears in both Vina-North and Chico; the larger Vina-North
cell and the smaller Chico cell are both retained as separate records.

Coordinate system
-----------------
NAD83(2011) California Albers (meters). The .prj is included; in QGIS/ArcGIS
the file will load with the projection applied automatically.

Attribute table fields
----------------------
  rId         Region-internal record id (0–5 per region; restarts at 0)
  Map_label   Well short id (e.g. "05M001M", "33A001M")
  Area        Polygon area (acres)
  Region      One of: Vina-North, Vina-South, Chico

Contact
-------
Tovey Giezentanner — Tuscan Water District / AGUBC
