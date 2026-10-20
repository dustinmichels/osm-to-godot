# OSM-to-Godot: Project Plan & Roadmap

Architecture milestones, completed deliverables, and active development roadmap for extracting real-world geographic data (OpenStreetMap and Overture Maps) and procedurally generating 3D Godot scenes.

---

## Completed Milestones

### Phase 1: Web Bounding Box Downloader (`web/`)

- [x] Vue 3 + Bun + Vite frontend with MapLibre GL JS base map.
- [x] Photon geocoding search input with debounced autocomplete and camera fly-to.
- [x] Interactive rectangle bounding box selector with corner/edge drag handles.
- [x] Overpass QL query builder with OSM 0.6 API fallback and JSON export packaging.
- [x] Reactive telemetry panel (WGS84 bounds, metric dimensions, area, safety thresholds).

### Phase 2: Coordinate Projection & Normalization

- [x] Equirectangular / Local Tangent Plane (LTP) projection centered at bounding box centroid.
- [x] Coordinate mapping aligned with Godot 3D (+X East, +Y Up, -Z North; 1 unit = 1 meter).
- [x] Vertex deduplication (<0.05 m tolerance), polygon closure enforcement, CCW exterior winding.

### Phase 3: Building 3D Extrusion Engine

- [x] Height inference ladder: explicit `height` → `building:levels` (3.3 m/floor) → semantic fallback → default 8.0 m.
- [x] 2D Earcut triangulation supporting complex footprints and inner courtyard holes.
- [x] Procedural wall extrusion with outward normals, horizontal length/height UV mapping, and PBR materials.
- [x] Dual generation modes: interactive in-editor `CSGPolygon3D` (default) and batched `ArrayMesh`.

### Phase 4: Road Networks, Cross-Sections & Bike Lanes

- [x] Highway hierarchy width and lane count lookup tables.
- [x] Dedicated cycleways and integrated on-road bike lane slicing (`cycleway=lane|track|left|right`).
- [x] Centerline ribbon mesh generation with miter clamping (`Geometry2D.offset_polyline`).
- [x] Vertical layer offsets (`layer=*`, `bridge=*`, `tunnel=*`) with anti-Z-fighting elevation steps.

### Phase 5: Godot 4 Importer & Visualization

- [x] `@tool` EditorPlugin dock with generation toggles, server monitor, and 1-click browser launch.
- [x] Embedded HTTP server (`http_server.gd`) on port 8080 serving web UI and receiving `POST /api/import`.
- [x] Multi-surface `ArrayMesh` and static physics trimesh collider generation.
- [x] Default viewing scene (`res://city_viewer.tscn`) with physical sky, directional sun, and SSAO.

### Phase 6: Performance Optimization & Batching

- [x] Material batching consolidating roads, bike lanes, and walls into shared multi-surface meshes.
- [x] 2D spatial grid partitioning (500 m × 500 m cells) for distance culling.

### Phase 7: Edge Cases & Verification Suite

- [x] Sanitization: unclosed loops, dead-end caps, multi-outer multipolygons, roundabout curvature, regex tags.
- [x] Headless test harness (`test_importer_headless.gd`) verifying zero-NaN coordinates, non-empty meshes, and valid AABBs across test fixtures.

### Phase 8: 3D Character Exploration

- [x] Rigged 66-bone humanoid mannequin (CC0 Quaternius) with locomotion animations (`character.tscn`).
- [x] CharacterBody3D player with collision capsule, SpringArm3D camera, jump, sprint, and HUD.
- [x] Ground collision plane, automatic street placement, and instant toggle between player and flycam.
- [x] Headless character verification suite (`test_player_character.gd`).

### Phase 9: Overture Maps & POI Integration

- [x] Ingestion of Overture Maps GeoParquet/GeoJSON (`scripts/fetch_overture.py` and `geojson_parser.gd`).
- [x] Spatial containment matching POI nodes to enclosing building footprints.
- [x] 7-tier building naming ladder (name tag → house name → brand → POI → address → type → fallback ID).
- [x] Instantiation of standalone POI `Marker3D` nodes with metadata.

---

## Active Roadmap

### 1. DuckDB-WASM Standalone 2D Studio

_Status: In Progress. Spec: `docs/duckdb_wasm_standalone_editor_plan.md`. Tasks: `todo/duckdb_wasm_standalone_editor.md`._

- Query Overture Maps GeoParquet directly from S3 in-browser via `@duckdb/duckdb-wasm` (HTTP range requests + spatial).
- Decouple 2D editor into a zero-prerequisite standalone web GIS tool.
- Make Godot an optional downstream consumer via `POST /api/import` or GeoJSON drag-and-drop.

### 2. Street & Sidewalk Geometry Refinement

_Status: In Progress. Tasks: `todo/streets.md`._

- Filter pedestrian micro-connectors, crossing clutter, and service way noise.
- Generate 3D vertical stepped curbs (+15 cm) and dedicated sidewalk surfaces.
- 2D boolean unioning of road intersections to eliminate overlapping ribbon artifacts.
- Ramer-Douglas-Peucker (RDP) polyline simplification for GPS jitter reduction.

---

## Repository Structure

```
osm-to-godot/
├── README.md                           # Main documentation & quickstart
├── plan.md                             # Milestones & active roadmap (this file)
├── CHANGELOG.md                        # Version & milestone history
├── mise.toml                           # Toolchain & task definitions
├── docs/                               # Architecture specifications & audits
│   ├── duckdb_wasm_standalone_editor_plan.md
│   ├── export_clipping_policy.md
│   ├── road_profile_audit.md
│   ├── building_naming_and_pois.md
│   └── standalone_distribution.md
├── todo/                               # Actionable task ledgers
│   ├── duckdb_wasm_standalone_editor.md
│   └── streets.md
├── web/                                # 2D Web Studio (Vue 3, Vite, MapLibre, DuckDB)
│   ├── src/
│   │   ├── components/                 # MapView, Toolbar, Inspector, Controls
│   │   ├── composables/                # State management, Bbox, editor models
│   │   └── services/                   # Data fetching, Overpass, DuckDB
├── godot_project/                      # Godot 4 Engine Project
│   ├── scenes/                         # city_viewer.tscn, camera_controller.gd
│   ├── character/                      # Rigged mannequin, player controller, animations
│   ├── materials/                      # PBR StandardMaterial3D presets
│   └── addons/osm_importer/            # Importer plugin, parser, builders, HTTP server
├── scripts/                            # Data conversion & utility scripts
└── tests/fixtures/                     # OSM JSON & GeoJSON test fixtures
```
