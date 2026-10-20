class_name RoadBuilder
extends RefCounted

## Procedural road network and cross-section generator for Godot 4.
## Implements width inference, surface classification, bike lane detection/slicing,
## 2D/3D polyline ribbon extrusion with miter clamping, and vertical layering/bridges.

const HIGHWAY_DEFAULTS: Dictionary = {
	"motorway": {"width": 14.0, "lanes": 4},
	"motorway_link": {"width": 14.0, "lanes": 4},
	"trunk": {"width": 10.5, "lanes": 3},
	"trunk_link": {"width": 10.5, "lanes": 3},
	"primary": {"width": 9.0, "lanes": 2},
	"primary_link": {"width": 9.0, "lanes": 2},
	"secondary": {"width": 8.0, "lanes": 2},
	"secondary_link": {"width": 8.0, "lanes": 2},
	"tertiary": {"width": 7.0, "lanes": 2},
	"tertiary_link": {"width": 7.0, "lanes": 2},
	"residential": {"width": 6.0, "lanes": 2},
	"unclassified": {"width": 6.0, "lanes": 2},
	"living_street": {"width": 4.5, "lanes": 1},
	"service": {"width": 4.0, "lanes": 1},
	"cycleway": {"width": 2.5, "lanes": 1},
	"footway": {"width": 2.0, "lanes": 1},
	"pedestrian": {"width": 2.0, "lanes": 1},
	"path": {"width": 2.0, "lanes": 1},
	"track": {"width": 3.0, "lanes": 1},
	"steps": {"width": 1.8, "lanes": 1}
}

const DEFAULT_ROAD_WIDTH: float = 6.0
const DEFAULT_ROAD_LANES: int = 2

# 4.2 Surface Type Classification & Material Presets
const SURFACE_MATERIAL_PRESETS: Dictionary = {
	"asphalt":
	{
		"name": "RoadAsphaltMaterial",
		"color": Color(0.165, 0.165, 0.165),  # #2A2A2A
		"roughness": 0.85,
		"metallic": 0.05,
		"res_path": "res://materials/asphalt_road.tres"
	},
	"concrete":
	{
		"name": "RoadConcreteMaterial",
		"color": Color(0.68, 0.67, 0.65),  # Light grey
		"roughness": 0.70,
		"metallic": 0.0
	},
	"cobblestone":
	{
		"name": "RoadCobblestoneMaterial",
		"color": Color(0.45, 0.43, 0.40),  # Rough stone
		"roughness": 0.95,
		"metallic": 0.0
	},
	"gravel":
	{
		"name": "RoadGravelMaterial",
		"color": Color(0.55, 0.52, 0.48),  # Textured gravel
		"roughness": 0.90,
		"metallic": 0.0
	},
	"dirt":
	{
		"name": "RoadDirtMaterial",
		"color": Color(0.42, 0.32, 0.22),  # Brown, matte
		"roughness": 0.95,
		"metallic": 0.0
	},
	"bike_lane":
	{
		"name": "BikeLaneMaterial",
		"color": Color(0.125, 0.420, 0.259),  # #206B42 Emerald green
		"roughness": 0.75,
		"metallic": 0.05,
		"res_path": "res://materials/bike_lane.tres"
	},
	"footway":
	{
		"name": "FootwayMaterial",
		"color": Color(0.498, 0.498, 0.498),  # #7F7F7F Concrete sidewalk
		"roughness": 0.90,
		"metallic": 0.0,
		"res_path": "res://materials/concrete_sidewalk.tres"
	}
}

const SURFACE_TAG_MAP: Dictionary = {
	"asphalt": "asphalt",
	"paved": "asphalt",
	"tarmac": "asphalt",
	"bitumen": "asphalt",
	"concrete": "concrete",
	"paving_stones": "concrete",
	"sett:concrete": "concrete",
	"concrete:plates": "concrete",
	"cobblestone": "cobblestone",
	"sett": "cobblestone",
	"unpolished_cobblestone": "cobblestone",
	"cobblestone:flattened": "cobblestone",
	"gravel": "gravel",
	"fine_gravel": "gravel",
	"compacted": "gravel",
	"pebblestone": "gravel",
	"crushed_stone": "gravel",
	"dirt": "dirt",
	"earth": "dirt",
	"ground": "dirt",
	"unpaved": "dirt",
	"mud": "dirt",
	"sand": "dirt"
}

static var _material_cache: Dictionary = {}


## Resolve surface type string from tags with sensible highway fallbacks
static func resolve_surface_type(tags: Dictionary) -> String:
	var raw_surface = str(tags.get("surface", "")).strip_edges().to_lower()
	if not raw_surface.is_empty() and SURFACE_TAG_MAP.has(raw_surface):
		return SURFACE_TAG_MAP[raw_surface]

	# Fallback based on highway tag
	var highway = str(tags.get("highway", "")).strip_edges().to_lower()
	if highway in ["path", "track"]:
		return "dirt"
	elif highway in ["footway", "pedestrian"]:
		return "concrete"
	elif highway in ["cycleway"]:
		return "asphalt"
	else:
		# motorway, trunk, primary, secondary, tertiary, residential, service, etc. -> asphalt
		return "asphalt"


## Get or create StandardMaterial3D for a surface preset
static func get_surface_material(surface_type: String) -> StandardMaterial3D:
	if _material_cache.has(surface_type):
		return _material_cache[surface_type]

	var preset = SURFACE_MATERIAL_PRESETS.get(surface_type, SURFACE_MATERIAL_PRESETS["asphalt"])
	var res_path: String = preset.get("res_path", "")
	if not res_path.is_empty() and ResourceLoader.exists(res_path):
		var res_mat = load(res_path) as StandardMaterial3D
		if res_mat != null:
			_material_cache[surface_type] = res_mat
			return res_mat

	var mat = StandardMaterial3D.new()
	mat.resource_name = preset.get("name", "RoadMaterial")
	mat.albedo_color = preset.get("color", Color(0.25, 0.25, 0.25))
	mat.roughness = preset.get("roughness", 0.8)
	mat.metallic = preset.get("metallic", 0.0)
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED

	_material_cache[surface_type] = mat
	return mat


## Robust regex sanitizer for numeric tags (e.g. "12 meters", "two", "approx 3", "10,5")
static func parse_numeric_dimension(val: Variant, default_val: float = 0.0) -> float:
	return BuildingBuilder.parse_numeric_dimension(val, default_val)


## 4.1 Street Width Inference Table
## Returns a dictionary: {"width": float, "lanes": int, "lane_width": float}
static func resolve_road_width(tags: Dictionary) -> Dictionary:
	var highway = str(tags.get("highway", "")).strip_edges().to_lower()

	# Determine default fallback info for this highway type
	var fallback_info = HIGHWAY_DEFAULTS.get(
		highway, {"width": DEFAULT_ROAD_WIDTH, "lanes": DEFAULT_ROAD_LANES}
	)

	# Step 1: Parse explicit width or est_width tag (meters)
	var explicit_width = 0.0
	if tags.has("width"):
		explicit_width = parse_numeric_dimension(tags.get("width"), 0.0)
	elif tags.has("est_width"):
		explicit_width = parse_numeric_dimension(tags.get("est_width"), 0.0)

	if explicit_width > 0.0:
		var lanes_val = 1
		if tags.has("lanes"):
			lanes_val = maxi(1, int(parse_numeric_dimension(tags.get("lanes"), 1.0)))
		else:
			lanes_val = fallback_info.get("lanes", 1)
		return {
			"width": explicit_width,
			"lanes": lanes_val,
			"lane_width": explicit_width / float(lanes_val)
		}

	# Step 2: Else if lanes tag exists:
	# Width = max(1, lanes) * lane_width,
	# where lane_width is 3.5m for primary/motorway/trunk and 3.0m for residential/tertiary/secondary/others.
	if tags.has("lanes"):
		var raw_lanes = parse_numeric_dimension(tags.get("lanes"), 1.0)
		var num_lanes = maxi(1, int(raw_lanes))
		var lane_w = 3.0
		if str(tags.get("junction", "")).strip_edges().to_lower() == "roundabout":
			# Roundabouts require wider circulatory lanes for vehicular turn radius
			lane_w = 4.5
		elif (
			highway
			in ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"]
		):
			lane_w = 3.5
		else:
			lane_w = 3.0
		return {"width": float(num_lanes) * lane_w, "lanes": num_lanes, "lane_width": lane_w}

	# Step 3: Else fallback based on highway tag (check roundabout override)
	if str(tags.get("junction", "")).strip_edges().to_lower() == "roundabout":
		var rb_lanes: int = fallback_info.get("lanes", 1)
		var rb_lane_w: float = 4.5
		return {"width": float(rb_lanes) * rb_lane_w, "lanes": rb_lanes, "lane_width": rb_lane_w}
	# Step 3: Else fallback based on highway tag
	var def_width: float = fallback_info.get("width", DEFAULT_ROAD_WIDTH)
	var def_lanes: int = fallback_info.get("lanes", DEFAULT_ROAD_LANES)
	return {"width": def_width, "lanes": def_lanes, "lane_width": def_width / float(def_lanes)}


# 4.3 Bike Lane Detection & Geometry Slicing


## Parse bike lane configuration from OSM tags
## Returns:
## {
##   "has_bike_lane": bool,
##   "is_dedicated": bool,
##   "left_width": float,
##   "right_width": float,
##   "total_bike_width": float
## }
static func parse_bike_lanes(tags: Dictionary) -> Dictionary:
	var highway = str(tags.get("highway", "")).strip_edges().to_lower()
	var bicycle = str(tags.get("bicycle", "")).strip_edges().to_lower()

	var is_dedicated = (highway == "cycleway") or (bicycle == "designated")

	if is_dedicated:
		var w_info = resolve_road_width(tags)
		return {
			"has_bike_lane": true,
			"is_dedicated": true,
			"left_width": 0.0,
			"right_width": 0.0,
			"total_bike_width": w_info.width
		}

	var left_width: float = 0.0
	var right_width: float = 0.0

	var cycleway = str(tags.get("cycleway", "")).strip_edges().to_lower()
	var cycleway_both = str(tags.get("cycleway:both", "")).strip_edges().to_lower()
	var cycleway_right = str(tags.get("cycleway:right", "")).strip_edges().to_lower()
	var cycleway_left = str(tags.get("cycleway:left", "")).strip_edges().to_lower()

	if cycleway == "track" or cycleway_both == "track":
		left_width = 2.0
		right_width = 2.0
	elif cycleway == "lane" or cycleway_both == "lane":
		left_width = 1.5
		right_width = 1.5
	else:
		if cycleway_right == "track":
			right_width = 2.0
		elif cycleway_right == "lane":
			right_width = 1.5

		if cycleway_left == "track":
			left_width = 2.0
		elif cycleway_left == "lane":
			left_width = 1.5

	var has_bike_lane = left_width > 0.0 or right_width > 0.0
	return {
		"has_bike_lane": has_bike_lane,
		"is_dedicated": false,
		"left_width": left_width,
		"right_width": right_width,
		"total_bike_width": left_width + right_width
	}


## Compute compound cross-section ribbon specifications
## Total width is subdivided into left bike lane (if any), carriageway, and right bike lane (if any).
## For each slice, offset is from centerline (negative = left, positive = right).
## Returns:
## Array of Dictionaries:
## [
##   {"type": "bike_lane" | "carriageway", "width": float, "offset": float, "material_type": String}
## ]
static func compute_cross_sections(tags: Dictionary) -> Array:
	var width_info = resolve_road_width(tags)
	var total_width = width_info.width
	var road_surface = resolve_surface_type(tags)

	var bike_info = parse_bike_lanes(tags)

	if bike_info.is_dedicated:
		return [
			{"type": "bike_lane", "width": total_width, "offset": 0.0, "material_type": "bike_lane"}
		]

	var left_bw = bike_info.left_width
	var right_bw = bike_info.right_width
	var total_bw = left_bw + right_bw

	# If bike lanes exist, carriageway ribbon width = Total Width - Bike Lane Width(s)
	# Ensure carriageway has at least minimum sensible width (e.g. 2.0m)
	var carriageway_width = maxf(2.0, total_width - total_bw)
	var effective_total_width = carriageway_width + total_bw

	# Centerline is at 0. Extents: -effective_total_width / 2 to +effective_total_width / 2
	# Left side: [-effective_total_width / 2, -effective_total_width / 2 + left_bw]
	# Carriageway: [-effective_total_width / 2 + left_bw, effective_total_width / 2 - right_bw]
	# Right side: [effective_total_width / 2 - right_bw, effective_total_width / 2]
	var sections: Array = []
	var current_pos = -effective_total_width * 0.5

	if left_bw > 0.0:
		var center_offset = current_pos + (left_bw * 0.5)
		sections.append(
			{
				"type": "bike_lane",
				"side": "left",
				"width": left_bw,
				"offset": center_offset,
				"material_type": "bike_lane"
			}
		)
		current_pos += left_bw

	var carriageway_center = current_pos + (carriageway_width * 0.5)
	sections.append(
		{
			"type": "carriageway",
			"side": "center",
			"width": carriageway_width,
			"offset": carriageway_center,
			"material_type": road_surface
		}
	)
	current_pos += carriageway_width

	if right_bw > 0.0:
		var center_offset = current_pos + (right_bw * 0.5)
		sections.append(
			{
				"type": "bike_lane",
				"side": "right",
				"width": right_bw,
				"offset": center_offset,
				"material_type": "bike_lane"
			}
		)
		current_pos += right_bw

	return sections


# 4.4 Road Ribbon Mesh Generation & Miter Clamping


## Compute 2D perpendicular normal vectors at each vertex of a polyline.
## Direction: forward tangent T = (P[i+1] - P[i]).normalized().
## Perpendicular normal N pointing to the right = (T.y, -T.x).
## For interior vertices, N is the normalized average of incident segment normals,
## clamped by the miter limit (default 2.0 * width) to prevent needle spikes or overlap.
static func compute_polyline_normals_2d(
	points_2d: PackedVector2Array, miter_limit: float = 2.0, is_closed_loop: bool = false
) -> Array[Vector2]:
	var n_pts = points_2d.size()
	var normals: Array[Vector2] = []
	if n_pts < 2:
		return normals

	normals.resize(n_pts)
	# Compute segment directions and perpendiculars
	var seg_dirs: Array[Vector2] = []
	var seg_normals: Array[Vector2] = []
	seg_dirs.resize(n_pts - 1)
	seg_normals.resize(n_pts - 1)

	for i in range(n_pts - 1):
		var delta = points_2d[i + 1] - points_2d[i]
		var length = delta.length()
		var dir = delta / length if length > 0.0001 else Vector2(1, 0)
		seg_dirs[i] = dir
		# Right normal in 2D (X = East, Y = North in 2D tangent plane, or X, Z in 3D):
		# Perpendicular: Vector2(-dir.y, dir.x) or (dir.y, -dir.x)
		# Standard right-hand normal for (dx, dy) is (dy, -dx)
		seg_normals[i] = Vector2(dir.y, -dir.x)

	# First and last vertex normals (for closed loops like roundabouts, use circular miter)
	if is_closed_loop and n_pts >= 3:
		var n_last_seg = seg_normals[n_pts - 2]
		var n_first_seg = seg_normals[0]
		var loop_miter = n_last_seg + n_first_seg
		if loop_miter.length_squared() > 0.0001:
			loop_miter = loop_miter.normalized()
			var dot_val = loop_miter.dot(n_last_seg)
			var scale_factor = 1.0 / maxf(0.001, dot_val)
			if scale_factor > miter_limit:
				scale_factor = miter_limit
			normals[0] = loop_miter * scale_factor
			normals[n_pts - 1] = normals[0]
		else:
			normals[0] = seg_normals[0]
			normals[n_pts - 1] = seg_normals[n_pts - 2]
	else:
		normals[0] = seg_normals[0]
	for i in range(1, n_pts - 1):
		var n_prev = seg_normals[i - 1]
		var n_next = seg_normals[i]

		# Miter normal is bisector of normals
		var miter = n_prev + n_next
		if miter.length_squared() < 0.0001:
			# 180-degree turn: fallback to segment normal
			normals[i] = n_prev
		else:
			miter = miter.normalized()
			# Miter scale factor = 1.0 / dot(miter, n_prev)
			var dot_val = miter.dot(n_prev)
			var scale_factor = 1.0 / maxf(0.001, dot_val)
			if scale_factor > miter_limit:
				scale_factor = miter_limit
			normals[i] = miter * scale_factor

	# Last vertex normal
	if not (is_closed_loop and n_pts >= 3):
		normals[n_pts - 1] = seg_normals[n_pts - 2]
	return normals


## Extrude a polyline ribbon given 3D centerline points, width, and optional centerline offset.
## Centerline offset shifts the ribbon left (negative) or right (positive) before width extrusion.
## Returns:
## {
##   "vertices": PackedVector3Array,
##   "normals": PackedVector3Array,
##   "uvs": PackedVector2Array,
##   "indices": PackedInt32Array
## }
static func generate_road_ribbon(
	centerline_3d: PackedVector3Array,
	width: float,
	center_offset: float = 0.0,
	y_elevation: float = 0.05,
	miter_limit_factor: float = 2.0,
	cap_start: String = "flat",  # "flat", "round", or "square"
	cap_end: String = "flat",  # "flat", "round", or "square"
	is_closed_loop: bool = false
) -> Dictionary:
	var n_pts = centerline_3d.size()
	var empty_res = {
		"vertices": PackedVector3Array(),
		"normals": PackedVector3Array(),
		"uvs": PackedVector2Array(),
		"indices": PackedInt32Array()
	}
	if n_pts < 2:
		return empty_res

	# Convert XZ into 2D points for normal calculation
	var pts_2d = PackedVector2Array()
	pts_2d.resize(n_pts)
	for i in range(n_pts):
		pts_2d[i] = Vector2(centerline_3d[i].x, centerline_3d[i].z)

	var normals_2d = compute_polyline_normals_2d(pts_2d, miter_limit_factor, is_closed_loop)
	var vertices = PackedVector3Array()
	var normals = PackedVector3Array()
	var uvs = PackedVector2Array()
	var indices = PackedInt32Array()

	vertices.resize(n_pts * 2)
	normals.resize(n_pts * 2)
	uvs.resize(n_pts * 2)

	var half_w = width * 0.5
	var accumulated_dist: float = 0.0

	for i in range(n_pts):
		var p = centerline_3d[i]
		var n2 = normals_2d[i]  # X is dx, Y is dz
		var normal_3d = Vector3(n2.x, 0.0, n2.y)

		if i > 0:
			accumulated_dist += Vector2(p.x, p.z).distance_to(
				Vector2(centerline_3d[i - 1].x, centerline_3d[i - 1].z)
			)

		# Base position shifted by center_offset along normal
		var shifted_center = Vector3(p.x, p.y + y_elevation, p.z) + normal_3d * center_offset

		# V_left = P - N * (width / 2)
		# V_right = P + N * (width / 2)
		var v_left = shifted_center - normal_3d * half_w
		var v_right = shifted_center + normal_3d * half_w

		var idx_left = i * 2
		var idx_right = i * 2 + 1

		vertices[idx_left] = v_left
		vertices[idx_right] = v_right

		normals[idx_left] = Vector3.UP
		normals[idx_right] = Vector3.UP

		# UV: U across ribbon [0, 1], V along length in meters
		uvs[idx_left] = Vector2(0.0, accumulated_dist / 5.0)
		uvs[idx_right] = Vector2(1.0, accumulated_dist / 5.0)

	# Quad index generation: 2 triangles per segment
	for i in range(n_pts - 1):
		var l0 = i * 2
		var r0 = i * 2 + 1
		var l1 = (i + 1) * 2
		var r1 = (i + 1) * 2 + 1

		# Quad: (l0, r0, r1) and (l0, r1, l1)
		indices.append(l0)
		indices.append(r0)
		indices.append(r1)

		indices.append(l0)
		indices.append(r1)
		indices.append(l1)

	# End-caps (round or square) for cul-de-sacs / dead-ends
	_append_ribbon_cap(
		vertices,
		normals,
		uvs,
		indices,
		centerline_3d,
		normals_2d,
		width,
		center_offset,
		y_elevation,
		true,
		cap_start
	)
	_append_ribbon_cap(
		vertices,
		normals,
		uvs,
		indices,
		centerline_3d,
		normals_2d,
		width,
		center_offset,
		y_elevation,
		false,
		cap_end
	)

	return {"vertices": vertices, "normals": normals, "uvs": uvs, "indices": indices}


## Helper to append round or square end-caps to a road ribbon endpoint
static func _append_ribbon_cap(
	vertices: PackedVector3Array,
	normals: PackedVector3Array,
	uvs: PackedVector2Array,
	indices: PackedInt32Array,
	centerline_3d: PackedVector3Array,
	normals_2d: PackedVector2Array,
	width: float,
	center_offset: float,
	y_elevation: float,
	is_start: bool,
	cap_type: String
) -> void:
	if cap_type == "flat" or cap_type == "none" or cap_type.is_empty():
		return
	var n_pts = centerline_3d.size()
	if n_pts < 2:
		return

	var pt_idx = 0 if is_start else n_pts - 1
	var neighbor_idx = 1 if is_start else n_pts - 2

	var p = centerline_3d[pt_idx]
	var p_neighbor = centerline_3d[neighbor_idx]

	# Outward direction pointing away from the ribbon body along the road axis
	var fwd_2d = Vector2(p.x - p_neighbor.x, p.z - p_neighbor.z)
	if fwd_2d.length_squared() < 0.0001:
		return
	var fwd_dir = fwd_2d.normalized()
	var fwd_3d = Vector3(fwd_dir.x, 0.0, fwd_dir.y)

	var n2 = normals_2d[pt_idx]
	var normal_3d = Vector3(n2.x, 0.0, n2.y)
	var half_w = width * 0.5
	var center_3d = Vector3(p.x, p.y + y_elevation, p.z) + normal_3d * center_offset

	var left_idx = pt_idx * 2
	var right_idx = pt_idx * 2 + 1
	var v_left = vertices[left_idx]
	var v_right = vertices[right_idx]

	if cap_type == "square":
		# Square end-cap extends outward by half_w
		var cap_l = v_left + fwd_3d * half_w
		var cap_r = v_right + fwd_3d * half_w

		var start_new_v = vertices.size()
		vertices.append(cap_l)
		vertices.append(cap_r)
		normals.append(Vector3.UP)
		normals.append(Vector3.UP)
		uvs.append(Vector2(0.0, 0.0))
		uvs.append(Vector2(1.0, 0.0))

		# Connect existing boundary (v_left, v_right) with (cap_l, cap_r)
		var l0 = left_idx
		var r0 = right_idx
		var l1 = start_new_v
		var r1 = start_new_v + 1

		# Ensure counter-clockwise winding visible from +Y
		if is_start:
			# At start, fwd_dir points backwards along polyline
			indices.append(r0)
			indices.append(l0)
			indices.append(l1)
			indices.append(r0)
			indices.append(l1)
			indices.append(r1)
		else:
			# At end, fwd_dir points forwards
			indices.append(l0)
			indices.append(r0)
			indices.append(r1)
			indices.append(l0)
			indices.append(r1)
			indices.append(l1)

	elif cap_type == "round":
		# Half-circle fan around center_3d, spanning from v_left to v_right outward
		var num_steps = 8
		var center_v_idx = vertices.size()
		vertices.append(center_3d)
		normals.append(Vector3.UP)
		uvs.append(Vector2(0.5, 0.5))

		var arc_indices: Array[int] = []
		# Arc sweeps 180 degrees from -normal through fwd to +normal (or vice-versa depending on start/end)
		var right_dir = (v_right - center_3d).normalized()
		var left_dir = (v_left - center_3d).normalized()

		for s in range(num_steps + 1):
			var t = float(s) / float(num_steps)  # 0.0 to 1.0
			var angle = PI * t
			# Arc from left_dir around toward fwd_3d and to right_dir
			var arc_dir: Vector3
			if is_start:
				# from right to left outward
				arc_dir = (right_dir * cos(angle) + fwd_3d * sin(angle)).normalized()
			else:
				# from left to right outward
				arc_dir = (left_dir * cos(angle) + fwd_3d * sin(angle)).normalized()

			var arc_pt = center_3d + arc_dir * half_w
			arc_indices.append(vertices.size())
			vertices.append(arc_pt)
			normals.append(Vector3.UP)
			uvs.append(Vector2(0.5 + 0.5 * arc_dir.x, 0.5 + 0.5 * arc_dir.z))

		for s in range(num_steps):
			var p_cur = arc_indices[s]
			var p_next = arc_indices[s + 1]
			indices.append(center_v_idx)
			indices.append(p_cur)
			indices.append(p_next)


## Generate road ribbon polygon via Godot 4 Clipper (Geometry2D.offset_polyline)
## Used when complex joins / contours or clipping are preferred.
static func generate_clipper_ribbon_2d(
	points_2d: PackedVector2Array, width: float
) -> Array[PackedVector2Array]:
	return Geometry2D.offset_polyline(
		points_2d, width * 0.5, Geometry2D.JOIN_MITER, Geometry2D.END_BUTT
	)


# 4.5 Vertical Layering, Bridges, and Tunnels

const ELEVATION_BASE_TERRAIN: float = 0.00
const ELEVATION_ROADS: float = 0.05
const ELEVATION_BIKE_LANES: float = 0.07
const ELEVATION_FOOTPATHS: float = 0.09
const LAYER_HEIGHT_METERS: float = 4.5
const BRIDGE_MIN_HEIGHT_METERS: float = 4.5


## Parse layer tag in range [-5, +5]
static func parse_layer(tags: Dictionary) -> int:
	if tags.has("layer"):
		var l_val = int(parse_numeric_dimension(tags.get("layer"), 0.0))
		return clampi(l_val, -5, 5)
	return 0


## Check if way is a bridge
static func is_bridge(tags: Dictionary) -> bool:
	if tags.has("bridge"):
		var val = str(tags.get("bridge")).strip_edges().to_lower()
		return val != "no" and val != "false" and val != "0"
	return false


## Check if way is a tunnel
static func is_tunnel(tags: Dictionary) -> bool:
	if tags.has("tunnel"):
		var val = str(tags.get("tunnel")).strip_edges().to_lower()
		return val != "no" and val != "false" and val != "0"
	return false


## Calculate elevation offset:
## Y = base_elevation + (layer * 4.5m)
## For bridge=yes, elevate road to minimum Y = 4.5m if layer is 0.
## Type can be "carriageway", "bike_lane", "footway".
static func calculate_elevation(tags: Dictionary, section_type: String = "carriageway") -> float:
	var layer_val = parse_layer(tags)
	var bridge = is_bridge(tags)

	var z_offset = ELEVATION_ROADS
	var highway = str(tags.get("highway", "")).strip_edges().to_lower()

	if section_type == "bike_lane":
		z_offset = ELEVATION_BIKE_LANES
	elif section_type == "footway" or highway in ["footway", "pedestrian", "path", "steps"]:
		z_offset = ELEVATION_FOOTPATHS
	else:
		z_offset = ELEVATION_ROADS

	var layer_offset = float(layer_val) * LAYER_HEIGHT_METERS
	var total_y = z_offset + layer_offset

	if bridge and total_y < BRIDGE_MIN_HEIGHT_METERS:
		total_y = BRIDGE_MIN_HEIGHT_METERS + z_offset

	return total_y


## Generate vertical bridge support pillars extending to ground Y = 0
## Pillars are placed at interval (e.g. every 20-30m) along the bridge centerline
static func generate_bridge_pillars(
	centerline_3d: PackedVector3Array,
	bridge_y: float,
	pillar_radius: float = 0.6,
	spacing: float = 25.0
) -> Dictionary:
	var vertices = PackedVector3Array()
	var normals = PackedVector3Array()
	var uvs = PackedVector2Array()
	var indices = PackedInt32Array()

	if centerline_3d.size() < 2 or bridge_y <= 0.5:
		return {"vertices": vertices, "normals": normals, "uvs": uvs, "indices": indices}

	var total_dist = 0.0
	var sampled_points: Array[Vector3] = []
	var current_acc = 0.0

	# Always place a pillar at intermediate spans
	sampled_points.append(centerline_3d[0])
	for i in range(centerline_3d.size() - 1):
		var p0 = centerline_3d[i]
		var p1 = centerline_3d[i + 1]
		var seg_len = Vector2(p1.x - p0.x, p1.z - p0.z).length()
		current_acc += seg_len
		if current_acc >= spacing:
			sampled_points.append(p1)
			current_acc = 0.0
	if sampled_points.size() == 1 and centerline_3d.size() > 1:
		sampled_points.append(centerline_3d[centerline_3d.size() - 1])

	# For each pillar point, create an octagonal or 6-sided cylinder from Y = 0 to Y = bridge_y
	var sides = 6
	for center_pt in sampled_points:
		var base_idx = vertices.size()
		for s in range(sides):
			var angle = float(s) * TAU / float(sides)
			var next_angle = float(s + 1) * TAU / float(sides)
			var dir0 = Vector3(cos(angle), 0, sin(angle))
			var dir1 = Vector3(cos(next_angle), 0, sin(next_angle))

			var b0 = Vector3(
				center_pt.x + dir0.x * pillar_radius, 0.0, center_pt.z + dir0.z * pillar_radius
			)
			var b1 = Vector3(
				center_pt.x + dir1.x * pillar_radius, 0.0, center_pt.z + dir1.z * pillar_radius
			)
			var t0 = Vector3(
				center_pt.x + dir0.x * pillar_radius, bridge_y, center_pt.z + dir0.z * pillar_radius
			)
			var t1 = Vector3(
				center_pt.x + dir1.x * pillar_radius, bridge_y, center_pt.z + dir1.z * pillar_radius
			)

			var quad_start = vertices.size()
			vertices.append(b0)
			vertices.append(b1)
			vertices.append(t1)
			vertices.append(t0)

			var wall_n = (dir0 + dir1).normalized()
			normals.append(wall_n)
			normals.append(wall_n)
			normals.append(wall_n)
			normals.append(wall_n)

			uvs.append(Vector2(0, 0))
			uvs.append(Vector2(1, 0))
			uvs.append(Vector2(1, bridge_y / 3.0))
			uvs.append(Vector2(0, bridge_y / 3.0))

			indices.append(quad_start)
			indices.append(quad_start + 1)
			indices.append(quad_start + 2)

			indices.append(quad_start)
			indices.append(quad_start + 2)
			indices.append(quad_start + 3)

	return {"vertices": vertices, "normals": normals, "uvs": uvs, "indices": indices}


## Generate side safety barriers for bridges
## Extrudes vertical side barrier walls of height barrier_height along the left and right outer margins
static func generate_bridge_barriers(
	centerline_3d: PackedVector3Array,
	total_width: float,
	bridge_y: float,
	barrier_height: float = 1.0
) -> Dictionary:
	var vertices = PackedVector3Array()
	var normals = PackedVector3Array()
	var uvs = PackedVector2Array()
	var indices = PackedInt32Array()

	var n_pts = centerline_3d.size()
	if n_pts < 2:
		return {"vertices": vertices, "normals": normals, "uvs": uvs, "indices": indices}

	var pts_2d = PackedVector2Array()
	pts_2d.resize(n_pts)
	for i in range(n_pts):
		pts_2d[i] = Vector2(centerline_3d[i].x, centerline_3d[i].z)
	var normals_2d = compute_polyline_normals_2d(pts_2d)

	var half_w = total_width * 0.5

	# We generate two vertical barrier ribbons: Left margin and Right margin
	var margins = [-half_w, half_w]
	for m_offset in margins:
		var is_left = m_offset < 0.0
		for i in range(n_pts - 1):
			var p0 = centerline_3d[i]
			var p1 = centerline_3d[i + 1]
			var n0_3d = Vector3(normals_2d[i].x, 0, normals_2d[i].y)
			var n1_3d = Vector3(normals_2d[i + 1].x, 0, normals_2d[i + 1].y)

			var b0 = Vector3(p0.x, bridge_y, p0.z) + n0_3d * m_offset
			var b1 = Vector3(p1.x, bridge_y, p1.z) + n1_3d * m_offset
			var t0 = b0 + Vector3(0, barrier_height, 0)
			var t1 = b1 + Vector3(0, barrier_height, 0)

			var quad_start = vertices.size()
			vertices.append(b0)
			vertices.append(b1)
			vertices.append(t1)
			vertices.append(t0)

			var wall_n = (n0_3d + n1_3d).normalized() * (-1.0 if is_left else 1.0)
			normals.append(wall_n)
			normals.append(wall_n)
			normals.append(wall_n)
			normals.append(wall_n)

			uvs.append(Vector2(0, 0))
			uvs.append(Vector2(1, 0))
			uvs.append(Vector2(1, 1))
			uvs.append(Vector2(0, 1))

			indices.append(quad_start)
			indices.append(quad_start + 1)
			indices.append(quad_start + 2)

			indices.append(quad_start)
			indices.append(quad_start + 2)
			indices.append(quad_start + 3)

	return {"vertices": vertices, "normals": normals, "uvs": uvs, "indices": indices}


## Build complete 3D Node3D for roads array, including compound ribbons, bridge barriers, and pillars
static func build_roads_node(roads_data: Array, create_colliders: bool = true) -> Node3D:
	var roads_root = Node3D.new()
	roads_root.name = "Roads"

	# Group surfaces by material for efficient batching / clean scene hierarchy
	var surface_batches: Dictionary = {}

	# Pass 1: Build endpoint incidence map to detect cul-de-sacs / dead ends (node degree == 1)
	var endpoint_counts: Dictionary = {}
	for road_dict in roads_data:
		var pts: PackedVector3Array = road_dict.get("points", PackedVector3Array())
		var is_closed = road_dict.get("is_closed", false)
		if pts.size() < 2 or is_closed:
			continue
		var k_start = _point_grid_key(pts[0])
		var k_end = _point_grid_key(pts[pts.size() - 1])
		endpoint_counts[k_start] = endpoint_counts.get(k_start, 0) + 1
		endpoint_counts[k_end] = endpoint_counts.get(k_end, 0) + 1
	for road_dict in roads_data:
		var tags: Dictionary = road_dict.get("tags", {})
		var points: PackedVector3Array = road_dict.get("points", PackedVector3Array())
		if points.size() < 2:
			continue

		var is_br = is_bridge(tags)
		var cross_sections = compute_cross_sections(tags)
		var total_width_info = resolve_road_width(tags)
		var total_road_width = total_width_info.width
		var is_closed = road_dict.get("is_closed", false)

		# Dead-end check for start and end points
		var cap_start = "flat"
		var cap_end = "flat"
		if not is_closed:
			var k_start = _point_grid_key(points[0])
			var k_end = _point_grid_key(points[points.size() - 1])
			if endpoint_counts.get(k_start, 0) == 1:
				cap_start = "round"
			if endpoint_counts.get(k_end, 0) == 1:
				cap_end = "round"

		# Generate ribbon for each cross-section slice
		for sec in cross_sections:
			var s_type = sec.get("type", "carriageway")
			var s_width = sec.get("width", 3.0)
			var s_offset = sec.get("offset", 0.0)
			var mat_type = sec.get("material_type", "asphalt")
			var elev_y = calculate_elevation(tags, s_type)

			var ribbon = generate_road_ribbon(
				points, s_width, s_offset, elev_y, 2.0, cap_start, cap_end, is_closed
			)
			if ribbon.vertices.size() >= 3:
				_append_mesh_batch(surface_batches, mat_type, ribbon)
		# If bridge, also generate safety barriers and support pillars
		if is_br:
			var br_y = calculate_elevation(tags, "carriageway")
			var barriers = generate_bridge_barriers(points, total_road_width, br_y)
			if barriers.vertices.size() > 0:
				_append_mesh_batch(surface_batches, "concrete", barriers)

			var pillars = generate_bridge_pillars(points, br_y)
			if pillars.vertices.size() > 0:
				_append_mesh_batch(surface_batches, "concrete", pillars)

	# Instantiate MeshInstance3D nodes for each material batch
	for mat_key in surface_batches.keys():
		var batch_data = surface_batches[mat_key]
		var verts: PackedVector3Array = batch_data["vertices"]
		var idxs: PackedInt32Array = batch_data["indices"]
		if verts.is_empty() or idxs.is_empty():
			continue

		var arrays = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = verts
		arrays[Mesh.ARRAY_NORMAL] = batch_data["normals"]
		arrays[Mesh.ARRAY_TEX_UV] = batch_data["uvs"]
		arrays[Mesh.ARRAY_INDEX] = idxs

		var arr_mesh = ArrayMesh.new()
		arr_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)

		var mi = MeshInstance3D.new()
		mi.name = "RoadMesh_" + mat_key.capitalize()
		mi.mesh = arr_mesh
		mi.material_override = get_surface_material(mat_key)

		if create_colliders:
			var sb = StaticBody3D.new()
			sb.name = "Collision"
			var cs = CollisionShape3D.new()
			cs.shape = arr_mesh.create_trimesh_shape()
			sb.add_child(cs)
			mi.add_child(sb)

		roads_root.add_child(mi)

	return roads_root


static func _append_mesh_batch(batches: Dictionary, mat_key: String, geom: Dictionary) -> void:
	if not batches.has(mat_key):
		batches[mat_key] = {
			"vertices": PackedVector3Array(),
			"normals": PackedVector3Array(),
			"uvs": PackedVector2Array(),
			"indices": PackedInt32Array()
		}
	var target = batches[mat_key]
	var base_idx = target["vertices"].size()

	var g_verts: PackedVector3Array = geom["vertices"]
	var g_norms: PackedVector3Array = geom["normals"]
	var g_uvs: PackedVector2Array = geom["uvs"]
	var g_idxs: PackedInt32Array = geom["indices"]

	target["vertices"].append_array(g_verts)
	target["normals"].append_array(g_norms)
	target["uvs"].append_array(g_uvs)

	for idx in g_idxs:
		target["indices"].append(base_idx + idx)


static func _point_grid_key(p: Vector3, snap_m: float = 0.5) -> String:
	var gx = int(round(p.x / snap_m))
	var gz = int(round(p.z / snap_m))
	return str(gx) + "," + str(gz)
