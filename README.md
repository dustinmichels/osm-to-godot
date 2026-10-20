# OSM-to-Godot

Extract real-world OpenStreetMap (OSM) data via an interactive web interface and deterministically generate 3D Godot scenes with accurate road profiles, bike lanes, surface materials, and extruded buildings.

## Architecture

- **`web/` (Phase 1)**: Interactive web bounding-box downloader built with Bun, Vite, Vue 3, and MapLibre GL. Features direct "Send to Godot" HTTP integration and exports `osm_export.json`.
- **`godot_project/addons/osm_importer/` (Phases 2–5)**: Godot 4 EditorPlugin and processing pipeline:
  - `http_server.gd`: Embedded local HTTP server running on port 8080. Serves the bundled web interface directly and provides an `/api/import` endpoint with CORS support.
  - `osm_dock.gd`: Bottom panel editor UI with server status, 1-click browser launch button, and live import activity monitor.
  - `projection.gd`: Converts WGS84 coordinates (latitude/longitude in degrees) to local metric Cartesian coordinates (Godot $X, Y, Z$) centered on the bounding box centroid to avoid 32-bit floating-point jitter.
  - `osm_parser.gd`: Ingests Overpass JSON/XML, groups features into highways, standalone buildings, and multipolygon building relations, deduplicates vertices ($<0.05\text{m}$), enforces polygon closure, and normalizes polygon winding order (CCW for exterior, CW for holes).
---

## Installing the Godot Addon

### In an Existing Godot 4 Project

1. Copy the `godot_project/addons/osm_importer` directory into your project's `addons/` folder:
   ```bash
   cp -r godot_project/addons/osm_importer <your_godot_project>/addons/
   ```
2. Open your project in the **Godot 4 Editor**.
3. Navigate to **Project -> Project Settings -> Plugins**.
4. Find **OSM Importer** in the plugins list and check the **Enable** checkbox.

### Running with the Included Godot Project

The repository includes a ready-to-use Godot 4 project in `godot_project/`:

```bash
# Open in Godot 4 Editor
godot --editor --path godot_project
```

---

## Integrated Workflow: One-Click Web Selector & Direct Import

Once the **OSM Importer** plugin is enabled:

1. Look at the bottom editor panel and click the **OSM Importer** tab (or click **🗺️ OSM Selector** on the 3D viewport toolbar).
2. Click **🌐 Open Web Selector**. The plugin opens the embedded MapLibre web app in your default browser (running on `http://127.0.0.1:8080`).
3. Pan or search for an area, drag a bounding box, and click **⚡ Send to Godot**.
4. The web app transfers the data directly over HTTP into Godot. The plugin saves it to `res://data/osm_export.json`, automatically generates the 3D city scene (`res://city_viewer.tscn`) with extruded buildings, roof triangulation, PBR materials, and physics colliders, and opens it directly in the 3D editor viewport.
5. You can also re-generate at any time by clicking **🔨 Generate 3D City** in the bottom panel dock, or press **F5** to run the 3D inspection viewer (Left/Right-click drag to look, Mouse Wheel to zoom, WASD / Arrows to fly, [H] to toggle the HUD).

### Building Generation Modes

* **Extrude 2D Footprints (`CSGPolygon3D`) — Recommended for Small Areas & Prototyping:**
  * Enabled by default via the **Extrude 2D Footprints (CSG)** checkbox in the bottom dock panel.
  * Each building is generated as an extruded 2D polygon footprint centered at its real-world centroid and base elevation.
  * **Interactive in-editor editing:** Clicking any building in the Godot 3D viewport exposes the 2D polygon handles so you can drag vertices, reshape footprints, or adjust the `depth` (height) property directly in the Inspector.
  * Courtyards and interior lightwells are carved cleanly using child `CSGPolygon3D` nodes configured with `OPERATION_SUBTRACTION`.
  * Colliders are handled natively on the CSG node (`use_collision = true`).

* **Standard Static Mesh (`ArrayMesh`) — Recommended for Large / City-Scale Imports:**
  * Uncheck **Extrude 2D Footprints (CSG)** to use the high-performance `ArrayMesh` pipeline.
  * Generates two separate surfaces per building (Surface 0: Walls with unrolled UVs; Surface 1: Roofs triangulated via Earcut).
  * Supports material batching and spatial 500m grid chunking for maximum draw-call efficiency across thousands of buildings.

### Future Enhancement to Try: 2D Footprint Simplification (Douglas-Peucker)

Real-world OpenStreetMap footprints traced from aerial satellite photography often contain 30–60 vertices per building, including tiny centimeter-level jitter, alcove notches, and redundant collinear points along straight walls.

A planned/experimental enhancement is running a **Ramer-Douglas-Peucker (RDP)** or **Visvalingam-Whyatt** 2D polygon simplification pass before extrusion:
* **Straightening walls:** Setting a simplification tolerance ($\epsilon \approx 0.5\text{m} - 1.0\text{m}$) eliminates microscopic edge segments and snaps noisy outlines into crisp, clean rectangular shapes.
* **Right-angle orthogonalization:** Snapping corners near $90^\circ$ creates clean, stylized architectural "white-box" geometry.
* **Reduced complexity:** Decreases footprint vertex counts by 70–85%, producing cleaner wireframes in both `CSGPolygon3D` and `ArrayMesh` modes without sacrificing building silhouette fidelity.
---

## Running the Web Downloader in Development Mode

If you want to modify or develop the Vue frontend:

```bash
cd web
bun install
bun run dev
```

Visit `http://localhost:5173`. When Godot is open with the plugin enabled, the web app detects the Godot editor connection on port 8080, and the **⚡ Send to Godot** button will route exports directly to the editor!

To bundle web changes into the Godot plugin:
```bash
mise run build-web
```

```bash
cd web
bun install
bun run dev
```

Visit `http://localhost:5173` to select a bounding box, search addresses, and download `osm_export.json`.

---

## Converting OSM Export to GeoJSON

Convert a downloaded `osm_export.json` file to GeoJSON in `data/map.geojson`:

```bash
mise run convert-geojson
```

When prompted, drag and drop the exported file into your terminal (or pass the path directly as an argument):

```bash
mise run convert-geojson '/Users/dustinmichels/Downloads/osm_export(1).json'
```

The converted file is written to `data/map.geojson`.
---

## Running Automated Tests

Run the headless Godot test suite against all fixtures:

```bash
mise run test
```

Or run directly via Godot:
```bash
godot --headless --path godot_project -s res://test_importer_headless.gd
```

Run the web test suite:
```bash
mise run test-web
# or: cd web && bun test
```

---

## Standalone Desktop Distribution

To package OSM-to-Godot as a standalone, turnkey desktop application for general users (with Godot engine runtime bundled), see the detailed guide:

* [**Standalone Desktop Tool & Distribution Guide**](docs/standalone_distribution.md)
