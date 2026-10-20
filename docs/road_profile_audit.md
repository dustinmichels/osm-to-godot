# Road Profiles and Width/Bike-Lane Rules Audit

This document audits the existing Godot implementation (`road_builder.gd`, `geojson_parser.gd`) against the requirements for the browser 2D editor and width-aware surface generation.

---

## 1. Existing Godot Implementation (`road_builder.gd`)

### 1.1 Highway Class Defaults (`HIGHWAY_DEFAULTS`)

Godot defines default corridor widths and lane counts by highway class:

- `motorway` / `motorway_link`: 14.0 m, 4 lanes (3.5 m/lane)
- `trunk` / `trunk_link`: 10.5 m, 3 lanes (3.5 m/lane)
- `primary` / `primary_link`: 9.0 m, 2 lanes (4.5 m/lane default; 3.5 m/lane when `lanes` tag present)
- `secondary` / `secondary_link`: 8.0 m, 2 lanes (4.0 m/lane default; 3.0 m/lane when `lanes` tag present)
- `tertiary` / `tertiary_link`: 7.0 m, 2 lanes (3.5 m/lane default; 3.0 m/lane when `lanes` tag present)
- `residential` / `unclassified`: 6.0 m, 2 lanes (3.0 m/lane)
- `living_street`: 4.5 m, 1 lane
- `service`: 4.0 m, 1 lane
- `cycleway`: 2.5 m, 1 lane
- `footway` / `pedestrian` / `path`: 2.0 m, 1 lane
- `track`: 3.0 m, 1 lane
- `steps`: 1.8 m, 1 lane
- Generic fallback (`DEFAULT_ROAD_WIDTH`, `DEFAULT_ROAD_LANES`): 6.0 m, 2 lanes

### 1.2 Width Resolution Precedence in Godot

1. **Explicit Width**: `width` or `est_width` tag parsed via regex. If > 0, width is set to explicit value. Lanes default to `lanes` tag or fallback class lanes.
2. **Lane Count**: If `lanes` tag is present:
   - Roundabout (`junction=roundabout`): lane width = 4.5 m.
   - Motorway / trunk / primary (and links): lane width = 3.5 m.
   - All other highways: lane width = 3.0 m.
   - Width = `lanes * lane_width`.
3. **Roundabout Fallback**: If `junction=roundabout` without explicit width/lanes: `fallback_lanes * 4.5 m`.
4. **Highway Class Default**: Fallback width from `HIGHWAY_DEFAULTS`.

### 1.3 Bike-Lane Resolution in Godot

- **Dedicated facilities**: `highway=cycleway` or `bicycle=designated`. Treated as single dedicated bike ribbon with `total_width`.
- **On-road facilities**:
  - `cycleway=track` or `cycleway:both=track`: left = 2.0 m, right = 2.0 m.
  - `cycleway=lane` or `cycleway:both=lane`: left = 1.5 m, right = 1.5 m.
  - `cycleway:right=track`: right = 2.0 m; `lane`: right = 1.5 m.
  - `cycleway:left=track`: left = 2.0 m; `lane`: left = 1.5 m.
- **Carriageway deduction**: In Godot, on-road bike lanes are carved _out_ of total width:
  `carriageway_width = max(2.0, total_width - total_bike_width)`.
  The carriageway center is offset if bike lanes are asymmetric.

---

## 2. Gaps and Differences in the Godot Implementation

1. **User Overrides**: Godot does not support interactive user overrides (manual width, strip customization, per-side facility override).
2. **Sidewalks**: Godot does not model attached sidewalks (`sidewalk`, `sidewalk:both`, `sidewalk:left`, `sidewalk:right`). Only standalone footway lines are extruded.
3. **Carriageway vs Corridor Width Semantics**:
   - Godot interprets explicit `width` as the total roadway width (including on-road bike lanes, carving them out).
   - Browser previously added bike lanes _outside_ carriageway width (`carriagewayWidth + sum(bike) + sum(sidewalk)`), creating a double-counting risk if explicit width already represented curb-to-curb carriageway including bike lanes.
4. **Asymmetric Profiles & Centerline Offsets**: Godot shifts the carriageway center when left and right bike widths differ, but anchors the whole cross-section relative to the outer bounding box rather than maintaining the reference line as the physical centerline or marking offset.
5. **Driving Side & Directionality**: Godot has no knowledge of left-hand vs right-hand driving rules, one-way directional lane distribution (`lanes:forward`, `lanes:backward`), or cycleway contraflow (`opposite_lane`, `cycleway:left:oneway`).
6. **Medians and Buffers**: Godot does not support painted buffers, physical barriers, or center turn lanes/medians.
7. **Ambiguity and Provenance Flagging**: Godot silently resolves conflicting or unsupported tags without alerting the user or flagging geometry accuracy limitations.

---

## 3. Browser Requirements and Target Equivalents

| Aspect                       | Godot Behavior                                      | Browser 2D Target Behavior                                                                                                                                                                                                                              |
| :--------------------------- | :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Resolution Precedence**    | Explicit width → Lanes → Roundabout → Class default | 1. User override → 2. Usable explicit source measurement → 3. Source-supported lane/profile interpretation → 4. Documented class default                                                                                                                |
| **Explicit Width Semantics** | Slices bike lanes from total width                  | Explicit `width` includes carriageway + on-road painted bike lanes. Separated tracks (`track`) and sidewalks (`sidewalk`) lie outside curb-to-curb carriageway unless specified by explicit corridor width tags. Never double-count on-road bike lanes. |
| **Sidewalks**                | None on roads (standalone only)                     | Modeled from source tags (`sidewalk:left/right/both`), width 1.8 m default. Standalone footways preserved. NEVER infer sidewalks solely because a road exists unless an explicit inference policy is active.                                            |
| **Bike Lanes**               | Slices 1.5 m (lane) or 2.0 m (track)                | Slices on-road lanes (1.5 m) from curb-to-curb width; places separated tracks (2.0 m) with optional buffer outside curb. Supports left/right asymmetry and contraflow.                                                                                  |
| **Driving Side**             | Ignored                                             | Aware of driving side (RHT default, LHT in LHT jurisdictions/tags). Dictates forward/backward strip alignment.                                                                                                                                          |
| **Medians & Buffers**        | None                                                | Explicit strips for `median`, `buffer` when specified or required by separated facility types.                                                                                                                                                          |
| **Ambiguity & Flags**        | Silent fallback                                     | Visually flagged with warning (`unsupported_profile`, `conflicting_lanes`, `width_too_narrow`) in inspector, overlay, and model warnings.                                                                                                               |
| **Inference Policy**         | Silent assumption                                   | Explicit provenance: `source`, `override`, `inferred`. User toggle for inference; source evidence clearly distinguished from default inference.                                                                                                         |
