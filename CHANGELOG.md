# Changelog

## 2026-10-19 (Oct 19, 2026)

### Web Bounding Box Downloader (`web/`)
- **Scaffolding & Map UI**: Vue 3 + Bun + Vite frontend embedding MapLibre GL JS with OSM tiles.
- **Geocoding & Telemetry**: Photon API autocomplete geocoder with camera fly-to; telemetry panel for bounds, metric dimensions, and area.
- **BBox Selection**: Interactive rectangle tool with corner/edge drag handles, safety warnings (>2.5 km²), and size limits (>10 km²).
- **Overpass Query & Export**: Overpass QL highway/building extractor with OSM 0.6 API fallback and JSON export packaging with projection metadata.

### Coordinate Projection & Data Normalization
- **Metric Projection**: Equirectangular / Local Tangent Plane projection centered on bbox centroid; mapped to Godot coordinates (+X East, +Y Up, -Z North; 1 unit = 1 meter).
- **Feature Parsing & Cleaning**: Categorization into linear highways, closed building ways, and multipolygon relations; deduplication of vertices (<0.05m tolerance), polygon closure verification, and CCW exterior winding.

### Building 3D Extrusion Engine
- **Height & Floor Inference**: Deterministic ladder evaluating explicit `height`, `building:levels` (3.3m/floor), semantic fallback types (residential, commercial, industrial, garage), and `min_height`/`min_level` base elevations.
- **Roof Triangulation**: 2D Earcut ear-clipping with collinear seam bridge routing for inner courtyard holes; upward normals and planar world-space UV tiling.
- **Wall Extrusion & Materials**: Perimeter quad generation with outward horizontal normals and cumulative length/height UV mapping; tag-driven material and color assignment (`building:colour`, `roof:colour`, `building:material`).

### Road Networks, Cross-Sections & Bike Lanes
- **Width & Surface Classification**: Deterministic hierarchy using explicit `width`, lane counts, or highway classifications; surface tag mapping to PBR material presets (asphalt, concrete, cobblestone, gravel, dirt).
- **Bike Infrastructure**: Extraction of dedicated cycleways and integrated street bike lanes (`cycleway=lane|track|left|right`); compound ribbon generation with offset bike tracks and distinctive green/red surfacing.
- **Ribbon Geometry & Vertical Layering**: Centerline ribbon extrusion via normal vectors with miter limit clamping (Godot `Geometry2D.offset_polyline`); `layer=*` and `bridge=*` elevation offsets, pillar generation, and Z-fighting height ladders (terrain, roads, bike lanes, paths).

### Godot 4 Importer & Scene Pipeline (`addons/osm_importer/`)
- **Plugin Architecture**: GDScript `@tool` EditorPlugin dock with UI controls, target path monitoring, and headless CLI support (`godot --headless -s test_phase5.gd`).
- **Mesh & Collision Generation**: SurfaceTool/ArrayMesh multi-surface generation (separate roof/wall surfaces) with static physics trimesh collisions.
- **Procedural PBR Materials**: StandardMaterial3D presets for roads, sidewalks, bike lanes, and walls with triplanar mapping.
- **Visualization Scene**: Default viewer scene (`city_viewer.tscn`) configured with directional sunlight, SSAO environment, and WASD fly/orbit inspection camera.

### Performance Optimization & Batching
- **Draw Call Reduction**: Material batching consolidating roads, bike lanes, and building walls into shared multi-surface ArrayMeshes (reducing draw calls from >8,000 to <25).
- **Spatial Chunking**: 2D spatial grid partitioning (500m × 500m cells) supporting distance-based visibility and LOD culling.

### Edge Case Handling & Test Verification Suite
- **Geometry & Tag Sanitization**: Auto-repair or skipping of unclosed/self-intersecting loops, cul-de-sac end-capping, multi-outer multipolygon splitting, roundabout curvature preservation, and regex sanitization of non-numeric tag values.
- **Headless Test Suite**: Fixture test coverage (`simple_grid.json`, `bike_infrastructure.json`, `complex_buildings.json`, `bridge_overpass.json`) verifying mesh surfaces, valid AABBs, non-empty vertex buffers, and zero-NaN output.
