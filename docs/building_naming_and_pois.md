# Building Naming & POI Integration

This document outlines the architecture, data pipeline, spatial matching algorithms, and fallback resolution rules used to name 3D building models and represent Points of Interest (POIs) in **OSM-to-Godot**.

---

## 1. Background & Problem Statement

In OpenStreetMap (OSM), buildings are frequently mapped with varying levels of detail:

- **Commercial & Public Buildings:** May have a direct `name` tag on the building way or relation (e.g. `name="Dunkin'"`).
- **Mixed-Use & Multi-Tenant Structures:** Businesses, clinics, restaurants, and retail shops are often mapped as standalone `node` elements positioned _inside_ the building boundary, rather than on the building footprint itself.
- **Addressed Properties:** In many regions (e.g. MassGIS imports), residential and small commercial buildings carry street addresses (`addr:housenumber` + `addr:street`) but no human-readable building name.
- **Ancillary Structures:** Secondary structures (garages, sheds, generic footprints) often have only functional tags (`building=garage`) or generic `building=yes` without addresses or names.

A naive importer querying only `way["building"]` and looking only for `tags.name` results in an overwhelming majority of structures named generically (e.g. `Building_29518082`). This system addresses this by:

1. Fetching POI nodes in the export query.
2. Spatially assigning POI nodes to the enclosing building footprints using 2D polygon containment.
3. Applying a deterministic, multi-tier fallback ladder to resolve the best possible display and node name.
4. Creating inspectable 3D POI markers and rich node metadata.

---

## 2. End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Data Ingestion (web/src/services/overpass.ts)                            │
│                                                                             │
│ • Overpass QL Query:                                                        │
│     way["highway"](bbox);                                                  │
│     way["building"](bbox);                                                 │
│     relation["building"](bbox);                                            │
│     node["amenity"|"shop"|"tourism"|"leisure"|"office"|...](bbox);         │
│ • Fallback Parser: Extracts both way vertices and standalone tagged POI     │
│   nodes from OSM 0.6 XML.                                                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ JSON Export Payload
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Parsing & Spatial Containment (addons/osm_importer/osm_parser.gd)        │
│                                                                             │
│ • Project coordinates via WGS84 local tangent plane: (lat, lon) -> Vector3  │
│ • Pre-index POI nodes: position, name, and raw tags                         │
│ • Point-in-Polygon containment: test each POI against building outer rings  │
│   and inner courtyard holes using Geometry2D.is_point_in_polygon            │
│ • Attach matching POIs to building dictionaries: building.pois = [poi, ...] │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Parsed Data Dictionary
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Name Resolution Ladder (addons/osm_importer/building_builder.gd)         │
│                                                                             │
│ Priority:                                                                   │
│  [1] Building name / name:en tag                                            │
│  [2] addr:housename                                                         │
│  [3] brand tag                                                              │
│  [4] Enclosed POI name (from spatial match)                                 │
│  [5] Street address (addr:housenumber + addr:street)                        │
│  [6] Specialized building function (e.g. Garage, Fire Station)              │
│  [7] Fallback: Building_<id>                                                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Node Generation
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Scene Construction (addons/osm_importer/scene_builder.gd)                │
│                                                                             │
│ • Node name sanitized for Godot paths (. : @ / " %)                         │
│ • Node metadata attached: osm_id, osm_name, osm_address, osm_pois, osm_tags │
│ • Disambiguated duplicate sibling names via add_child(node, true)           │
│ • Dedicated POIs group populated with Marker3D nodes for all POIs           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Ingestion & POI Tag Filtering

The export query in `web/src/services/overpass.ts` requests both linear infrastructure, building geometries, and point-of-interest nodes:

### Overpass QL Query Union

```overpass
[out:json][timeout:30];
(
  way["highway"]({{bbox}});
  way["building"]({{bbox}});
  relation["building"]({{bbox}});
  node["amenity"]({{bbox}});
  node["shop"]({{bbox}});
  node["tourism"]({{bbox}});
  node["leisure"]({{bbox}});
  node["office"]({{bbox}});
  node["historic"]({{bbox}});
  node["healthcare"]({{bbox}});
  node["craft"]({{bbox}});
);
out body geom;
```

### Tag Classification (`isPoiTags`)

When parsing raw XML responses (or filtering node streams), a node is classified as a POI if it contains any of the primary category keys or has an explicit `name` that is not a road or building:

- `amenity` (restaurants, cafes, fire stations, police stations, clinics)
- `shop` (supermarkets, convenience stores, bakeries)
- `tourism` (hotels, museums, viewpoints)
- `leisure` (parks, sports centers, playgrounds)
- `office` (corporate offices, legal services, government offices)
- `historic` (monuments, memorials, historic sites)
- `healthcare` (hospitals, pharmacies, dentists)
- `craft` (workshops, craftspeople)
- Standalone `name` without `highway` or `building` tags

---

## 4. Geometric Containment & Spatial Matching

In `addons/osm_importer/osm_parser.gd`, POI nodes are associated with building footprints using 2D point-in-polygon containment on the local horizontal plane $(X, Z)$:

1. **Local Projection:** Each POI node coordinate is projected to local engine coordinates:
   $$\vec{P} = \text{OSMProjection.project}(\text{lat}, \text{lon})$$
2. **Exterior Ring Test:** The point $(P_x, P_z)$ is tested against every exterior loop in `building.outer_rings` using Godot's `Geometry2D.is_point_in_polygon`.
3. **Interior Hole Test:** If the point is inside an exterior ring, it is tested against all courtyard or lightwell holes in `building.inner_rings`. If it falls inside an interior hole, it is excluded (it is in an open courtyard, not inside the building envelope).
4. **Association:** Points passing both tests are appended to the building's `pois` array:
   ```gdscript
   building["pois"].append(poi)
   ```

---

## 5. Building Name Resolution Ladder

When creating a building mesh node (`create_building_node` or `create_csg_building_node`), `BuildingBuilder.get_building_display_name(building)` evaluates tags in order of specificity:

|  Tier  | Source                    | Priority Condition                                           | Example Output                                |
| :----: | :------------------------ | :----------------------------------------------------------- | :-------------------------------------------- |
| **1**  | Direct `name` / `name:en` | Explicit building name tag                                   | `"Dunkin'"`                                   |
| **2**  | `addr:housename`          | House or estate name                                         | `"Rose Cottage"`                              |
| **3**  | `brand`                   | Brand or corporate identity                                  | `"Target"`                                    |
| **4**  | Enclosed POI              | First named POI spatially inside footprint                   | `"Medford Police Department"`, `"7-Eleven"`   |
| **5a** | Full Street Address       | Both `addr:housenumber` and `addr:street` present            | `"9 Emerson Street"`, `"100;120 Main Street"` |
| **5b** | Street Only               | Only `addr:street` present                                   | `"Main Street"`                               |
| **5c** | House Number Only         | Only `addr:housenumber` present                              | `"No. 154"`                                   |
| **6**  | Specialized Type          | Non-generic `building` tag (not `yes`, `no`, `roof`, `true`) | `"Garage"`, `"Industrial"`                    |
| **7**  | Fallback                  | No name, address, or specialized type                        | `"Building_29535893"`                         |

---

## 6. Node Sanitization & Hierarchy Disambiguation

Godot node names must not contain special node-path delimiters. In `building_builder.gd`:

1. **Character Sanitization (`sanitize_node_name`):**
   Replaces invalid path characters with underscores:
   - `.` $\to$ `_`
   - `:` $\to$ `_`
   - `@` $\to$ `_`
   - `/` $\to$ `_`
   - `"` $\to$ `_`
   - `%` $\to$ `_`
     For example, `Volsar, Inc.` becomes `Volsar, Inc_`.
2. **Duplicate Disambiguation:**
   Multiple buildings or garages sharing the same name (e.g. multiple `Garage` outbuildings) are added using `root.add_child(node, true)`. Godot's built-in `force_readable_name` ensures duplicates are sequentially numbered (e.g. `Garage`, `Garage2`, `Garage3`) rather than generating `@Node@...` internal handles.

---

## 7. Node Metadata

Every building node receives inspectable runtime metadata accessible via `node.get_meta(...)`:

- `osm_id` (`float`/`int`): The OSM element ID.
- `osm_name` (`String`): The resolved human-readable display name.
- `osm_address` (`String`, optional): Formatted street address (if available).
- `osm_pois` (`Array[Dictionary]`, optional): Array of all enclosed POI objects (including name, type, and tags).
- `osm_tags` (`Dictionary`): The complete dictionary of raw OSM tags for runtime raycasting, tooltips, or gameplay scripts.

---

## 8. Standalone POIs in the 3D Scene

In addition to transferring names to buildings, all POIs (including outdoor amenities, viewpoints, and monuments) are instantiated in the scene under a dedicated `POIs` node (`addons/osm_importer/scene_builder.gd`):

- **Node Type:** `Marker3D` (lightweight, zero-draw-call, visible in editor 3D viewports).
- **Position:** Placed at the projected ground-level coordinate $(X, 0, Z)$.
- **Metadata:** Carries `osm_id`, `osm_name`, and `osm_tags` for selection and UI overlays.

---

## 9. Case Study: Medford-Y (Medford Square)

In the Medford-Y reference dataset (47 buildings):

| Category                 | Count | Before Implementation                                                                                                                                                       | After Implementation                                                                                                                                                                |
| :----------------------- | :---: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Direct OSM Names**     |   1   | `Dunkin'`                                                                                                                                                                   | `Dunkin'`                                                                                                                                                                           |
| **Names from POIs**      |   8   | `Building_29641367_0`<br>`Building_29788042_0`<br>`Building_29536093_0`<br>`Building_29535923_0`<br>`Building_29518151_0`<br>`Building_29729490_0`<br>`Building_29825177_0` | `Medford Police Department`<br>`7-Eleven`<br>`Circle K`<br>`Medford Main Street Dental`<br>`Volsar, Inc_`<br>`Miracle-Ear`<br>`Mass General Brigham Community Physicians - Medford` |
| **Names from Addresses** |  18   | `Building_29518082_0`<br>`Building_29518172_0`<br>`...`                                                                                                                     | `9 Emerson Street`<br>`20 Thomas Street`<br>`13;15 Emerson Street`<br>`14 Emerson Street`<br>`151 Main Street`<br>`153 Main Street`<br>`...`                                        |
| **Specialized Types**    |   2   | `Building_29518181_0`<br>`Building_29935405_0`                                                                                                                              | `Garage`<br>`Garage2`                                                                                                                                                               |
| **Generic Fallback**     |  18   | `Building_<id>`                                                                                                                                                             | `Building_<id>` (sheds, unaddressed rear parcels)                                                                                                                                   |
