# Standalone Desktop Tool & Distribution Guide

This document outlines the architecture, capabilities, and distribution strategy for packaging **OSM-to-Godot** as a standalone, turnkey desktop application for general users.

---

## 1. Vision: A Reusable 3D Street Explorer

Instead of requiring users to install the Godot game engine or understand game development tooling, the application can be distributed as a self-contained desktop program for anyone interested in exploring real-world urban environments:

- **Any Street or City Worldwide:** Users search for any location (via the Photon geocoder) or pan the map to any neighborhood, university campus, downtown core, or rural roadway.
- **Interactive Bounding Box Selection:** Users drag a bounding box over their streets of interest.
- **One-Click Real-Time Generation:** Clicking **⚡ Send to Godot** queries the Overpass API, streams the OpenStreetMap data into the engine, computes local metric tangent-plane projections, extrudes 3D buildings with accurate heights and roof profiles, generates multi-lane road and bike lane ribbons, and renders the 3D scene in real time.
- **Free-Flight 3D Navigation:** Users inspect the area using standard WASD and mouse flycam navigation, examining road widths, cycling infrastructure, shadow paths, and building massing.

---

## 2. What Does It Mean to "Bundle Godot"?

When exporting a Godot project as a standalone desktop binary, **the entire Godot engine runtime is packaged directly into the executable**.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Standalone Application Package (.exe, .app bundle, or Linux ELF)             │
│                                                                              │
│  ┌───────────────────────────────┐  ┌──────────────────────────────────────┐ │
│  │ Godot Engine Runtime Binary   │  │ Embedded Resource Package (.pck)     │ │
│  │ • Vulkan / 3D Render Pipeline │  │ • Main Viewer Scene (city_viewer)    │ │
│  │ • GDScript Virtual Machine    │  │ • Procedural Mesh & Projection Code  │ │
│  │ • Windowing, Input & Display  │  │ • PBR Materials, Shaders & Sky       │ │
│  │ • Multi-Threaded TCP Server   │  │ • Pre-built Web UI (web_dist/*)      │ │
│  └───────────────────────────────┘  └──────────────────────────────────────┘ │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Listens on 127.0.0.1:8080
                                       ▼
                     Local Web Browser (Chrome, Safari, Firefox)
                     MapLibre GL Interactive Bounding Box UI
```

### What this means for end users:

- **No Engine Installation:** End users do **not** need Godot, Bun, Node.js, Python, or terminal access.
- **Standard Native App:** Distributed as a standard `.zip` or `.dmg` with a single clickable executable.
- **Zero Configuration:** Double-clicking the application icon launches the 3D window and initializes the local bridge automatically.

---

## 3. The Hybrid Web + Desktop Architecture

The application uses a coordinated hybrid design:

1. **Embedded HTTP Server (`http_server.gd`):** When the desktop application starts, it spins up a lightweight `TCPServer` listening on `127.0.0.1:8080`.
2. **Bundled Static Web Assets (`web_dist/`):** The server serves the pre-compiled MapLibre GL frontend directly from inside the Godot virtual filesystem (`res://addons/osm_importer/web_dist/`).
3. **Automatic Browser Launch:** The desktop app calls `OS.shell_open("http://127.0.0.1:8080")` on startup, opening the user's default web browser.
4. **Direct Local Bridge (`/api/import`):** When the user clicks **⚡ Send to Godot** in the browser, the web app POSTs the OSM payload directly to the local server.
5. **Immediate Procedural Synthesis:** Godot receives the payload, clears previous geometry, procedurally builds the road networks and building meshes via `OSMSceneBuilder`, and positions the camera at the center of the imported area.

---

## 4. Transitioning from EditorPlugin to Standalone Tool

In the initial implementation, `osm_importer.gd` is structured as an `EditorPlugin` (which only activates within the Godot Editor). To enable standalone execution, follow these three steps:

### Step 1: Add a Runtime Controller to `city_viewer.tscn`

Attach a script (e.g., `city_viewer.gd`) to the root `CityRoot` node in `city_viewer.tscn` to drive the server outside the editor:

```gdscript
extends Node3D

const OSMHttpServerClass = preload("res://addons/osm_importer/http_server.gd")
const OSMSceneBuilderClass = preload("res://addons/osm_importer/scene_builder.gd")

var http_server: OSMHttpServer
@onready var streets_container: Node3D = $Streets
@onready var buildings_container: Node3D = $Buildings
@onready var camera: Camera3D = $Camera3D

func _ready() -> void:
    # 1. Start local HTTP server
    http_server = OSMHttpServerClass.new(8080)
    http_server.import_received.connect(_on_import_received)
    var err = http_server.start(8080)
    if err == OK:
        print("[OSM Tool] Server listening at: ", http_server.get_url())
        # 2. Automatically open user's default browser to the web selector
        OS.shell_open(http_server.get_url())
    else:
        push_error("[OSM Tool] Failed to bind port 8080: " + str(err))

func _process(_delta: float) -> void:
    if http_server:
        http_server.poll()

func _exit_tree() -> void:
    if http_server:
        http_server.stop()
        http_server = null

func _on_import_received(parsed_data: Dictionary, _raw_payload: Dictionary) -> void:
    print("[OSM Tool] Generating 3D city from OSM import...")

    # Clear existing geometry
    for child in buildings_container.get_children():
        child.queue_free()
    for child in streets_container.get_children():
        child.queue_free()

    # Build new procedural buildings and roads
    var buildings = parsed_data.get("buildings", [])
    var roads = parsed_data.get("roads", [])

    OSMSceneBuilderClass.populate_city_node(self, buildings, roads)
```

### Step 2: Configure Main Scene in `project.godot`

Set `city_viewer.tscn` as the startup scene:

```ini
[application]

config/name="OSM 3D City Explorer"
run/main_scene="res://city_viewer.tscn"
```

### Step 3: Configure Godot Export Filters

Because Godot's export pipeline only includes known resource types (`.tscn`, `.tres`, `.gd`, `.png`) by default, the web distribution files must be explicitly included.

In Godot Editor:

1. Open **Project → Export...**
2. In your Export Preset (Windows / macOS / Linux), navigate to the **Resources** tab.
3. In **Filters to export non-resource files/folders**, add:
   ```text
   addons/osm_importer/web_dist/*, *.html, *.js, *.css, *.mjs, *.svg
   ```
4. This ensures `index.html`, JavaScript bundles, and MapLibre web workers are packed into the exported `.pck` file so `http_server.gd` can serve them at runtime.

---

## 5. Exporting and Distributing

### Building Binaries

Using the Godot CLI with export templates installed:

```bash
# Ensure frontend assets are compiled into web_dist/
mise run build-web

# Windows Desktop Export
godot --headless --path godot_project --export-release "Windows Desktop" builds/windows/OSMCityExplorer.exe

# macOS Application Bundle
godot --headless --path godot_project --export-release "macOS" builds/macos/OSMCityExplorer.dmg

# Linux X11 / Wayland Binary
godot --headless --path godot_project --export-release "Linux/X11" builds/linux/OSMCityExplorer.x86_64
```

### Release Packaging

- **GitHub Releases:** Attach zip archives of each export build (`OSMCityExplorer-macOS-v1.0.0.zip`, `OSMCityExplorer-Windows-v1.0.0.zip`).
- **Self-Contained Portability:** The resulting application folder requires no external libraries or runtime dependencies on the target system.
