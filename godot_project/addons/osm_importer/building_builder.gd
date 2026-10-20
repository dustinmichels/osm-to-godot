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
	"brick": {
		"color": Color(0.612, 0.278, 0.220), # #9C4738
		"roughness": 0.90,
		"metallic": 0.0
	},
	"concrete": {
		"color": Color(0.690, 0.678, 0.663), # #B0ADA9
		"roughness": 0.85,
		"metallic": 0.0
	},
	"glass": {
		"color": Color(0.627, 0.769, 0.875), # #A0C4DF
		"roughness": 0.15,
		"metallic": 0.5
	},
	"plaster": {
		"color": Color(0.910, 0.886, 0.835), # #E8E2D5
		"roughness": 0.90,
		"metallic": 0.0
	},
	"wood": {
		"color": Color(0.541, 0.353, 0.212), # #8A5A36
		"roughness": 0.70,
		"metallic": 0.0
	},
	"default_wall": {
		"color": Color(0.816, 0.784, 0.722), # #D0C8B8
		"roughness": 0.80,
		"metallic": 0.0
	},
	"default_roof": {
		"color": Color(0.290, 0.271, 0.251), # #4A4540
		"roughness": 0.90,
		"metallic": 0.0
	}
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

## Sanitize and parse numeric dimensions from string tags (e.g. "15", "15m", "15.2 m", "approx 3").
static func parse_numeric_dimension(val: Variant, default_val: float = 0.0) -> float:
	if val == null:
		return default_val
	if val is float or val is int:
		return float(val)
	if not (val is String):
		return default_val
		
	var s: String = val.strip_edges()
	if s.is_empty():
		return default_val
		
	# Match floating point or integer number
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
		
	return {
		"base_y": base_y,
		"roof_y": roof_y,
		"height": roof_y - base_y
	}

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

## Generate wall StandardMaterial3D based on tags
static func resolve_wall_material(tags: Dictionary) -> StandardMaterial3D:
	var mat = StandardMaterial3D.new()
	mat.cull_mode = BaseMaterial3D.CULL_BACK
	
	var mat_name: String = str(tags.get("building:material", "")).to_lower()
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
	var col_tag = tags.get("building:colour", tags.get("colour", null))
	if col_tag != null:
		mat.albedo_color = parse_color(col_tag, mat.albedo_color)
		mat.resource_name += "_" + str(col_tag)
		
	return mat

## Generate roof StandardMaterial3D based on tags
static func resolve_roof_material(tags: Dictionary) -> StandardMaterial3D:
	var mat = StandardMaterial3D.new()
	mat.cull_mode = BaseMaterial3D.CULL_BACK
	
	var mat_name: String = str(tags.get("roof:material", "")).to_lower()
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
	var col_tag = tags.get("roof:colour", null)
	if col_tag != null:
		mat.albedo_color = parse_color(col_tag, mat.albedo_color)
		mat.resource_name += "_" + str(col_tag)
		
	return mat

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
			_extrude_wall_ring(ring, base_y, roof_y, false, wall_vertices, wall_normals, wall_uvs, wall_indices)
			
	# Inner rings: holes (CW in X, -Z plane).
	# For interior hole walls facing the courtyard/hole air:
	# Reverse ring so hole is on the right, solid wall on the left, normals face into the hole.
	for ring in inner_rings:
		if ring is PackedVector3Array and ring.size() >= 3:
			_extrude_wall_ring(ring, base_y, roof_y, true, wall_vertices, wall_normals, wall_uvs, wall_indices)
			
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
		"walls": {
			"vertices": wall_vertices,
			"normals": wall_normals,
			"uvs": wall_uvs,
			"indices": wall_indices
		},
		"roof": {
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
		pts.reverse() # Reversing CW hole makes it CCW around the hole interior
		
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

## Create a complete MeshInstance3D with optional StaticBody3D collision shape
static func create_building_node(building: Dictionary, create_collider: bool = true) -> MeshInstance3D:
	var mesh_data = build_building_mesh_data(building)
	var mesh = create_building_mesh(mesh_data)
	
	var instance = MeshInstance3D.new()
	instance.name = "Building_" + str(building.get("id", "unknown"))
	instance.mesh = mesh
	
	if create_collider and mesh.get_surface_count() > 0:
		var static_body = StaticBody3D.new()
		static_body.name = "StaticBody3D"
		var col_shape = CollisionShape3D.new()
		col_shape.name = "CollisionShape3D"
		col_shape.shape = mesh.create_trimesh_shape()
		static_body.add_child(col_shape)
		instance.add_child(static_body)
		
	return instance

## Build a root Node3D containing all buildings
static func build_buildings_node(buildings: Array, create_colliders: bool = true) -> Node3D:
	var root = Node3D.new()
	root.name = "Buildings"
	
	for b in buildings:
		if b is Dictionary:
			var node = create_building_node(b, create_colliders)
			root.add_child(node)
			
	return root
