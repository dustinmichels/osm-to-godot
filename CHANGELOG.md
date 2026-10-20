# Changelog

## 2026-10-20

### Overture Maps & GeoJSON Pipeline

- Ingestion of Overture Maps Foundation GeoJSON data via `geojson_parser.gd`.
- Spatial point-in-polygon containment matching POI nodes to building footprints.
- 7-tier building naming resolution ladder (name → housename → brand → enclosed POI → street address → specialized type → fallback ID).
- Standalone POI `Marker3D` scene nodes with metadata tags.

### 2D Street Studio & Decoupling

- Evolved web frontend into a standalone 2D Urban Geometry Studio (`web/`).
- Added 2D street corridor, cross-section, lane, and building footprint editing with undo/redo history.
- Added Project JSON (`ProjectEnvelope` v1.0.0) save/load and derived scene GeoJSON export.
- Decoupled Godot bridge into an optional background listener with non-blocking status chip (`POST /api/import`).
- Began DuckDB-WASM migration plan for client-side Overture S3 GeoParquet querying via HTTP range requests.

---

## 2026-10-19

### Web Bounding Box Downloader (`web/`)

- Vue 3 + Bun + Vite frontend embedding MapLibre GL JS with OSM tiles.
- Photon API autocomplete geocoder with camera fly-to; telemetry panel for bounds, dimensions, and area.
- Interactive rectangle tool with corner/edge drag handles, safety warnings (>2.5 km²), and size limits (>10 km²).
- Overpass QL query builder with OSM 0.6 API fallback and JSON export packaging with projection metadata.

### Coordinate Projection & Data Normalization

- Metric Equirectangular / Local Tangent Plane (LTP) projection centered on bbox centroid (+X East, +Y Up, -Z North; 1 unit = 1 meter).
- Categorization into linear highways, closed building ways, and multipolygon relations; vertex deduplication (<0.05 m tolerance), polygon closure verification, and CCW exterior winding.

### Building 3D Extrusion Engine

- Deterministic height ladder: explicit `height` → `building:levels` (3.3 m/floor) → semantic fallback → default 8.0 m.
- 2D Earcut ear-clipping with collinear seam bridge routing for inner courtyard holes.
- Perimeter quad wall extrusion with outward normals, horizontal/vertical UV mapping, and PBR materials.
- Dual building generation modes: interactive in-editor `CSGPolygon3D` (default) and batched `ArrayMesh`.

### Road Networks, Cross-Sections & Bike Lanes

- Highway hierarchy width and lane count lookup tables; surface tag mapping to PBR materials (asphalt, concrete, cobblestone, gravel, dirt).
- Dedicated cycleways and on-road bike lane slicing (`cycleway=lane|track|left|right`) with distinctive green/red surfacing.
- Centerline ribbon extrusion via normal vectors with miter limit clamping (`Geometry2D.offset_polyline`).
- Vertical layer offsets (`layer=*`, `bridge=*`, `tunnel=*`), bridge support pillars, and anti-Z-fighting height ladders.

### Godot 4 Importer & Scene Pipeline (`addons/osm_importer/`)

- `@tool` EditorPlugin dock with UI controls, target path monitoring, and headless CLI support.
- Embedded HTTP server on port 8080 serving bundled web assets and receiving import payloads.
- SurfaceTool/ArrayMesh multi-surface generation (separate roof/wall surfaces) with static physics trimesh collisions.
- Default viewer scene (`city_viewer.tscn`) configured with directional sunlight, SSAO environment, and WASD fly/orbit inspection camera.

### 3D Character Exploration

- Rigged 66-bone CC0 humanoid mannequin (Quaternius) with locomotion animations (`character.tscn`).
- Player controller with collision capsule, SpringArm3D camera, jump, sprint, and controls HUD.
- Walkable ground collision plane, automatic street placement, and instant toggle ([V] / [Tab]) between third-person and overhead flycam.

### Performance Optimization & Verification

- Material batching consolidating roads, bike lanes, and walls into shared multi-surface meshes.
- 2D spatial grid partitioning (500 m × 500 m cells) supporting distance-based culling.
- Edge case repair (unclosed loops, cul-de-sac caps, multipolygon outer rings, roundabout curvature, regex tags).
- Headless test suite (`test_importer_headless.gd`, `test_player_character.gd`) validating zero NaNs, valid AABBs, non-empty vertex buffers across test fixtures.
