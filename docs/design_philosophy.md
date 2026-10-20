# Design Philosophy: 2D Design Tool to 3D Simulation

OSM-to-Godot transforms real-world geographic data into navigable, interactive 3D virtual environments. This document articulates the system's foundational data lifecycle and architectural principles.

---

## 1. Real-World Ingestion as a Design Seed

Importing data from OpenStreetMap (OSM) or Overture Maps is an **initialization step**, not a live synchronization binding.

- Real-world map data serves as a **spatial seed**—providing realistic street layout, building footprints, and corridor topology.
- Once imported into the 2D editor, the data transitions from an external geographic record to an internal design project (`ProjectEnvelope`).

---

## 2. Intentional Simplification & Detail Reduction

Cartographic and surveyed geographic data is noisy, micro-tagged, and inconsistent. **It is completely acceptable—and intended—to simplify geometries and discard details during ingestion and editing.**

- **Geometric Simplification:** Overly dense vertex chains, collinear nodes, micro-jitters, and erratic survey artifacts can and should be simplified or smoothed for clean corridor extrusion and robust polygon triangulation.
- **Tag & Attribute Pruning:** Thousands of incidental OSM tags (historical keys, surveyor notes, mapper metadata, obscure classifications) are stripped. Only attributes relevant to physical dimensions, classification, surface materials, and semantic identity (e.g. names/POIs) are retained.
- **Cross-Section Normalization:** Complex, fragmented real-world roadway lane configurations are parsed into coherent, normalized corridor profiles (e.g., standard vehicular lanes, parking, sidewalks, bike ribbons).
- **No Obligation to Preserve Quirks:** If raw map data has overlapping redundant polygons or micro-gaps, the ingestion pipeline prioritizes topological sanity and clean geometry generation over preserving raw surveyor idiosyncrasies.

---

## 3. The 2D Editor is a Design and Authoring Tool

The 2D web interface is not a passive map viewer or a read-only previewer—it is an **active design environment**.

- **Active Urban Redesign:** Users use the 2D canvas to author changes: reallocating street right-of-way (e.g., swapping a parking lane for a protected bike lane or sidewalk widening), modifying corridor profiles, reshaping intersections, or altering building attributes.
- **Rapid Iteration in 2D:** 2D geometric editing is fast, intuitive, and topologically tractable compared to editing raw 3D meshes or CSG solids directly.
- **Source of Truth for the Scene:** The edited 2D representation (`ProjectEnvelope` / surface definitions) is the primary specification for the generated urban space.

---

## 4. Unidirectional Compilation to 3D Simulation

The pipeline flows forward from 2D design to 3D simulation:

```
Real-World Data (OSM / Overture)
              │
              ▼  (Lossy ingestion & normalization)
       2D Design Tool
 (Authoring, lane reallocation, corridor geometry)
              │
              ▼  (Procedural compilation & extrusion)
       3D Simulation Scene (Godot)
  (Traversable physics, collision, lighting, PBR)
```

- **Compiled Artifacts:** The 3D scene in Godot is a compiled runtime target. Extruded building volumes, road ribbons, mitered curbs, static trimesh colliders, and player spawn points are generated procedurally from the 2D design.
- **Simulation Focus:** The target is interactive evaluation—walking down streets, testing sightlines, assessing corridor widths, evaluating pedestrian and cyclist comfort, and exploring urban design scenarios in real time.

---

## 5. No Backwards Compatibility with Raw OSM

The project **does not maintain backwards compatibility or round-trip fidelity with original OSM data**.

- **No Upstream Changeset Generation:** There is no goal to export changes back into OSM XML/Overpass changesets or maintain OSM node/way/relation ID continuity across edits.
- **Decoupled Internal Schema:** Once ingested, entities are native design primitives (corridors, lane ribbons, building footprints, POI markers) tailored for procedural generation and simulation, completely freed from upstream OSM schema constraints.
- **Freedom to Innovate:** The internal data model can evolve to best serve design workflows and 3D simulation fidelity without being constrained by OpenStreetMap tagging standards or historical conventions.
