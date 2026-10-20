# Street & Sidewalk Geometry Cleanup

Actionable plan to simplify, declutter, and refine road, curb, and sidewalk procedural mesh generation from OpenStreetMap data.

---

## Phase 1: Ingestion & Tag Filtering (Pruning Micro-Geometry)

- [ ] **1.1 Filter pedestrian micro-connectors & crossings**
  - [ ] In `osm_parser.gd`, identify and filter out `highway=footway` where `footway=crossing` or `footway=link` to eliminate diagonal crossing spaghetti.
  - [ ] Skip indoor/corridor ways (`highway=corridor`).
- [ ] **1.2 Filter or de-emphasize service ways**
  - [ ] Add option to skip or narrow parking lot aisles (`highway=service` + `service=parking_aisle`) and driveways (`service=driveway`).
  - [ ] Classify remaining service ways to low-contrast/narrower profiles ($2.5\text{m} - 3.0\text{m}$).
- [ ] **1.3 Sidewalk deduplication**
  - [ ] Inspect road tags for `sidewalk` / `sidewalk:both` / `sidewalk:left` / `sidewalk:right`.
  - [ ] If a road already defines sidewalks (or if procedural curb/sidewalk generation is active on the road profile), suppress separate parallel `highway=footway` with `footway=sidewalk` that run within road buffer distance.

---

## Phase 2: Integrated Road Cross-Sections & Procedural Curbs

- [ ] **2.1 Extend compound cross-section specification**
  - [ ] In `RoadBuilder.compute_cross_sections()`, add support for `curb` and `sidewalk` slice types.
  - [ ] Define standard curb parameters: width $0.15\text{m}$, height step $+0.15\text{m}$ (from $Y = 0.05\text{m}$ road to $Y = 0.20\text{m}$ sidewalk).
- [ ] **2.2 Generate 3D vertical curb geometry**
  - [ ] In `RoadBuilder.generate_road_ribbon()`, support 3D stepped cross-section profiles (vertical quad rise at curb edge).
  - [ ] Assign concrete curb/sidewalk material (`res://materials/concrete_sidewalk.tres`).
- [ ] **2.3 Sidewalk width resolution based on road hierarchy**
  - [ ] Primary/Secondary: $2.0\text{m} - 2.5\text{m}$ sidewalk width.
  - [ ] Residential/Tertiary: $1.5\text{m} - 1.8\text{m}$ sidewalk width.
  - [ ] Motorways/Trunks: omit sidewalks unless explicitly tagged.

---

## Phase 3: 2D Polygon Unioning & Clipping (`Geometry2D`)

- [ ] **3.1 2D Road polygon footprint generation**
  - [ ] Convert 3D centerlines into 2D polyline arrays (`PackedVector2Array`) projected on the XZ plane.
  - [ ] Use `Geometry2D.offset_polyline()` with `JOIN_MITER` / `JOIN_SQUARE` and `END_BUTT` to generate 2D polygon footprints for each road.
- [ ] **3.2 Road intersection unioning (merge overlapping ribbons)**
  - [ ] Batch merge overlapping road polygons of identical material/layer using `Geometry2D.merge_polygons()`.
  - [ ] Eliminate internal overlapping quads, seams, and Z-fighting at intersections and T-junctions.
- [ ] **3.3 Sidewalk-to-road clipping**
  - [ ] For standalone pedestrian ways/plazas, clip against merged road polygons using `Geometry2D.clip_polygons()` to prevent sidewalks from encroaching into vehicular asphalt.
- [ ] **3.4 Triangulation & mesh creation**
  - [ ] Triangulate merged 2D footprints using `earcut.gd` or `Geometry2D.triangulate_polygon()`.
  - [ ] Build clean `ArrayMesh` surfaces without internal edge clutter.

---

## Phase 4: Vertical Hierarchy & Elevation Offsets

- [ ] **4.1 Rebalance elevation constants in `road_builder.gd`**
  - [ ] Ground / Terrain: $Y = 0.00\text{m}$
  - [ ] Service roads / Driveways: $Y = 0.03\text{m}$
  - [ ] Carriageways (Roads): $Y = 0.05\text{m}$
  - [ ] Bike lanes (flush with road or green stripe): $Y = 0.055\text{m}$
  - [ ] Raised curbs & sidewalks: $Y = 0.20\text{m}$ (realistic $+15\text{cm}$ curb height)
  - [ ] Bridges: $Y \ge 4.50\text{m}$
- [ ] **4.2 Dead-end cap refinement**
  - [ ] Restrict `cap_type = "round"` only to true cul-de-sacs (`highway=turning_circle` or `highway=turning_loop`), rather than every degree-1 endpoint.
  - [ ] Use flat square caps at bounding box clip edges to prevent semicircular bulb artifacts.

---

## Phase 5: Polyline Simplification & Curve Smoothing

- [ ] **5.1 Ramer-Douglas-Peucker (RDP) polyline simplification**
  - [ ] Implement RDP reduction in `osm_parser.gd` (`sanitize_polyline`) with an epsilon tolerance ($\sim 0.5\text{m} - 1.0\text{m}$) to remove redundant collinear points and high-frequency GPS jitter.
- [ ] **5.2 Corner beveling / fillet at sharp turns**
  - [ ] Detect acute interior angles ($< 60^\circ$) along polylines and bevel or clamp offsets to avoid elongated needle miter vertices.

---

## Phase 6: Headless Verification & Testing

- [ ] **6.1 Verify with headless test suite**
  - [ ] Run `mise run test` (`godot --headless --path godot_project -s res://test_importer_headless.gd`).
  - [ ] Verify zero NaN/Inf coordinates, valid AABBs, and clean mesh surface counts across all fixtures (`simple_grid.json`, `medford_y_export.json`, `bike_infrastructure.json`).
- [ ] **6.2 Visual inspection in `city_viewer.tscn`**
  - [ ] Load Medford Y and urban grid fixtures to confirm clean, non-overlapping street and sidewalk geometry.
