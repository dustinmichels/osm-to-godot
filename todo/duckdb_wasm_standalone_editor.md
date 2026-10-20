# DuckDB-WASM & Standalone 2D Editor

Actionable plan to evolve the web tool into a standalone, browser-native 2D Urban Geometry Studio using client-side DuckDB-WASM for Overture Maps GeoParquet ingestion, with Godot 4 as an optional downstream consumer.

---

## Phase 1: Standalone UI & Decoupled State Management

- [x] **1.1 Decouple ingestion UI & remove CLI command file fallback**
  - [x] In `web/src/composables/useOverture.ts`, remove `createOvertureCommandFile`, `downloadOvertureCommandFile`, and `isOvertureCommandFile`.
  - [x] In `web/src/components/ExportControls.vue`, remove CLI fetch command download handlers, warnings, and file drop checks.
  - [x] Update `ExportControls.vue` button states so offline Godot does not disable actions or prompt for terminal scripts.
  - [x] Add direct source actions in `ExportControls.vue`: "Acquire Overture (DuckDB)", "Acquire OSM (Overpass)", and local GeoJSON / project drop.
- [x] **1.2 Rebrand UI surface & decouple Godot connection status**
  - [x] Update app header/title to standalone identity: **City & Street 2D Studio** (_Interactive Urban Geometry Editor_).
  - [x] In toolbar/header, replace disruptive offline modals/banners with a non-blocking connection chip: `● Godot :8080 (Linked)` vs `○ Godot (Offline)`.
- [x] **1.3 Refactor Editor Toolbar & export hierarchy**
  - [x] In `web/src/components/EditorToolbar.vue`, promote **Save Project** (`project_<timestamp>.json`, `ProjectEnvelope` v1.0.0) and **Export Scene** (`scene_<timestamp>.geojson`, derived surfaces) to primary actions.
  - [x] Make **⚡ Send to Godot 3D** an export target enabled conditionally when the Godot bridge detects an active listener on `127.0.0.1:8080` (disabled with tooltip when offline).
  - [x] Add **Open File** action to open existing scenario or raw GIS GeoJSON directly in the editor.
- [x] **1.4 Regress existing web tests**
  - [x] Run `mise run test-web` and verify all existing web tests pass or update test assertions for decoupled defaults.

---

## Phase 2: DuckDB-WASM Infrastructure in `web/`

- [x] **2.1 Package dependencies & Vite configuration**
  - [x] Add `@duckdb/duckdb-wasm` and `apache-arrow` to `web/package.json`.
  - [x] Configure `web/vite.config.ts` for WebAssembly asset loading and worker bundling.
  - [x] Configure DuckDB-WASM bundle selection to default to the non-threaded exception-handling bundle (`duckdb-eh.wasm`) to avoid COOP/COEP header requirements on static hosts.
- [x] **2.2 Implement DuckDB Web Worker (`duckdbWorker.ts`)**
  - [x] Create `web/src/services/duckdb/duckdbWorker.ts` to instantiate DuckDB-WASM inside a dedicated Web Worker.
  - [x] Initialize and load the `spatial` extension (`INSTALL spatial; LOAD spatial;`).
  - [x] Configure anonymous HTTPFS for S3 endpoint access (`https://overturemaps-us-west-2.s3.amazonaws.com/release/`).
  - [x] Stream Arrow `RecordBatch` results and project directly into lightweight GeoJSON feature structures.
- [x] **2.3 Implement worker RPC bridge (`duckdbWorkerBridge.ts`)**
  - [x] Create `web/src/services/duckdb/duckdbWorkerBridge.ts` providing Promise-based typed RPC calls (`queryOvertureBBox(bbox, options)`).
  - [x] Handle worker lifecycle, termination, cancellation, and error forwarding.
- [x] **2.4 Implement parameterized query templates (`queries.ts`)**
  - [x] Create `web/src/services/duckdb/queries.ts` with parameterized SQL for:
    - [x] `theme=buildings/type=building/*` (bounding box pushdown, height, num_floors, level, class, names, source_dataset).
    - [x] `theme=transportation/type=segment/*` (bounding box pushdown, subtype, class, subclass, names, level, access_restrictions, speed_limits).
    - [x] `theme=places/type=place/*` (bounding box pushdown, names, categories, brand).
    - [x] `theme=addresses/type=address/*` (bounding box pushdown, street, house number).
  - [x] Add bounding box coordinate validation and safety limits (warn/reject bounding boxes > 5.0 km²).

---

## Phase 3: Client-Side Overture Acquisition Composable

- [x] **3.1 Implement `useOvertureWasm.ts` composable**
  - [x] Create `web/src/composables/useOvertureWasm.ts` with reactive state: `isLoading`, `error`, `progress` (phases: `init` → `querying` → `processing` → `ready`), `featureCounts`.
  - [x] Implement theme error tolerance: allow partial results (e.g. roads + buildings succeed if places query returns empty).
  - [x] Stream normalized features into `normalizeOverturePayload` via `editorWorkerBridge.ts`.
- [x] **3.2 Wire acquisition into UI & model**
  - [x] Connect `ExportControls.vue` "Acquire Overture (DuckDB)" to `useOvertureWasm`.
  - [x] On completion, load normalized `ProjectEnvelope` into `useEditorModel` and transition automatically to the `editor` workspace.
  - [x] Retain bundled offline presets (e.g. `medford-y`) for zero-network testing.
- [x] **3.3 Unit tests for DuckDB queries & acquisition state**
  - [x] Add unit tests in `web/src/composables/useOvertureWasm.test.ts` covering progress transitions, parameter validation, and error states.

---

## Phase 4: Spatial Enrichment & Offline Caching

- [x] **4.1 Worker-side spatial enrichment**
  - [x] Implement point-in-polygon matching between POIs (`places`), addresses, and building footprints inside the DuckDB worker.
  - [x] Populate building names, categories, and street addresses directly in memory to match legacy `scripts/fetch_overture.py` parity.
- [x] **4.2 IndexedDB spatial query cache (`cache.ts`)**
  - [x] Create `web/src/services/duckdb/cache.ts` using IndexedDB.
  - [x] Cache acquired feature payloads keyed by quantized bounding box (`[lat.toFixed(3), lon.toFixed(3)]`) and Overture release tag.
  - [x] Add cache hit detection to bypass S3 range requests when revisiting bounding boxes.

---

## Phase 5: Deprecation of Host Toolchain & Standalone Verification

- [x] **5.1 Godot HTTP server cleanup**
  - [x] In `godot_project/addons/osm_importer/http_server.gd`, delete `OS.execute("python3", ...)` and the `fetch_overture.py` execution branch.
  - [x] Ensure Godot server functions purely as an optional scene receiver: `POST /api/import` and `GET /api/status`.
- [x] **5.2 Deprecate legacy fetch scripts & update documentation**
  - [x] Mark `scripts/fetch_overture.py` and `mise.toml` `fetch-overture` task as legacy/deprecated.
  - [x] Update README and architecture documentation to reflect the standalone, zero-prerequisite browser workflow.
- [x] **5.3 End-to-end verification**
  - [x] Run `mise run test-web` and `mise run test` to verify engine and web suites pass.
  - [x] Smoke test standalone workflow: launch `web` (`bun run dev`) without Godot, select bounding box, acquire Overture data via DuckDB-WASM over HTTPS.
  - [x] Verify 2D editing in plan view (cross-sections, lane layouts, heights), save Project JSON, and export Scene GeoJSON.
  - [x] Launch Godot, verify bridge connection detection, and stream scene via `POST /api/import`.
