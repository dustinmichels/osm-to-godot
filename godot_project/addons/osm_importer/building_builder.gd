class_name BuildingBuilder
extends RefCounted

## Procedural 3D building generation from OSM building footprints.
## Implements height ladder inference, Earcut roof triangulation,
## perimeter wall extrusion with outward normals, and PBR material/color mapping.

const EarcutModule = preload("earcut.gd")

const LEVEL_HEIGHT_METERS: float = 3.3

const SEMANTIC_BUILDING_HEIGHTS: Dictionary = {
	"apartments": 14.0,
	"commercial": 14.0,
	"office": 14.0,
	"hotel": 14.0,
	"residential": 7.0,
	"house": 7.0,
	"detached": 7.0,
	"retail": 5.5,
	"supermarket": 5.5,
	"industrial": 8.0,
	"warehouse": 8.0,
	"garage": 3.0,
	"shed": 3.0,
	"kiosk": 3.0,
	"yes": 8.0,
}

const DEFAULT_BUILDING_HEIGHT: float = 8.0

const MATERIAL_PRESETS: Dictionary = {
	"brick": {"color": Color(0.612, 0.278, 0.220), "roughness": 0.90, "metallic": 0.0},  # #9C4738
	"concrete": {"color": Color(0.690, 0.678, 0.663), "roughness": 0.85, "metallic": 0.0},  # #B0ADA9
	"glass": {"color": Color(0.627, 0.769, 0.875), "roughness": 0.15, "metallic": 0.5},  # #A0C4DF
	"plaster": {"color": Color(0.910, 0.886, 0.835), "roughness": 0.90, "metallic": 0.0},  # #E8E2D5
	"wood": {"color": Color(0.541, 0.353, 0.212), "roughness": 0.70, "metallic": 0.0},  # #8A5A36
	"default_wall": {"color": Color(0.816, 0.784, 0.722), "roughness": 0.80, "metallic": 0.0},  # #D0C8B8
	"default_roof": {"color": Color(0.290, 0.271, 0.251), "roughness": 0.90, "metallic": 0.0}  # #4A4540
}

const COLOR_ALIASES: Dictionary = {
	"cream": Color(0.996, 0.992, 0.816),
	"sandstone": Color(0.850, 0.780, 0.650),
	"terracotta": Color(0.886, 0.447, 0.357),
	"light_grey": Color(0.827, 0.827, 0.827),
	"light_gray": Color(0.827, 0.827, 0.827),
	"dark_grey": Color(0.663, 0.663, 0.663),
	"dark_gray": Color(0.663, 0.663, 0.663),
}

# --- 3.1 Height & Floor Level Inference ---

## Word number mapping for non-numeric words in tags (e.g. "two", "three")
const NUMBER_WORDS: Dictionary = {
	"zero": 0.0,
	"one": 1.0,
	"two": 2.0,
	"three": 3.0,
	"four": 4.0,
	"five": 5.0,
	"six": 6.0,
	"seven": 7.0,
	"eight": 8.0,
	"nine": 9.0,
	"ten": 10.0,
	"eleven": 11.0,
	"twelve": 12.0
}


## Robust regex sanitizer for numeric tags (e.g. "12 meters", "lanes=two", "approx 3", "15.5m", "10,5")
static func parse_numeric_dimension(val: Variant, default_val: float = 0.0) -> float:
	if val == null:
		return default_val
	if val is float or val is int:
		return float(val)
	var s: String = str(val).strip_edges().to_lower()
	if s.is_empty():
		return default_val

	# Check word numbers like "two", "three"
	if NUMBER_WORDS.has(s):
		return NUMBER_WORDS[s]
	for word in NUMBER_WORDS.keys():
		if s == word or s.begins_with(word + " ") or s.ends_with(" " + word):
			return NUMBER_WORDS[word]

	# Normalize European comma decimal separator if present: "12,5" -> "12.5"
	s = s.replace(",", ".")

	# Match floating point or integer number, even if surrounded by text ("approx 3", "12 meters", "14.5m")
	var regex = RegEx.new()
	regex.compile("([0-9]+(?:\\.[0-9]+)?)")
	var m = regex.search(s)
	if m != null and m.strings.size() > 1:
		return float(m.strings[1])

	return default_val


## Resolve building heights following the deterministic resolution ladder:
## 1. Explicit `height` tag
## 2. `building:levels` tag * 3.3m
## 3. Semantic `building` classification
## Elevated base: `min_height` or `building:min_level` * 3.3m
static func resolve_height(tags: Dictionary) -> Dictionary:
	var base_y: float = 0.0
	if tags.has("min_height"):
		base_y = parse_numeric_dimension(tags["min_height"], 0.0)
	elif tags.has("building:min_level"):
		var min_lvl = parse_numeric_dimension(tags["building:min_level"], 0.0)
		base_y = min_lvl * LEVEL_HEIGHT_METERS

	var height: float = 0.0
	var has_explicit_height = false

	if tags.has("height"):
		var h = parse_numeric_dimension(tags["height"], 0.0)
		if h > 0.0:
			height = h
			has_explicit_height = true

	if not has_explicit_height and tags.has("building:levels"):
		var levels = parse_numeric_dimension(tags["building:levels"], 0.0)
		if levels > 0.0:
			height = levels * LEVEL_HEIGHT_METERS

	if height <= 0.0:
		var b_type: String = str(tags.get("building", "yes")).to_lower()
		if SEMANTIC_BUILDING_HEIGHTS.has(b_type):
			height = SEMANTIC_BUILDING_HEIGHTS[b_type]
		else:
			height = DEFAULT_BUILDING_HEIGHT

	# In OSM, explicit height often denotes total height above ground.
	# If height was explicit and exceeds base_y, roof_y = height; otherwise roof_y = base_y + height.
	var roof_y: float = 0.0
	if has_explicit_height and height > base_y:
		roof_y = height
	else:
		roof_y = base_y + height

	return {"base_y": base_y, "roof_y": roof_y, "height": roof_y - base_y}


# --- 3.4 Materials & Color Mapping ---


## Parse CSS color string, hex code, or alias
static func parse_color(color_str: Variant, default_color: Color) -> Color:
	if color_str == null:
		return default_color
	var s = str(color_str).strip_edges().to_lower()
	if s.is_empty():
		return default_color

	if COLOR_ALIASES.has(s):
		return COLOR_ALIASES[s]

	# Try Godot's built-in parser (handles HTML names and #RGB / #RRGGBB)
	var col = Color.from_string(s, Color(-1, -1, -1, -1))
	if col.a >= 0.0:
		return col

	# Try prefixing '#' if missing
	if not s.begins_with("#"):
		col = Color.from_string("#" + s, Color(-1, -1, -1, -1))
		if col.a >= 0.0:
			return col

	return default_color


## Generate wall StandardMaterial3D based on tags, supporting triplanar mapping
static func resolve_wall_material(
	tags: Dictionary, enable_triplanar: bool = true
) -> StandardMaterial3D:
	var mat: StandardMaterial3D
	var mat_name: String = str(tags.get("building:material", "")).to_lower()
	var col_tag = tags.get("building:colour", tags.get("colour", null))

	if (
		mat_name.is_empty()
		and col_tag == null
		and ResourceLoader.exists("res://materials/building_wall_default.tres")
	):
		var base_res = load("res://materials/building_wall_default.tres") as StandardMaterial3D
		if base_res != null:
			mat = base_res.duplicate()

	if mat == null:
		mat = StandardMaterial3D.new()
		mat.cull_mode = BaseMaterial3D.CULL_BACK

		var preset: Dictionary = MATERIAL_PRESETS["default_wall"]
		if MATERIAL_PRESETS.has(mat_name):
			preset = MATERIAL_PRESETS[mat_name]
			mat.resource_name = "wall_" + mat_name
		else:
			mat.resource_name = "wall_default"

		mat.albedo_color = preset["color"]
		mat.roughness = preset["roughness"]
		mat.metallic = preset["metallic"]

		# Check building:colour or colour override
		if col_tag != null:
			mat.albedo_color = parse_color(col_tag, mat.albedo_color)
			mat.resource_name += "_" + str(col_tag)

	if enable_triplanar:
		mat.uv1_triplanar = true
		mat.uv1_world_triplanar = true

	return mat


## Generate roof StandardMaterial3D based on tags
static func resolve_roof_material(tags: Dictionary) -> StandardMaterial3D:
	var mat: StandardMaterial3D
	var mat_name: String = str(tags.get("roof:material", "")).to_lower()
	var col_tag = tags.get("roof:colour", null)

	if (
		mat_name.is_empty()
		and col_tag == null
		and ResourceLoader.exists("res://materials/building_roof_default.tres")
	):
		var base_res = load("res://materials/building_roof_default.tres") as StandardMaterial3D
		if base_res != null:
			mat = base_res.duplicate()

	if mat == null:
		mat = StandardMaterial3D.new()
		mat.cull_mode = BaseMaterial3D.CULL_BACK

		var preset: Dictionary = MATERIAL_PRESETS["default_roof"]
		if MATERIAL_PRESETS.has(mat_name):
			preset = MATERIAL_PRESETS[mat_name]
			mat.resource_name = "roof_" + mat_name
		else:
			mat.resource_name = "roof_default"

		mat.albedo_color = preset["color"]
		mat.roughness = preset["roughness"]
		mat.metallic = preset["metallic"]

		# Check roof:colour override
		if col_tag != null:
			mat.albedo_color = parse_color(col_tag, mat.albedo_color)
			mat.resource_name += "_" + str(col_tag)

	return mat


## Get a stable unique key for wall material grouping
static func get_wall_material_key(tags: Dictionary) -> String:
	var mat_name: String = str(tags.get("building:material", "")).strip_edges().to_lower()
	var col_tag = tags.get("building:colour", tags.get("colour", null))
	if col_tag != null:
		return mat_name + "_col_" + str(col_tag).strip_edges().to_lower()
	if not mat_name.is_empty():
		return mat_name
	return "default_wall"


## Get a stable unique key for roof material grouping
static func get_roof_material_key(tags: Dictionary) -> String:
	var mat_name: String = str(tags.get("roof:material", "")).strip_edges().to_lower()
	var col_tag = tags.get("roof:colour", null)
	if col_tag != null:
		return mat_name + "_col_" + str(col_tag).strip_edges().to_lower()
	if not mat_name.is_empty():
		return mat_name
	return "default_roof"


# --- 3.2 & 3.3 Mesh Construction (Roof & Walls) ---


## Build raw geometry data for a building feature dictionary
static func build_building_mesh_data(building: Dictionary) -> Dictionary:
	var tags: Dictionary = building.get("tags", {})
	var outer_rings: Array = building.get("outer_rings", [])
	var inner_rings: Array = building.get("inner_rings", [])

	var h_info = resolve_height(tags)
	var base_y: float = h_info["base_y"]
	var roof_y: float = h_info["roof_y"]

	var wall_vertices = PackedVector3Array()
	var wall_normals = PackedVector3Array()
	var wall_uvs = PackedVector2Array()
	var wall_indices = PackedInt32Array()

	var roof_vertices = PackedVector3Array()
	var roof_normals = PackedVector3Array()
	var roof_uvs = PackedVector2Array()
	var roof_indices = PackedInt32Array()

	# --- 3.3 Wall Extrusion & Normals ---
	# Outer rings: CCW (positive area in X, -Z plane)
	for ring in outer_rings:
		if ring is PackedVector3Array and ring.size() >= 3:
			_extrude_wall_ring(
				ring, base_y, roof_y, false, wall_vertices, wall_normals, wall_uvs, wall_indices
			)

	# Inner rings: holes (CW in X, -Z plane).
	# For interior hole walls facing the courtyard/hole air:
	# Reverse ring so hole is on the right, solid wall on the left, normals face into the hole.
	for ring in inner_rings:
		if ring is PackedVector3Array and ring.size() >= 3:
			_extrude_wall_ring(
				ring, base_y, roof_y, true, wall_vertices, wall_normals, wall_uvs, wall_indices
			)

	# --- 3.2 Roof Polygon Triangulation (Earcut) ---
	# Each outer ring defines a polygon boundary; inner rings fall inside outer rings.
	for outer in outer_rings:
		if outer is PackedVector3Array and outer.size() >= 3:
			var tri_result = EarcutModule.triangulate_polygon_3d(outer, inner_rings, roof_y)
			var pts: PackedVector3Array = tri_result["points"]
			var idxs: PackedInt32Array = tri_result["indices"]

			var base_index = roof_vertices.size()
			for pt in pts:
				roof_vertices.append(pt)
				roof_normals.append(Vector3(0.0, 1.0, 0.0))
				# Planar world-space UV: U = X / 10.0, V = Z / 10.0
				roof_uvs.append(Vector2(pt.x / 10.0, pt.z / 10.0))

			for idx in idxs:
				roof_indices.append(base_index + idx)

	return {
		"id": building.get("id", 0),
		"tags": tags,
		"height_info": h_info,
		"wall_material": resolve_wall_material(tags),
		"roof_material": resolve_roof_material(tags),
		"walls":
		{
			"vertices": wall_vertices,
			"normals": wall_normals,
			"uvs": wall_uvs,
			"indices": wall_indices
		},
		"roof":
		{
			"vertices": roof_vertices,
			"normals": roof_normals,
			"uvs": roof_uvs,
			"indices": roof_indices
		}
	}


## Extrude a perimeter ring into vertical quads
static func _extrude_wall_ring(
	ring: PackedVector3Array,
	base_y: float,
	roof_y: float,
	is_hole: bool,
	out_vertices: PackedVector3Array,
	out_normals: PackedVector3Array,
	out_uvs: PackedVector2Array,
	out_indices: PackedInt32Array
) -> void:
	var pts = ring
	if is_hole:
		pts = ring.duplicate()
		pts.reverse()  # Reversing CW hole makes it CCW around the hole interior

	var n = pts.size()
	if n < 3:
		return

	# Strip closing point if identical to start
	var count = n
	if pts[0].distance_squared_to(pts[n - 1]) < 0.0001:
		count = n - 1

	if count < 3:
		return

	var u_accum = 0.0
	for i in range(count):
		var p0 = pts[i]
		var p1 = pts[(i + 1) % count]

		var dx = p1.x - p0.x
		var dz = p1.z - p0.z
		var seg_len = sqrt(dx * dx + dz * dz)
		if seg_len < 0.0001:
			continue

		# Outward-facing normal perpendicular to segment in XZ plane
		# Walking segment with exterior on right: normal is (-dz, 0, dx) normalized
		var norm = Vector3(-dz / seg_len, 0.0, dx / seg_len)

		# 4 quad vertices
		var v0 = Vector3(p0.x, base_y, p0.z)
		var v1 = Vector3(p1.x, base_y, p1.z)
		var v2 = Vector3(p1.x, roof_y, p1.z)
		var v3 = Vector3(p0.x, roof_y, p0.z)

		var u0 = u_accum
		var u1 = u_accum + seg_len
		u_accum = u1

		var uv0 = Vector2(u0, base_y)
		var uv1 = Vector2(u1, base_y)
		var uv2 = Vector2(u1, roof_y)
		var uv3 = Vector2(u0, roof_y)

		var start_idx = out_vertices.size()
		out_vertices.append(v0)
		out_vertices.append(v1)
		out_vertices.append(v2)
		out_vertices.append(v3)

		out_normals.append(norm)
		out_normals.append(norm)
		out_normals.append(norm)
		out_normals.append(norm)

		out_uvs.append(uv0)
		out_uvs.append(uv1)
		out_uvs.append(uv2)
		out_uvs.append(uv3)

		# Quad triangles: (V0, V1, V2) and (V0, V2, V3) (CCW outward)
		out_indices.append(start_idx)
		out_indices.append(start_idx + 1)
		out_indices.append(start_idx + 2)

		out_indices.append(start_idx)
		out_indices.append(start_idx + 2)
		out_indices.append(start_idx + 3)


## Create an ArrayMesh with two surfaces: Surface 0 = Walls, Surface 1 = Roof
static func create_building_mesh(mesh_data: Dictionary) -> ArrayMesh:
	var mesh = ArrayMesh.new()
	var walls: Dictionary = mesh_data.get("walls", {})
	var roof: Dictionary = mesh_data.get("roof", {})

	# Surface 0: Walls
	var wall_verts: PackedVector3Array = walls.get("vertices", PackedVector3Array())
	var wall_indices: PackedInt32Array = walls.get("indices", PackedInt32Array())
	if wall_verts.size() > 0 and wall_indices.size() > 0:
		var arrays = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = wall_verts
		arrays[Mesh.ARRAY_NORMAL] = walls.get("normals", PackedVector3Array())
		arrays[Mesh.ARRAY_TEX_UV] = walls.get("uvs", PackedVector2Array())
		arrays[Mesh.ARRAY_INDEX] = wall_indices
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_material(0, mesh_data.get("wall_material"))

	# Surface 1: Roof
	var roof_verts: PackedVector3Array = roof.get("vertices", PackedVector3Array())
	var roof_indices: PackedInt32Array = roof.get("indices", PackedInt32Array())
	if roof_verts.size() > 0 and roof_indices.size() > 0:
		var arrays = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = roof_verts
		arrays[Mesh.ARRAY_NORMAL] = roof.get("normals", PackedVector3Array())
		arrays[Mesh.ARRAY_TEX_UV] = roof.get("uvs", PackedVector2Array())
		arrays[Mesh.ARRAY_INDEX] = roof_indices
		var s_idx = mesh.get_surface_count()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_material(s_idx, mesh_data.get("roof_material"))

	return mesh


## Extract human-readable building name from OSM tags or POIs if present.
static func get_building_display_name(building: Dictionary) -> String:
	var tags: Dictionary = building.get("tags", {})
	if tags.has("name") and not str(tags.get("name")).strip_edges().is_empty():
		return str(tags.get("name")).strip_edges()
	if tags.has("name:en") and not str(tags.get("name:en")).strip_edges().is_empty():
		return str(tags.get("name:en")).strip_edges()
	if tags.has("addr:housename") and not str(tags.get("addr:housename")).strip_edges().is_empty():
		return str(tags.get("addr:housename")).strip_edges()
	if tags.has("brand") and not str(tags.get("brand")).strip_edges().is_empty():
		return str(tags.get("brand")).strip_edges()

	# Associated POI name if a POI node falls inside this building footprint
	if building.has("pois"):
		var pois: Array = building.get("pois", [])
		for poi in pois:
			if poi is Dictionary:
				var p_name = str(poi.get("name", "")).strip_edges()
				if p_name.is_empty():
					var p_tags: Dictionary = poi.get("tags", {})
					p_name = str(p_tags.get("name", p_tags.get("brand", ""))).strip_edges()
				if not p_name.is_empty():
					return p_name

	# Fallback to street address
	var housenumber = str(tags.get("addr:housenumber", "")).strip_edges()
	var street = str(tags.get("addr:street", "")).strip_edges()
	if not housenumber.is_empty() and not street.is_empty():
		return housenumber + " " + street
	elif not street.is_empty():
		return street
	elif not housenumber.is_empty():
		return "No. " + housenumber

	# Fallback to specific building type if not generic
	var b_type = str(tags.get("building", "")).strip_edges().to_lower()
	if (
		not b_type.is_empty()
		and b_type != "yes"
		and b_type != "no"
		and b_type != "roof"
		and b_type != "true"
	):
		return b_type.capitalize().replace("_", " ")

	return ""


## Determine a clean node name for a building model in the Godot scene hierarchy.
## Uses the building's OSM name if available, falling back to "Building_<id>".
static func get_building_node_name(building: Dictionary) -> String:
	var display_name = get_building_display_name(building)
	if not display_name.is_empty():
		return sanitize_node_name(display_name)
	return "Building_" + str(building.get("id", "unknown"))


## Sanitize a string for use as a Godot Node name (replaces invalid characters: . : @ / " %)
static func sanitize_node_name(raw_name: String) -> String:
	var cleaned = raw_name.strip_edges()
	var invalid_chars = [".", ":", "@", "/", '"', "%"]
	for c in invalid_chars:
		cleaned = cleaned.replace(c, "_")
	if cleaned.is_empty():
		return "Building"
	return cleaned


## Create a complete MeshInstance3D with optional StaticBody3D collision shape
static func create_building_node(
	building: Dictionary, create_collider: bool = true
) -> MeshInstance3D:
	var mesh_data = build_building_mesh_data(building)
	var mesh = create_building_mesh(mesh_data)

	var instance = MeshInstance3D.new()
	instance.name = get_building_node_name(building)
	instance.mesh = mesh

	# Store OSM metadata on the node for inspection, raycasting, and script access
	var tags: Dictionary = building.get("tags", {})
	var b_id = building.get("id")
	if b_id != null:
		instance.set_meta("osm_id", b_id)
	var b_name = get_building_display_name(building)
	if not b_name.is_empty():
		instance.set_meta("osm_name", b_name)
	var housenumber = str(tags.get("addr:housenumber", "")).strip_edges()
	var street = str(tags.get("addr:street", "")).strip_edges()
	if not housenumber.is_empty() and not street.is_empty():
		instance.set_meta("osm_address", housenumber + " " + street)
	elif not street.is_empty():
		instance.set_meta("osm_address", street)
	if building.has("pois") and building["pois"].size() > 0:
		instance.set_meta("osm_pois", building["pois"])
	if not tags.is_empty():
		instance.set_meta("osm_tags", tags)
	if create_collider and mesh.get_surface_count() > 0:
		var static_body = StaticBody3D.new()
		static_body.name = "StaticBody3D"
		var col_shape = CollisionShape3D.new()
		col_shape.name = "CollisionShape3D"
		col_shape.shape = mesh.create_trimesh_shape()
		static_body.add_child(col_shape)
		instance.add_child(static_body)

	return instance


## Create an extruded 2D footprint building node using Godot 4's native CSGPolygon3D.
## The building's transform is placed at its horizontal centroid and base elevation,
## with the 2D polygon defined in the local horizontal plane and extruded vertically by height.
## Inner rings (courtyards/holes) are cut using child CSGPolygon3D nodes with OPERATION_SUBTRACTION.
static func create_csg_building_node(building: Dictionary, create_collider: bool = true) -> Node3D:
	var tags: Dictionary = building.get("tags", {})
	var outer_rings: Array = building.get("outer_rings", [])
	if outer_rings.is_empty():
		return null

	var h_info = resolve_height(tags)
	var base_y: float = h_info["base_y"]
	var height: float = maxf(h_info["height"], 0.5)
	var inner_rings: Array = building.get("inner_rings", [])

	var created_nodes: Array[CSGPolygon3D] = []
	for ring_idx in range(outer_rings.size()):
		var outer_pts: PackedVector3Array = outer_rings[ring_idx]
		var n_pts = outer_pts.size()
		if n_pts < 3:
			continue
		var unique_count = n_pts
		if outer_pts[0].distance_squared_to(outer_pts[n_pts - 1]) < 0.0001:
			unique_count = n_pts - 1
		if unique_count < 3:
			continue

		var center_x: float = 0.0
		var center_z: float = 0.0
		for i in range(unique_count):
			center_x += outer_pts[i].x
			center_z += outer_pts[i].z
		center_x /= float(unique_count)
		center_z /= float(unique_count)

		var csg = CSGPolygon3D.new()
		csg.name = (
			get_building_node_name(building)
			if outer_rings.size() == 1
			else (get_building_node_name(building) + "_" + str(ring_idx))
		)
		csg.mode = CSGPolygon3D.MODE_DEPTH
		csg.depth = height
		csg.rotation_degrees = Vector3(90.0, 0.0, 0.0)
		csg.position = Vector3(center_x, base_y, center_z)

		var poly_2d = PackedVector2Array()
		poly_2d.resize(unique_count)
		for i in range(unique_count):
			var pt = outer_pts[i]
			poly_2d[i] = Vector2(pt.x - center_x, pt.z - center_z)
		csg.polygon = poly_2d

		csg.material = resolve_wall_material(tags, true)

		if create_collider:
			csg.use_collision = true
			csg.collision_layer = 1
			csg.collision_mask = 1

		# Subtracted child holes for courtyards / lightwells
		for hole_idx in range(inner_rings.size()):
			var hole_pts: PackedVector3Array = inner_rings[hole_idx]
			var h_count = hole_pts.size()
			var h_unique = h_count
			if h_count >= 3 and hole_pts[0].distance_squared_to(hole_pts[h_count - 1]) < 0.0001:
				h_unique = h_count - 1
			if h_unique >= 3:
				var hole_csg = CSGPolygon3D.new()
				hole_csg.name = "Hole_" + str(hole_idx)
				hole_csg.operation = CSGShape3D.OPERATION_SUBTRACTION
				hole_csg.mode = CSGPolygon3D.MODE_DEPTH
				hole_csg.depth = height + 2.0
				hole_csg.position = Vector3(0.0, 0.0, 1.0)
				var h_poly = PackedVector2Array()
				h_poly.resize(h_unique)
				for j in range(h_unique):
					var h_pt = hole_pts[j]
					h_poly[j] = Vector2(h_pt.x - center_x, h_pt.z - center_z)
				hole_csg.polygon = h_poly
				csg.add_child(hole_csg, true)

		# Store metadata
		var b_id = building.get("id")
		if b_id != null:
			csg.set_meta("osm_id", b_id)
		var b_name = get_building_display_name(building)
		if not b_name.is_empty():
			csg.set_meta("osm_name", b_name)
		var housenumber = str(tags.get("addr:housenumber", "")).strip_edges()
		var street = str(tags.get("addr:street", "")).strip_edges()
		if not housenumber.is_empty() and not street.is_empty():
			csg.set_meta("osm_address", housenumber + " " + street)
		elif not street.is_empty():
			csg.set_meta("osm_address", street)
		if building.has("pois") and building["pois"].size() > 0:
			csg.set_meta("osm_pois", building["pois"])
		if not tags.is_empty():
			csg.set_meta("osm_tags", tags)
		created_nodes.append(csg)

	if created_nodes.is_empty():
		return null
	if created_nodes.size() == 1:
		return created_nodes[0]

	var multi_root = Node3D.new()
	multi_root.name = get_building_node_name(building)
	for c in created_nodes:
		multi_root.add_child(c, true)
	return multi_root


## Build a root Node3D containing batched building meshes grouped by material
static func build_batched_buildings_node(buildings: Array, create_colliders: bool = true) -> Node3D:
	return build_buildings_node(buildings, create_colliders, true)


## Build a root Node3D containing all buildings.
## When batched is true, combines building meshes by material into consolidated multi-surface meshes
## to drastically reduce draw calls and node count.
## When batched is false (default), retains 1 MeshInstance3D per building.
static func build_buildings_node(
	buildings: Array, create_colliders: bool = true, batched: bool = false, use_csg: bool = false
) -> Node3D:
	var root = Node3D.new()
	root.name = "Buildings"

	if use_csg:
		for b in buildings:
			if b is Dictionary:
				var node = create_csg_building_node(b, create_colliders)
				if node != null:
					root.add_child(node, true)
		return root

	if not batched:
		for b in buildings:
			if b is Dictionary:
				var node = create_building_node(b, create_colliders)
				root.add_child(node, true)
		return root
	# Batched mode: group walls by wall material and roofs by roof material
	var wall_batches: Dictionary = {}  # mat_key -> { "material": StandardMaterial3D, "vertices": ..., "normals": ..., "uvs": ..., "indices": ... }
	var roof_batches: Dictionary = {}  # mat_key -> { "material": StandardMaterial3D, "vertices": ..., "normals": ..., "uvs": ..., "indices": ... }

	for b in buildings:
		if not (b is Dictionary):
			continue
		var m_data = build_building_mesh_data(b)
		var tags: Dictionary = b.get("tags", {})

		# 1. Accumulate walls
		var w_key = get_wall_material_key(tags)
		if not wall_batches.has(w_key):
			wall_batches[w_key] = {
				"material": m_data.get("wall_material"),
				"vertices": PackedVector3Array(),
				"normals": PackedVector3Array(),
				"uvs": PackedVector2Array(),
				"indices": PackedInt32Array()
			}
		var w_target = wall_batches[w_key]
		var w_base_idx = w_target["vertices"].size()
		var w_walls: Dictionary = m_data.get("walls", {})
		var w_v: PackedVector3Array = w_walls.get("vertices", PackedVector3Array())
		var w_n: PackedVector3Array = w_walls.get("normals", PackedVector3Array())
		var w_uv: PackedVector2Array = w_walls.get("uvs", PackedVector2Array())
		var w_idx: PackedInt32Array = w_walls.get("indices", PackedInt32Array())

		w_target["vertices"].append_array(w_v)
		w_target["normals"].append_array(w_n)
		w_target["uvs"].append_array(w_uv)
		for idx in w_idx:
			w_target["indices"].append(w_base_idx + idx)

		# 2. Accumulate roofs
		var r_key = get_roof_material_key(tags)
		if not roof_batches.has(r_key):
			roof_batches[r_key] = {
				"material": m_data.get("roof_material"),
				"vertices": PackedVector3Array(),
				"normals": PackedVector3Array(),
				"uvs": PackedVector2Array(),
				"indices": PackedInt32Array()
			}
		var r_target = roof_batches[r_key]
		var r_base_idx = r_target["vertices"].size()
		var r_roof: Dictionary = m_data.get("roof", {})
		var r_v: PackedVector3Array = r_roof.get("vertices", PackedVector3Array())
		var r_n: PackedVector3Array = r_roof.get("normals", PackedVector3Array())
		var r_uv: PackedVector2Array = r_roof.get("uvs", PackedVector2Array())
		var r_idx: PackedInt32Array = r_roof.get("indices", PackedInt32Array())

		r_target["vertices"].append_array(r_v)
		r_target["normals"].append_array(r_n)
		r_target["uvs"].append_array(r_uv)
		for idx in r_idx:
			r_target["indices"].append(r_base_idx + idx)

	# Create MeshInstance3D nodes for batched walls
	for w_key in wall_batches.keys():
		var batch = wall_batches[w_key]
		var verts: PackedVector3Array = batch["vertices"]
		var idxs: PackedInt32Array = batch["indices"]
		if verts.is_empty() or idxs.is_empty():
			continue

		var arrays = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = verts
		arrays[Mesh.ARRAY_NORMAL] = batch["normals"]
		arrays[Mesh.ARRAY_TEX_UV] = batch["uvs"]
		arrays[Mesh.ARRAY_INDEX] = idxs

		var mesh = ArrayMesh.new()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_material(0, batch["material"])

		var mi = MeshInstance3D.new()
		mi.name = "BuildingWalls_" + w_key.capitalize().replace(" ", "_")
		mi.mesh = mesh

		if create_colliders:
			var sb = StaticBody3D.new()
			sb.name = "StaticBody3D"
			var cs = CollisionShape3D.new()
			cs.name = "CollisionShape3D"
			cs.shape = mesh.create_trimesh_shape()
			sb.add_child(cs)
			mi.add_child(sb)

		root.add_child(mi)

	# Create MeshInstance3D nodes for batched roofs
	for r_key in roof_batches.keys():
		var batch = roof_batches[r_key]
		var verts: PackedVector3Array = batch["vertices"]
		var idxs: PackedInt32Array = batch["indices"]
		if verts.is_empty() or idxs.is_empty():
			continue

		var arrays = []
		arrays.resize(Mesh.ARRAY_MAX)
		arrays[Mesh.ARRAY_VERTEX] = verts
		arrays[Mesh.ARRAY_NORMAL] = batch["normals"]
		arrays[Mesh.ARRAY_TEX_UV] = batch["uvs"]
		arrays[Mesh.ARRAY_INDEX] = idxs

		var mesh = ArrayMesh.new()
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		mesh.surface_set_material(0, batch["material"])

		var mi = MeshInstance3D.new()
		mi.name = "BuildingRoofs_" + r_key.capitalize().replace(" ", "_")
		mi.mesh = mesh

		if create_colliders:
			var sb = StaticBody3D.new()
			sb.name = "StaticBody3D"
			var cs = CollisionShape3D.new()
			cs.name = "CollisionShape3D"
			cs.shape = mesh.create_trimesh_shape()
			sb.add_child(cs)
			mi.add_child(sb)

		root.add_child(mi)

	return root
