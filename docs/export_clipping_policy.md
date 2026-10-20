# Export Clipping Policy and Boundary Join Geometry

This document defines the export clipping policy and boundary geometry retention specification for the browser 2D street editor.

---

## 1. Problem: Boundary Edge Distortions

When geographic data is acquired for a user-selected bounding box (`selectedBounds`: `[minLon, minLat, maxLon, maxLat]`), road networks, paths, and building footprints do not stop neatly at the rectangle edges. Instead, real corridors cut across the boundary.

If features are clipped to the bounding box **before** geometry calculations:

1. **Distorted Road Angles:** A curved road or oblique street crossing the boundary loses its adjacent vertices outside the box. Truncating the line at the bounding box changes the end segment's tangent direction and causes incorrect ribbon miter bevels.
2. **Broken Boundary Junctions:** If an at-grade intersection lies on or near the boundary, its incident branches that extend outside the box would be dropped or truncated. Without knowing all incident branch directions, the junction's stubs, corner miter wedges, and setback boundaries cannot be calculated correctly.
3. **Premature Facility Termination:** Sidewalks and cycleways crossing the boundary would be erroneously flagged as terminating at dead-ends instead of continuing through the boundary.

---

## 2. Retention of Context Geometry

To prevent boundary distortion, the editor enforces the following **retention invariant**:

- **Full Acquisition Retention:** All feature geometries returned by OSM or Overture that intersect the selected bounds are retained in `ProjectEnvelope.features` in their complete, unclipped form.
- **Topological Integrity:** All nodes and incident branches required to compute at-grade junctions and facility continuity at or near the boundary are retained in the `JunctionTopologyGraph`.
- **Pre-Clipping Geometry Generation:** All 2D metric ribbon polygons, strip offsets, bounded miters, facility setbacks, and junction boolean unions are generated across the entire retained geometry **before** any clipping is applied.

---

## 3. Export Clipping Policies

At export time (when generating Godot scene payloads or downloading surface GeoJSON), the user-selected clipping policy is applied to the generated surface polygons and feature envelope.

### 3.1 Policy Modes (`ExportClippingMode`)

| Mode                      | Description                                                                                                                                        | Default Use Case                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clip_to_bounds`          | Cuts surface polygons cleanly to the exact `selectedBounds` rectangle using 2D Clipper polygon-boolean intersection. Polygons outside are omitted. | **Default for Godot scene export and surface GeoJSON.** Prevents corridors from extending miles beyond the user's area of interest while preserving clean boundary cross-sections. |
| `buffer_bounds`           | Cuts surface polygons to `selectedBounds` expanded by a configurable metric buffer margin ($M$ meters, e.g. 25 m or 50 m).                         | Useful for rendering a seamless perimeter ground transition without harsh cutoffs immediately adjacent to the viewing area.                                                        |
| `preserve_cross_boundary` | Retains full unclipped surface polygons for any feature that touches or crosses `selectedBounds`. Omits features that are entirely outside.        | Useful when an external engine handles scene extents or when exporting raw corridors for multi-tile stitching.                                                                     |
| `unclipped`               | Exports all features and surfaces in the project without spatial filtering or clipping.                                                            | Full offline backup and debugging.                                                                                                                                                 |

### 3.2 Building Footprint Clipping Options (`BuildingClippingMode`)

| Mode                | Description                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clip_footprint`    | Clips intersecting building footprints to the bounding box polygon via boolean intersection.                                                               |
| `keep_intersecting` | Retains the entire building footprint if any part of it intersects `selectedBounds`. (Default for Godot 3D extrusion to keep watertight building volumes). |
| `centroid_inside`   | Retains the entire building footprint only if its 2D centroid lies inside `selectedBounds`.                                                                |

---

## 4. Implementation and Metadata Contract

Surface clipping is implemented in `web/src/composables/editor/exportClipping.ts`:

1. The bounding box `[minLon, minLat, maxLon, maxLat]` (plus optional `bufferMarginMeters`) is projected to local metric coordinates relative to `projectionOrigin`.
2. Clipper's `intersectPolygons` performs robust integer-scaled boolean intersection between metric surface polygon rings and the boundary box polygon.
3. Linear features crossing the boundary are clipped against the boundary rectangle edges.
4. Exported surfaces and envelopes include explicit clipping metadata:
   - `clippingPolicy`: Active policy configuration.
   - `isClipped`: Boolean flag on each clipped surface.
   - `boundaryRelation`: `'inside' | 'cross_boundary' | 'outside'`.
   - `clippingStats`: Total, retained, clipped, and omitted surface/feature counts.
