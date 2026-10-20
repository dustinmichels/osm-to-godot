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
4. The web app transfers the data directly over HTTP into Godot. The plugin saves it to `res://data/osm_export.json`, parses roads and buildings immediately, and logs the results in the editor activity feed.

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

Run the headless Godot test suite to verify coordinate projection, geometry parsing, and HTTP server integration:

```bash
mise run test
```

Or run individual test scripts directly:
```bash
godot --headless --path godot_project -s res://test_phase2.gd
godot --headless --path godot_project -s res://test_http_server.gd
```
