# OSM-to-Godot

Extract real-world geographic data (OpenStreetMap & Overture Maps) and generate procedural 3D Godot scenes with accurate road profiles, bike lanes, surface materials, and extruded buildings.

Includes an in-browser 2D street and map editor, a local HTTP bridge, and a rigged 3D character controller for on-foot exploration.

---

## Architecture

- **`web/`**: Standalone 2D Map & Street Studio built with Bun, Vite, Vue 3, and MapLibre GL.
  - Bounding-box area selector with telemetry (bounds, dimensions, area).
  - In-browser, zero-dependency ingestion from Overture Maps (via client-side DuckDB-WASM directly from S3 GeoParquet) and OpenStreetMap (Overpass API).
  - 2D corridor, lane cross-section, and building footprint editing in plan view.
  - Project save (`ProjectEnvelope` JSON) and scene surface export (`GeoJSON`).
  - Optional direct HTTP bridge sending generated scene payloads to Godot (`POST 127.0.0.1:8080/api/import`).
- **`godot_project/addons/osm_importer/`**: Godot 4 EditorPlugin and procedural geometry engine:
  - `http_server.gd`: Local HTTP server (port 8080) serving bundled web assets and receiving import payloads.
  - `osm_dock.gd`: Bottom editor dock with bridge status, browser launcher, and generation toggles.
  - `projection.gd`: Converts WGS84 coordinates to local metric Cartesian coordinates ($X, Y, Z$) relative to the bounding box centroid, preventing 32-bit floating-point jitter.
  - `osm_parser.gd` & `geojson_parser.gd`: Normalizes OSM Overpass JSON/XML and Overture GeoJSON into unified building, road, and POI records.
  - `building_builder.gd`: Extrudes buildings via interactive `CSGPolygon3D` or batched `ArrayMesh` with Earcut roof triangulation, multi-tier height inference, and POI/address naming.
  - `road_builder.gd`: Procedural road, sidewalk, and bike lane ribbons with miter clamping, vertical layer offsets, and PBR materials.
  - `scene_builder.gd`: Assembles complete scenes with lighting, collision planes, and POI `Marker3D` nodes.
- **`godot_project/character/`**: Rigged third-person character controller (`character.tscn`) with locomotion animations (CC0 by Quaternius) and overhead flycam toggle.

## Design Philosophy

- **Real-world data as a seed**: Importing real-world geographic data (OSM or Overture) provides initial spatial layouts and corridor geometry, acting as a project baseline rather than a synchronized database.
- **Intentional simplification**: It is acceptable and expected to simplify geometry and drop non-essential cartographic details during ingestion. Pristine fidelity to raw surveyor idiosyncrasies is deprioritized in favor of geometric clarity and simulation performance.
- **2D editor as a design tool**: The 2D studio is an active authoring and redesign environment—enabling users to reshape corridors, reallocate right-of-way, edit lane cross-sections, and modify urban form.
- **Compilation to 3D simulation**: The 2D representation compiles unidirectionally into a 3D Godot scene for real-time traversal, physics, and visual evaluation.
- **No backward compatibility with OSM**: The internal schema has no requirement to maintain backwards compatibility, round-trip sync, or changeset fidelity with raw OpenStreetMap data or IDs.

---

## Quickstart

### Standalone Web Studio (No Godot Required)

The 2D Urban Geometry Studio runs completely standalone in your browser with zero host dependencies or Python toolchains:

```bash
cd web
bun install
bun run dev
```

Visit `http://localhost:5173` to select a bounding box, query Overture GeoParquet directly via DuckDB-WASM over HTTPS, edit street profiles in 2D, and save projects or export GeoJSON scenes.

### Running with the Godot Engine (Optional 3D Simulation)

Prerequisites: [mise](https://mise.jdx.dev/) and [Godot 4](https://godotengine.org/).

```bash
# Clear any prior city scene and launch Godot Editor
mise run dev

# Or launch directly without clearing
godot --editor --path godot_project
```

To bundle web changes into the Godot plugin:

```bash
mise run build-web
```

### Installing into an Existing Godot Project

1. Copy `godot_project/addons/osm_importer` into your project's `addons/` directory.
2. In Godot, go to **Project -> Project Settings -> Plugins** and enable **OSM Importer**.
3. Use the bottom panel dock tab or toolbar button to launch the web studio and import data.

---

## Workflow

1. **Launch 2D Studio**: Run `bun run dev` in `web/` (or open Godot and click **🌐 Open Web Selector** in the bottom **OSM Importer** dock).
2. **Acquire Geometry**: Select any bounding box and click **Acquire Overture (DuckDB)**. DuckDB-WASM streams buildings, transportation segments, places, and addresses directly from Overture S3 GeoParquet in your browser.
3. **Edit in 2D**: Reshape corridors, adjust lane cross-sections, bike infrastructure, and building heights in plan view.
4. **Save or Export**:
   - Save your project as `ProjectEnvelope` JSON to resume editing later.
   - Export 2D scene surfaces as standard GeoJSON.
   - If Godot 4 is running, click **⚡ Send to Godot 3D** to stream geometry directly via the HTTP bridge.
5. **Explore in 3D (Godot)**: The scene generates procedurally in `res://city_viewer.tscn`. Press **F5** to walk or fly through the generated urban space with the character controller.

### Controls

| Input                       | Action                                |
| :-------------------------- | :------------------------------------ |
| **W / A / S / D** or Arrows | Move character (relative to camera)   |
| **Shift**                   | Sprint                                |
| **Space**                   | Jump                                  |
| **Mouse Drag**              | Orbit camera                          |
| **Scroll Wheel**            | Zoom camera                           |
| **V / Tab**                 | Toggle Third-Person / Overhead Flycam |
| **H**                       | Toggle on-screen controls HUD         |
| **Esc**                     | Release mouse capture                 |

### Building Generation Modes

- **Extrude 2D Footprints (`CSGPolygon3D`) — Default**: Each building is an extruded 2D polygon with vertex handles visible in the 3D viewport for direct manual editing in the Inspector. Courtyards are carved via subtraction. Collisions are handled natively.
- **Standard Static Mesh (`ArrayMesh`)**: High-performance multi-surface meshes (Surface 0: Walls with unrolled UVs, Surface 1: Earcut roofs). Recommended for large city-scale imports and spatial chunking.

---

## Tasks & Commands

| Task                      | Command                             | Description                                                         |
| :------------------------ | :---------------------------------- | :------------------------------------------------------------------ |
| `mise run dev`            | `godot --editor`                    | Clears scene and opens Godot editor                                 |
| `mise run test`           | Headless Godot                      | Runs full engine test suite against all fixtures                    |
| `mise run test-web`       | `bun test`                          | Runs web composable and geometry unit tests                         |
| `mise run build-web`      | `bun run build:addon`               | Compiles web app into `godot_project/addons/osm_importer/web_dist/` |
| `mise run fmt`            | `gdformat` + `oxfmt`                | Formats GDScript and Markdown files                                 |
| `mise run geojson`        | `./scripts/convert-geojson.sh`      | Converts OSM export JSON to GeoJSON                                 |
| `mise run fetch-overture` | `python3 scripts/fetch_overture.py` | [LEGACY] Headless CLI Overture fetch tool                           |

---

## Documentation

- [Design Philosophy](docs/design_philosophy.md): 2D design tool to 3D simulation pipeline, lossy ingestion, and decoupling from OSM backward compatibility.
- [Building Naming & POI Integration](docs/building_naming_and_pois.md): Address and POI fallback matching ladder.
- [Export Clipping Policy](docs/export_clipping_policy.md): Bounding box geometry retention and polygon clipping modes.
- [Road Profile Audit](docs/road_profile_audit.md): Cross-section rules, lane widths, and bike-lane resolutions.
- [Standalone Distribution](docs/standalone_distribution.md): Packaging as a turnkey desktop application without engine prerequisites.
- [DuckDB-WASM Editor Plan](docs/duckdb_wasm_standalone_editor_plan.md): In-browser GeoParquet spatial querying architecture.
- [Character Attribution](godot_project/character/CREDITS.md): CC0 character asset credits.
