# OSM-to-Godot: Implementation Plan

Comprehensive implementation plan for extracting real-world OpenStreetMap (OSM) data via an interactive web interface and deterministically generating 3D Godot scenes with accurate road profiles, bike lanes, surface materials, and extruded buildings.

## Phase 1: Web Bounding Box Downloader

- [x] **1.1 Application Scaffolding & Base Map (`web/`)**
  - [x] Initialize frontend application using **Bun** and **Vite** with **Vue 3** (`<script setup>`, TypeScript).
  - [x] Embed **MapLibre GL JS** (`maplibre-gl`) in a reactive Vue component (`MapView.vue`) with OpenStreetMap raster/vector tiles.
  - [x] Add geocoding search input powered by **Photon** (`photon.komoot.io/api/`) with debounced autocomplete and camera fly-to on selection.
  - [x] Add coordinate telemetry panel (`TelemetryPanel.vue`) displaying reactive metrics:
    - Bounding coordinates: South, West, North, East (WGS84 degrees).
    - Calculated width and height in meters/kilometers.
    - Total selected surface area in $\text{km}^2$.

- [x] **1.2 Bounding Box Selection Tooling**
  - [x] Implement drag-to-select rectangle tool on the MapLibre map with dynamic GeoJSON sources/layers.
  - [x] Support visual resize/drag handles on rectangle corners and edges with interactive cursor cues.
  - [x] Manage selection state and geometric calculations via a shared Vue composable (`useBBox.ts`).
  - [x] Add reactive safety size guards:
    - Visual warning indicator when selection exceeds $2.5\text{ km}^2$.
    - Hard limit or confirmation modal above $10\text{ km}^2$ to prevent Overpass API timeout/throttling.

- [x] **1.3 OSM / Overpass Query & Downloader**
  - [x] Construct optimized Overpass QL query filtering explicitly for highways and buildings:
    ```overpass
    [out:json][timeout:30];
    (
      way["highway"]({{bbox}});
      way["building"]({{bbox}});
      relation["building"]({{bbox}});
    );
    out body geom;
    ```
  - [x] Implement fallback to official OSM 0.6 API (`api.openstreetmap.org/api/0.6/map?bbox=...`) for small high-speed bounding box grabs.
  - [x] Implement client-side export service (`useOverpass.ts`) generating downloadable `osm_export.json` with metadata header containing query timestamp, bbox bounds, and projection centroid.

---

## Phase 2: Data Normalization & Coordinate Projection

- [x] **2.1 Coordinate Projection System**
  - [x] Compute bounding box centroid $(\phi_0, \lambda_0)$ in radians as the local origin $(0, 0, 0)$.
  - [x] Implement metric Equirectangular / Local Tangent Plane projection:
        $$x = R \cdot (\lambda - \lambda_0) \cdot \cos(\phi_0) \cdot \frac{\pi}{180^\circ}$$
        $$z = -R \cdot (\phi - \phi_0) \cdot \frac{\pi}{180^\circ}$$
        where Earth radius $R = 6,378,137\text{ m}$.
  - [x] Align with Godot 3D coordinate system:
    - $+X$ = East
    - $+Y$ = Up (Elevation / Building Height)
    - $-Z$ = North
    - $1.0\text{ Godot unit} = 1.0\text{ meter}$ real-world scale.
  - [x] Prevent 32-bit floating point precision jitter by ensuring all vertex coordinates are relative to local origin $(0, 0, 0)$.

- [x] **2.2 Feature Ingestion & Geometry Assembly**
  - [x] Parse Overpass JSON `elements[]` or OSM XML `<way>` and `<relation>`.
  - [x] Group features into:
    - Linear Highway ways (`tags.highway != null`).
    - Building footprint ways (`tags.building != null` and closed loop).
    - Building multipolygon relations (`tags.type == "multipolygon"` and `tags.building != null`).
  - [x] Clean and sanitize coordinates:
    - Remove duplicate adjacent vertices within a tolerance of $<0.05\text{m}$.
    - Verify polygon closure (first point equals last point).
    - Enforce counter-clockwise (CCW) winding for exterior rings.

---

## Phase 3: Building Footprint & 3D Extrusion Engine

- [x] **3.1 Building Height & Floor Level Inference**
  - [x] Implement deterministic height resolution ladder:
    1. Parse explicit `height` tag (clean units: `"15"`, `"15m"`, `"15.2 m"`).
    2. Else parse `building:levels` tag: $\text{height} = \text{levels} \times 3.3\text{m}$.
    3. Else infer from `building` semantic classification:
       - `apartments`, `commercial`, `office`, `hotel`: $14.0\text{m}$ (4 floors)
       - `residential`, `house`, `detached`: $7.0\text{m}$ (2 floors)
       - `retail`, `supermarket`: $5.5\text{m}$ (1.5 floors)
       - `industrial`, `warehouse`: $8.0\text{m}$
       - `garage`, `shed`, `kiosk`: $3.0\text{m}$ (1 floor)
       - Unclassified `yes`: $8.0\text{m}$ fallback.
  - [x] Parse `min_height` or `building:min_level` for elevated building bases:
    - $Y_{\text{base}} = \text{min\_height}$ or $\text{min\_level} \times 3.3\text{m}$.

- [x] **3.2 Roof Polygon Triangulation (Earcut)**
  - [x] Implement/integrate 2D Earcut ear-clipping triangulation algorithm.
  - [x] Support complex footprints with holes (multipolygon relations with `outer` and `inner` rings):
    - Connect inner hole rings to outer boundary via zero-width bridge collinear seams before ear-clipping.
  - [x] Generate roof mesh surface:
    - Vertices at $Y = \text{height}$.
    - Normals facing strictly vertical: $(0, 1, 0)$.
    - Planar world-space UV coordinates $(U = X / 10.0, V = Z / 10.0)$ for seamless roof tiling.

- [x] **3.3 Wall Extrusion & Normals**
  - [x] For each perimeter segment $(P_i, P_{i+1})$ along the footprint:
    - Generate a vertical quad (2 triangles) connecting:
      - $V_0 = (P_i.x, Y_{\text{base}}, P_i.z)$
      - $V_1 = (P_{i+1}.x, Y_{\text{base}}, P_{i+1}.z)$
      - $V_2 = (P_{i+1}.x, Y_{\text{roof}}, P_{i+1}.z)$
      - $V_3 = (P_i.x, Y_{\text{roof}}, P_i.z)$
    - Compute horizontal outward-facing face normal perpendicular to $(P_{i+1} - P_i)$ in the XZ plane.
    - Calculate UVs: $U = \text{cumulative segment length}$, $V = \text{elevation}$.

- [x] **3.4 Building Materials & Color Mapping**
  - [x] Check tags `building:colour` / `roof:colour` (support CSS color names and `#RRGGBB` hex).
  - [x] Check `building:material` (`brick`, `concrete`, `glass`, `plaster`, `wood`).
  - [x] Generate distinct materials for roof surfaces vs vertical wall facades.

---

## Phase 4: Road Network, Cross-Sections & Bike Lanes

- [ ] **4.1 Street Width Inference Table**
  - [ ] Implement deterministic width lookup:
    1. Parse explicit `width` or `est_width` tag (meters).
    2. Else if `lanes` tag exists:
       - Width = $\max(1, \text{lanes}) \times \text{lane\_width}$, where lane width is $3.5\text{m}$ for primary/motorway and $3.0\text{m}$ for residential/tertiary.
    3. Else fallback based on `highway` tag:
       | Highway Tag                       | Default Width  | Default Lanes |
       | :-------------------------------- | :------------- | :------------ |
       | `motorway` / `motorway_link`      | $14.0\text{m}$ | 4             |
       | `trunk` / `trunk_link`            | $10.5\text{m}$ | 3             |
       | `primary` / `primary_link`        | $9.0\text{m}$  | 2             |
       | `secondary`                       | $8.0\text{m}$  | 2             |
       | `tertiary`                        | $7.0\text{m}$  | 2             |
       | `residential` / `unclassified`    | $6.0\text{m}$  | 2             |
       | `living_street`                   | $4.5\text{m}$  | 1             |
       | `service`                         | $4.0\text{m}$  | 1             |
       | `cycleway`                        | $2.5\text{m}$  | 1             |
       | `footway` / `pedestrian` / `path` | $2.0\text{m}$  | 1             |

- [ ] **4.2 Surface Type Classification**
  - [ ] Extract `surface` tag and map to Godot material presets:
    - `asphalt`, `paved`, `tarmac` $\rightarrow$ `RoadAsphaltMaterial` (smooth dark grey)
    - `concrete`, `paving_stones` $\rightarrow$ `RoadConcreteMaterial` (light grey, segmented)
    - `cobblestone`, `sett`, `unpolished_cobblestone` $\rightarrow$ `RoadCobblestoneMaterial` (rough stone normal map)
    - `gravel`, `fine_gravel`, `compacted` $\rightarrow$ `RoadGravelMaterial` (textured gravel)
    - `dirt`, `earth`, `ground`, `unpaved` $\rightarrow$ `RoadDirtMaterial` (brown, matte)
  - [ ] Provide sensible fallbacks when `surface` is absent (`motorway` $\rightarrow$ asphalt, `path` $\rightarrow$ dirt).

- [ ] **4.3 Bike Lane Detection & Geometry Slicing**
  - [ ] Parse bike lane indicators:
    - Dedicated way: `highway == "cycleway"` or `bicycle == "designated"`.
    - Integrated street bike lanes:
      - `cycleway=lane` or `cycleway:both=lane` $\rightarrow$ bike lanes on both sides ($1.5\text{m}$ each).
      - `cycleway:right=lane` $\rightarrow$ right-side bike lane ($1.5\text{m}$).
      - `cycleway:left=lane` $\rightarrow$ left-side bike lane ($1.5\text{m}$).
      - `cycleway=track` $\rightarrow$ separated bike track ($2.0\text{m}$).
  - [ ] Generate compound cross-section geometry:
    - Carriageway ribbon width = $\text{Total Width} - \text{Bike Lane Width(s)}$.
    - Offset bike lane ribbon parallel to the road centerline at the road margin.
    - Assign distinct bike lane material (e.g., green-tinted asphalt with white bicycle stencil markings).

- [ ] **4.4 Road Ribbon Mesh Generation & Miter Clamping**
  - [ ] For each polyline centerline, compute perpendicular normal vectors at each vertex.
  - [ ] Extrude ribbon vertices left and right:
    - $V_{\text{left}} = P - N \cdot (\text{width} / 2)$
    - $V_{\text{right}} = P + N \cdot (\text{width} / 2)$
  - [ ] Clamp miter joins on sharp turns to prevent polygon overlap or long needle spikes (miter limit = $2.0 \times \text{width}$).
  - [ ] Leverage Godot 4's built-in Clipper: `Geometry2D.offset_polyline(points, half_width, JOIN_MITER, END_BUTT)`.

- [ ] **4.5 Vertical Layering, Bridges, and Tunnels**
  - [ ] Parse `layer=*` (range $-5$ to $+5$), `bridge=*`, and `tunnel=*`.
  - [ ] Calculate elevation offset:
        $$Y = \text{base\_elevation} + (\text{layer} \times 4.5\text{m})$$
  - [ ] Prevent ground-level Z-fighting:
    - Base terrain: $Y = 0.00\text{m}$
    - Roads / highways: $Y = 0.05\text{m}$
    - Bike lanes: $Y = 0.07\text{m}$
    - Footpaths / sidewalks: $Y = 0.09\text{m}$
  - [ ] For `bridge=yes`:
    - Elevate road to minimum $Y = 4.5\text{m}$.
    - Generate side safety barriers and vertical support pillars extending to ground $Y = 0$.

---

## Phase 5: Godot 4 Importer & Visualization Pipeline

- [ ] **5.1 Godot Importer Architecture (`addons/osm_importer/`)**
  - [ ] Choose primary pipeline architecture:
    - **In-Engine Importer Tool**: GDScript `@tool` EditorPlugin reading `osm_export.json` directly via `FileAccess` and generating scene nodes.
    - **Optional CLI Mode**: Headless Godot execution (`godot --headless -s osm_importer.gd -- input.json output.tscn`) for automated builds.
  - [ ] Create Godot Editor UI dock:
    - File picker for selecting `osm_export.json`.
    - Generation toggles: "Import Buildings", "Import Streets", "Import Bike Lanes", "Generate Colliders".
    - "Generate 3D City" button.

- [ ] **5.2 Mesh Construction with SurfaceTool & ArrayMesh**
  - [ ] Utilize `SurfaceTool` to assemble indexed triangle meshes:
    - Set vertex positions, normals, tangents, and UVs.
    - Call `index()` and `generate_normals()` where needed.
    - Commit surfaces into `ArrayMesh`.
  - [ ] Construct static physics collisions:
    - Create `ConcavePolygonShape3D` from building wall and roof meshes for vehicle/character navigation.

- [ ] **5.3 Procedural PBR Materials & Shaders**
  - [ ] Create base `StandardMaterial3D` resources:
    - `asphalt_road.tres` (albedo color `#2A2A2A`, roughness `0.85`, subtle noise normal).
    - `bike_lane.tres` (albedo color `#206B42` emerald green or `#9E382B` brick red, roughness `0.75`).
    - `concrete_sidewalk.tres` (albedo color `#7F7F7F`, roughness `0.9`).
    - `building_wall_default.tres` (albedo color `#D0C8B8`, roughness `0.8`).
    - `building_roof_default.tres` (albedo color `#4A4540`, roughness `0.9`).
  - [ ] Support triplanar mapping on building walls to ensure clean window/brick scale regardless of building dimensions.

- [ ] **5.4 Complete Visualization Scene Setup**
  - [ ] Assemble default viewing scene (`res://city_viewer.tscn`):
    - Root `Node3D` ("CityRoot").
    - Child node for roads (`Node3D` "Streets").
    - Child node for buildings (`Node3D` "Buildings").
    - `DirectionalLight3D` with realistic sun angle and shadow mapping enabled.
    - `WorldEnvironment` with physical sky and ambient occlusion (SSAO).
    - Fly-through / Orbit inspection camera with WASD navigation.

---

## Phase 6: Performance Optimization & Batching

- [ ] **6.1 Draw Call Reduction (Material Batching)**
  - [ ] Eliminate 1-node-per-feature bottleneck:
    - Consolidate all asphalt road segments into a single combined `ArrayMesh`.
    - Consolidate all bike lanes into a single combined `ArrayMesh`.
    - Group building walls by material into chunked multi-surface meshes.
  - [ ] Target budget: Reduce draw calls from $>8,000$ to $<25$ for a $2\text{ km} \times 2\text{ km}$ area.

- [ ] **6.2 Spatial Chunking (For Large Areas)**
  - [ ] Partition geometries into a 2D spatial grid (e.g., $500\text{m} \times 500\text{m}$ grid cells).
  - [ ] Enable distance-based Level of Detail (LOD) or visibility culling per chunk for large city scopes.

---

## Phase 7: Edge Cases, Testing & Verification

- [ ] **7.1 Edge Case Handling**
  - [ ] Self-intersecting and unclosed building ways: detect and auto-repair or skip with logged warning.
  - [ ] Cul-de-sacs and dead-end roads: properly cap ribbon ends with half-circle or square end-caps.
  - [ ] Multipolygon relations with disconnected outer rings: parse each outer ring as a separate building footprint.
  - [ ] Roundabouts (`junction=roundabout`): maintain smooth curvature and correct lane widths along circular ways.
  - [ ] Non-numeric values in numeric tags (e.g. `height="12 meters"`, `lanes="two"`, `building:levels="approx 3"`): robust regex sanitizer.

- [ ] **7.2 Verification Suite**
  - [ ] Create test fixtures in `tests/fixtures/`:
    - `simple_grid.json`: basic 4-way intersection, residential streets, simple rectangular buildings.
    - `bike_infrastructure.json`: dedicated cycle tracks, shared bus/bike lanes, painted door-zone lanes.
    - `complex_buildings.json`: donut-shaped building with inner courtyard, high-rise tower with stepped roof.
    - `bridge_overpass.json`: multi-layer highway interchange with bridge layer $+1$ and ground layer $0$.
  - [ ] Automated headless test script:
    - Run Godot headless importer against all fixtures.
    - Verify vertex counts, valid AABB bounding boxes, zero NaN values, and non-empty mesh surfaces.
  - [ ] Visual smoke test in Godot 3D viewport.

---

## Recommended Project Directory Structure

```
osm-to-godot/
├── README.md
├── plan.md
├── web/                           # Phase 1: Web Bounding Box Downloader (Bun + Vite + Vue 3 + MapLibre)
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.ts
│       ├── App.vue
│       ├── components/
│       │   ├── MapView.vue        # MapLibre GL JS map container & bbox selection layer
│       │   ├── SearchBar.vue      # Photon (photon.komoot.io) autocomplete geocoder
│       │   ├── TelemetryPanel.vue # Coordinate, dimension, and area display
│       │   └── ExportControls.vue # Overpass / OSM export triggers & download
│       ├── composables/
│       │   ├── useBBox.ts         # Reactive bounding box state & metric computations
│       │   └── useOverpass.ts     # Overpass QL execution & JSON export packaging
│       └── services/
│           ├── photon.ts          # Photon geocoding API client
│           └── overpass.ts        # Overpass QL query builder & fetch client
├── godot_project/                 # Phase 4 & 5: Godot Engine Project
│   ├── project.godot
│   ├── scenes/
│   │   ├── city_viewer.tscn       # Main visualization scene with lighting & camera
│   │   └── camera_controller.gd   # 3D orbit / flycam script
│   ├── addons/
│   │   └── osm_importer/          # Godot Editor Plugin / Importer
│   │       ├── plugin.cfg
│   │       ├── osm_importer_dock.tscn
│   │       ├── osm_importer_dock.gd
│   │       ├── osm_parser.gd      # JSON & XML parser
│   │       ├── projection.gd      # WGS84 to local metric projection
│   │       ├── building_builder.gd# 3D extrusion, height inference, Earcut
│   │       ├── road_builder.gd    # Ribbon meshes, width inference, bike lanes
│   │       └── earcut.gd          # 2D polygon triangulation
│   └── materials/                 # PBR Materials
│       ├── road_asphalt.tres
│       ├── road_concrete.tres
│       ├── road_cobblestone.tres
│       ├── bike_lane.tres
│       ├── building_wall.tres
│       └── building_roof.tres
└── tests/                         # Phase 7: Test Fixtures & Validation
    ├── fixtures/
    │   ├── simple_intersection.json
    │   ├── complex_building_courtyard.json
    │   └── elevated_bridge.json
    └── test_importer_headless.gd
```
