extends SceneTree

const OSMProj = preload("res://addons/osm_importer/projection.gd")
const OSMParse = preload("res://addons/osm_importer/osm_parser.gd")
const EarcutModule = preload("res://addons/osm_importer/earcut.gd")
const BldBuilder = preload("res://addons/osm_importer/building_builder.gd")

func _init() -> void:
	print("========================================")
	print("Running OSM Importer Phase 3 Test Suite")
	print("========================================")
	
	var passed = true
	passed = test_height_inference() and passed
	passed = test_earcut_triangulation() and passed
	passed = test_materials_and_colors() and passed
	passed = test_wall_extrusion_and_normals() and passed
	passed = test_full_building_generation() and passed
	passed = test_building_naming() and passed
	passed = test_csg_building_generation() and passed
	if passed:
		print("========================================")
		print("ALL PHASE 3 TESTS PASSED!")
		print("========================================")
		quit(0)
	else:
		print("========================================")
		printerr("PHASE 3 TESTS FAILED!")
		print("========================================")
		quit(1)

func test_height_inference() -> bool:
	print("\n--- Test 3.1: Building Height & Level Inference ---")
	
	# Explicit height with clean and messy units
	var h1 = BldBuilder.resolve_height({"height": "15"})
	if abs(h1.roof_y - 15.0) > 0.01:
		printerr("FAIL: Expected 15.0m for height='15', got: ", h1)
		return false
		
	var h2 = BldBuilder.resolve_height({"height": "15.2 m"})
	if abs(h2.roof_y - 15.2) > 0.01:
		printerr("FAIL: Expected 15.2m for height='15.2 m', got: ", h2)
		return false
		
	# Levels tag: levels * 3.3m
	var h3 = BldBuilder.resolve_height({"building:levels": "4"})
	if abs(h3.roof_y - 13.2) > 0.01:
		printerr("FAIL: Expected 13.2m for 4 levels, got: ", h3)
		return false
		
	# Semantic classifications
	var h_apartments = BldBuilder.resolve_height({"building": "apartments"})
	if abs(h_apartments.roof_y - 14.0) > 0.01:
		printerr("FAIL: Expected 14.0m for apartments, got: ", h_apartments)
		return false
		
	var h_house = BldBuilder.resolve_height({"building": "house"})
	if abs(h_house.roof_y - 7.0) > 0.01:
		printerr("FAIL: Expected 7.0m for house, got: ", h_house)
		return false
		
	var h_supermarket = BldBuilder.resolve_height({"building": "supermarket"})
	if abs(h_supermarket.roof_y - 5.5) > 0.01:
		printerr("FAIL: Expected 5.5m for supermarket, got: ", h_supermarket)
		return false
		
	var h_garage = BldBuilder.resolve_height({"building": "garage"})
	if abs(h_garage.roof_y - 3.0) > 0.01:
		printerr("FAIL: Expected 3.0m for garage, got: ", h_garage)
		return false
		
	var h_yes = BldBuilder.resolve_height({"building": "yes"})
	if abs(h_yes.roof_y - 8.0) > 0.01:
		printerr("FAIL: Expected 8.0m for fallback 'yes', got: ", h_yes)
		return false
		
	# Elevated base: min_height & building:min_level
	var h_elev = BldBuilder.resolve_height({"min_height": "5.0", "building:levels": "3"})
	# roof_y should be base_y (5.0) + height (3 * 3.3 = 9.9) = 14.9m
	if abs(h_elev.base_y - 5.0) > 0.01 or abs(h_elev.roof_y - 14.9) > 0.01:
		printerr("FAIL: Expected base_y=5.0, roof_y=14.9, got: ", h_elev)
		return false
		
	var h_elev_lvl = BldBuilder.resolve_height({"building:min_level": "2", "building": "commercial"})
	# base_y = 2 * 3.3 = 6.6, roof_y = 6.6 + 14.0 = 20.6
	if abs(h_elev_lvl.base_y - 6.6) > 0.01 or abs(h_elev_lvl.roof_y - 20.6) > 0.01:
		printerr("FAIL: Expected base_y=6.6, roof_y=20.6, got: ", h_elev_lvl)
		return false
		
	print("Height inference tests passed!")
	return true

func test_earcut_triangulation() -> bool:
	print("\n--- Test 3.2: Earcut 2D & 3D Triangulation ---")
	
	# Test 1: Simple quad
	var quad = PackedVector2Array([
		Vector2(0, 0), Vector2(10, 0), Vector2(10, 10), Vector2(0, 10)
	])
	var res_quad = EarcutModule.triangulate_polygon_2d(quad)
	var idxs = res_quad.indices
	if idxs.size() != 6:
		printerr("FAIL: Quad expected 6 indices (2 triangles), got: ", idxs.size())
		return false
		
	# Verify area of quad
	var quad_area = _calc_indexed_area_2d(res_quad.points, idxs)
	if abs(quad_area - 100.0) > 0.01:
		printerr("FAIL: Quad area expected 100.0, got: ", quad_area)
		return false
		
	# Test 2: Quad with hole (courtyard)
	var hole = PackedVector2Array([
		Vector2(3, 3), Vector2(3, 7), Vector2(7, 7), Vector2(7, 3)
	])
	var res_hole = EarcutModule.triangulate_polygon_2d(quad, [hole])
	var hole_area = _calc_indexed_area_2d(res_hole.points, res_hole.indices)
	print("Quad with hole triangulated area: ", hole_area)
	# Expected area = 100 - 16 = 84
	if abs(hole_area - 84.0) > 0.01:
		printerr("FAIL: Quad with hole area expected 84.0, got: ", hole_area)
		return false
		
	# Test 3: 3D Triangulation with upward normals
	var quad_3d = PackedVector3Array([
		Vector3(0, 0, 0), Vector3(10, 0, 0), Vector3(10, 0, -10), Vector3(0, 0, -10), Vector3(0, 0, 0)
	])
	var res_3d = EarcutModule.triangulate_polygon_3d(quad_3d, [], 15.0)
	var pts_3d: PackedVector3Array = res_3d.points
	var idx_3d: PackedInt32Array = res_3d.indices
	
	if idx_3d.size() != 6:
		printerr("FAIL: Expected 6 indices for 3D quad, got: ", idx_3d.size())
		return false
		
	# Verify vertices have Y = 15.0
	for p in pts_3d:
		if abs(p.y - 15.0) > 0.001:
			printerr("FAIL: Roof vertex Y expected 15.0, got: ", p)
			return false
			
	# Verify normal of each triangle points strictly Up (+Y)
	for t in range(0, idx_3d.size(), 3):
		var v0 = pts_3d[idx_3d[t]]
		var v1 = pts_3d[idx_3d[t + 1]]
		var v2 = pts_3d[idx_3d[t + 2]]
		var n = (v1 - v0).cross(v2 - v0).normalized()
		if n.y <= 0.99:
			printerr("FAIL: Roof triangle normal must point strictly Up (+Y), got: ", n)
			return false
			
	print("Earcut triangulation tests passed!")
	return true

func test_materials_and_colors() -> bool:
	print("\n--- Test 3.3: Materials & Color Mapping ---")
	
	# Wall material presets
	var mat_brick = BldBuilder.resolve_wall_material({"building:material": "brick"})
	if mat_brick.roughness < 0.85:
		printerr("FAIL: Brick roughness mismatch: ", mat_brick.roughness)
		return false
		
	var mat_glass = BldBuilder.resolve_wall_material({"building:material": "glass"})
	if mat_glass.metallic < 0.4 or mat_glass.roughness > 0.2:
		printerr("FAIL: Glass material mismatch: ", mat_glass)
		return false
		
	# Color parsing: Hex and named CSS
	var mat_red = BldBuilder.resolve_wall_material({"building:colour": "#FF0000"})
	if mat_red.albedo_color.r < 0.99 or mat_red.albedo_color.g > 0.01:
		printerr("FAIL: Wall red color parsing mismatch: ", mat_red.albedo_color)
		return false
		
	var mat_blue = BldBuilder.resolve_wall_material({"building:colour": "blue"})
	if mat_blue.albedo_color.b < 0.99:
		printerr("FAIL: Wall blue color parsing mismatch: ", mat_blue.albedo_color)
		return false
		
	var mat_alias = BldBuilder.resolve_wall_material({"building:colour": "terracotta"})
	if abs(mat_alias.albedo_color.r - 0.886) > 0.05:
		printerr("FAIL: Color alias terracotta mismatch: ", mat_alias.albedo_color)
		return false
		
	# Roof materials
	var mat_roof_col = BldBuilder.resolve_roof_material({"roof:colour": "#112233"})
	if abs(mat_roof_col.albedo_color.r - 0.066) > 0.02:
		printerr("FAIL: Roof color parsing mismatch: ", mat_roof_col.albedo_color)
		return false
		
	print("Materials and color mapping tests passed!")
	return true

func test_wall_extrusion_and_normals() -> bool:
	print("\n--- Test 3.4: Wall Extrusion & Normals ---")
	
	# Test a simple 10x10 square building: (0,0) to (10,-10) in Godot XZ
	# Winding CCW on (X, -Z): (0, 0, 0) -> (10, 0, 0) -> (10, 0, -10) -> (0, 0, -10) -> (0, 0, 0)
	var square_ring = PackedVector3Array([
		Vector3(0, 0, 0),
		Vector3(10, 0, 0),
		Vector3(10, 0, -10),
		Vector3(0, 0, -10),
		Vector3(0, 0, 0)
	])
	
	var b_data = {
		"id": 9999,
		"tags": {
			"building": "commercial",
			"height": "10"
		},
		"outer_rings": [square_ring],
		"inner_rings": []
	}
	
	var mesh_data = BldBuilder.build_building_mesh_data(b_data)
	var walls = mesh_data.walls
	var wall_verts = walls.vertices
	var wall_norms = walls.normals
	var wall_uvs = walls.uvs
	var wall_idxs = walls.indices
	
	# 4 segments * 4 verts per quad = 16 vertices
	if wall_verts.size() != 16:
		printerr("FAIL: Expected 16 wall vertices, got: ", wall_verts.size())
		return false
		
	# 4 segments * 2 triangles * 3 indices = 24 indices
	if wall_idxs.size() != 24:
		printerr("FAIL: Expected 24 wall indices, got: ", wall_idxs.size())
		return false
		
	# Check outward-facing normals for the 4 sides:
	# Segment 0: (0,0,0) -> (10,0,0) (Eastwards) -> Normal should point South (+Z)
	var n0 = wall_norms[0]
	print("Segment 0 (East) normal: ", n0)
	if n0.distance_to(Vector3(0, 0, 1)) > 0.01:
		printerr("FAIL: Segment 0 normal expected (0, 0, 1), got: ", n0)
		return false
		
	# Segment 1: (10,0,0) -> (10,0,-10) (Northwards) -> Normal should point East (+X)
	var n1 = wall_norms[4]
	print("Segment 1 (North) normal: ", n1)
	if n1.distance_to(Vector3(1, 0, 0)) > 0.01:
		printerr("FAIL: Segment 1 normal expected (1, 0, 0), got: ", n1)
		return false
		
	# Segment 2: (10,0,-10) -> (0,0,-10) (Westwards) -> Normal should point North (-Z)
	var n2 = wall_norms[8]
	print("Segment 2 (West) normal: ", n2)
	if n2.distance_to(Vector3(0, 0, -1)) > 0.01:
		printerr("FAIL: Segment 2 normal expected (0, 0, -1), got: ", n2)
		return false
		
	# Segment 3: (0,0,-10) -> (0,0,0) (Southwards) -> Normal should point West (-X)
	var n3 = wall_norms[12]
	print("Segment 3 (South) normal: ", n3)
	if n3.distance_to(Vector3(-1, 0, 0)) > 0.01:
		printerr("FAIL: Segment 3 normal expected (-1, 0, 0), got: ", n3)
		return false
		
	# Check UV elevation and accumulation
	# Quad 0 V should be 0 at bottom, 10 at top
	var uv0 = wall_uvs[0]
	var uv2 = wall_uvs[2]
	if uv0.y != 0.0 or uv2.y != 10.0:
		printerr("FAIL: Wall UV elevation mismatch: ", uv0, " vs ", uv2)
		return false
	if uv0.x != 0.0 or abs(uv2.x - 10.0) > 0.01:
		printerr("FAIL: Wall UV cumulative U mismatch: ", uv0, " vs ", uv2)
		return false
		
	# Check triangle winding: front face normal calculated from vertices should match outward normal
	for t in range(0, wall_idxs.size(), 3):
		var v0 = wall_verts[wall_idxs[t]]
		var v1 = wall_verts[wall_idxs[t + 1]]
		var v2 = wall_verts[wall_idxs[t + 2]]
		var tri_norm = (v1 - v0).cross(v2 - v0).normalized()
		var assigned_norm = wall_norms[wall_idxs[t]]
		if tri_norm.dot(assigned_norm) < 0.9:
			printerr("FAIL: Triangle front-face normal mismatch with wall normal: ", tri_norm, " vs ", assigned_norm)
			return false
			
	print("Wall extrusion and normal tests passed!")
	return true

func test_full_building_generation() -> bool:
	print("\n--- Test 3.5: Full Building Generation with Fixture ---")
	
	var fixture_path = "../tests/fixtures/sample_city_export.json"
	var file = FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		fixture_path = "res://../tests/fixtures/sample_city_export.json"
		file = FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		printerr("FAIL: Could not open fixture file: ", fixture_path)
		return false
		
	var json_str = file.get_as_text()
	file.close()
	
	var parser = OSMParse.new()
	var parsed = parser.parse_json_string(json_str)
	var buildings: Array = parsed.buildings
	
	if buildings.size() != 2:
		printerr("FAIL: Expected 2 buildings in fixture, got: ", buildings.size())
		return false
		
	var buildings_root = BldBuilder.build_buildings_node(buildings, true)
	if buildings_root.get_child_count() != 2:
		printerr("FAIL: Buildings root child count expected 2, got: ", buildings_root.get_child_count())
		return false
		
	for child in buildings_root.get_children():
		var mi = child as MeshInstance3D
		if mi == null:
			printerr("FAIL: Child is not a MeshInstance3D: ", child)
			return false
		var mesh = mi.mesh as ArrayMesh
		if mesh == null:
			printerr("FAIL: Missing ArrayMesh on ", child.name)
			return false
		if mesh.get_surface_count() != 2:
			printerr("FAIL: Expected 2 surfaces (Walls + Roof), got: ", mesh.get_surface_count())
			return false
		# Check StaticBody collider
		var body = mi.get_node_or_null("StaticBody3D")
		if body == null:
			printerr("FAIL: Missing StaticBody3D collider on ", child.name)
			return false
		print("Successfully generated building node: ", mi.name, " with 2 surfaces and collider.")
		
	buildings_root.free()
	print("Full building generation tests passed!")
	return true

func test_building_naming() -> bool:
	print("\n--- Test 3.6: Building Model Naming from OSM Tags ---")
	
	var ring = PackedVector3Array([
		Vector3(0, 0, 0),
		Vector3(10, 0, 0),
		Vector3(10, 0, 10),
		Vector3(0, 0, 10),
		Vector3(0, 0, 0)
	])
	
	# 1. Building with explicit name
	var bld_named = {
		"id": 29729595,
		"tags": {
			"building": "yes",
			"name": "Dunkin'",
			"amenity": "fast_food"
		},
		"outer_rings": [ring],
		"inner_rings": []
	}
	var node_named = BldBuilder.create_building_node(bld_named, false)
	if str(node_named.name) != "Dunkin'":
		printerr("FAIL: Expected node name 'Dunkin'', got: ", node_named.name)
		node_named.free()
		return false
	if node_named.get_meta("osm_name", "") != "Dunkin'":
		printerr("FAIL: Expected osm_name metadata 'Dunkin'', got: ", node_named.get_meta("osm_name", ""))
		node_named.free()
		return false
	if node_named.get_meta("osm_id", 0) != 29729595:
		printerr("FAIL: Expected osm_id metadata 29729595, got: ", node_named.get_meta("osm_id", 0))
		node_named.free()
		return false
	node_named.free()
	print("Named building verified: Dunkin'")
	
	# 2. Building without name (fallback to Building_<id>)
	var bld_unnamed = {
		"id": 12345,
		"tags": {
			"building": "residential"
		},
		"outer_rings": [ring],
		"inner_rings": []
	}
	var node_unnamed = BldBuilder.create_building_node(bld_unnamed, false)
	if str(node_unnamed.name) != "Building_12345":
		printerr("FAIL: Expected node name 'Building_12345', got: ", node_unnamed.name)
		node_unnamed.free()
		return false
	if node_unnamed.has_meta("osm_name"):
		printerr("FAIL: Unnamed building should not have osm_name meta")
		node_unnamed.free()
		return false
	node_unnamed.free()
	print("Unnamed building fallback verified: Building_12345")
	
	# 3. Name sanitization of invalid characters (. : @ / " %)
	var bld_special = {
		"id": 999,
		"tags": {
			"building": "commercial",
			"name": "Cafe / Bar: Special @100% \"Express\""
		},
		"outer_rings": [ring],
		"inner_rings": []
	}
	var node_special = BldBuilder.create_building_node(bld_special, false)
	var s_name = str(node_special.name)
	for invalid_c in [":", "@", "/", "\"", "%"]:
		if invalid_c in s_name:
			printerr("FAIL: Node name contains unsanitized char '", invalid_c, "': ", s_name)
			node_special.free()
			return false
	print("Sanitized building name verified: ", s_name)
	node_special.free()
	
	# 4. Fallback to addr:housename or brand
	var bld_brand = {
		"id": 777,
		"tags": {
			"building": "retail",
			"brand": "Target"
		},
		"outer_rings": [ring],
		"inner_rings": []
	}
	var node_brand = BldBuilder.create_building_node(bld_brand, false)
	if str(node_brand.name) != "Target":
		printerr("FAIL: Expected brand fallback 'Target', got: ", node_brand.name)
		node_brand.free()
		return false
	node_brand.free()
	print("Brand fallback name verified: Target")
	
	# 5. Unique sibling names when adding multiple buildings with identical names
	var root = BldBuilder.build_buildings_node([bld_named, bld_named], false, false)
	if root.get_child_count() != 2:
		printerr("FAIL: Expected 2 children in root, got: ", root.get_child_count())
		root.free()
		return false
	var child1_name = str(root.get_child(0).name)
	var child2_name = str(root.get_child(1).name)
	if child1_name == child2_name:
		printerr("FAIL: Sibling building nodes have duplicate names: ", child1_name)
		root.free()
		return false
	print("Sibling unique naming verified: ", child1_name, " and ", child2_name)
	root.free()
	
	print("Building naming tests passed!")
	return true

func test_csg_building_generation() -> bool:
	print("\n--- Test 3.7: CSGPolygon3D 2D Footprint Extrusion ---")
	
	# Simple rectangular building
	var simple_bld = {
		"id": 9001,
		"tags": {"building": "residential", "name": "Townhouse A", "building:levels": "2"},
		"outer_rings": [
			PackedVector3Array([
				Vector3(10.0, 0.0, 20.0),
				Vector3(20.0, 0.0, 20.0),
				Vector3(20.0, 0.0, 30.0),
				Vector3(10.0, 0.0, 30.0),
				Vector3(10.0, 0.0, 20.0)
			])
		],
		"inner_rings": []
	}
	
	var csg_node = BldBuilder.create_csg_building_node(simple_bld, true)
	if csg_node == null:
		printerr("FAIL: create_csg_building_node returned null")
		return false
	if not (csg_node is CSGPolygon3D):
		printerr("FAIL: Expected CSGPolygon3D, got: ", csg_node.get_class())
		csg_node.free()
		return false
	var csg = csg_node as CSGPolygon3D
	
	# Verify name and metadata
	if csg.name != "Townhouse A":
		printerr("FAIL: Expected name 'Townhouse A', got: ", csg.name)
		csg.free()
		return false
	if csg.get_meta("osm_id") != 9001:
		printerr("FAIL: Expected osm_id meta 9001, got: ", csg.get_meta("osm_id"))
		csg.free()
		return false
		
	# Verify mode, depth, and collision
	if csg.mode != CSGPolygon3D.MODE_DEPTH:
		printerr("FAIL: Expected CSG mode MODE_DEPTH, got: ", csg.mode)
		csg.free()
		return false
	if abs(csg.depth - (2 * 3.3)) > 0.01:
		printerr("FAIL: Expected depth 6.6, got: ", csg.depth)
		csg.free()
		return false
	if not csg.use_collision:
		printerr("FAIL: Expected use_collision true")
		csg.free()
		return false
	if csg.polygon.size() != 4:
		printerr("FAIL: Expected 4 unique polygon vertices, got: ", csg.polygon.size())
		csg.free()
		return false
	# Centroid position
	if abs(csg.position.x - 15.0) > 0.01 or abs(csg.position.z - 25.0) > 0.01:
		printerr("FAIL: Expected centroid at (15, 0, 25), got: ", csg.position)
		csg.free()
		return false
	csg.free()
	print("Verified simple CSGPolygon3D building extrusion.")
	
	# Building with courtyard / inner ring
	var courtyard_bld = {
		"id": 9002,
		"tags": {"building": "apartments", "height": "12"},
		"outer_rings": [
			PackedVector3Array([
				Vector3(0.0, 0.0, 0.0),
				Vector3(30.0, 0.0, 0.0),
				Vector3(30.0, 0.0, 30.0),
				Vector3(0.0, 0.0, 30.0),
				Vector3(0.0, 0.0, 0.0)
			])
		],
		"inner_rings": [
			PackedVector3Array([
				Vector3(10.0, 0.0, 10.0),
				Vector3(20.0, 0.0, 10.0),
				Vector3(20.0, 0.0, 20.0),
				Vector3(10.0, 0.0, 20.0),
				Vector3(10.0, 0.0, 10.0)
			])
		]
	}
	var hole_node = BldBuilder.create_csg_building_node(courtyard_bld, true)
	if hole_node.get_child_count() != 1:
		printerr("FAIL: Expected 1 child hole in CSG building, got: ", hole_node.get_child_count())
		hole_node.free()
		return false
	var hole_child = hole_node.get_child(0) as CSGPolygon3D
	if hole_child.operation != CSGShape3D.OPERATION_SUBTRACTION:
		printerr("FAIL: Expected child hole operation SUBTRACTION, got: ", hole_child.operation)
		hole_node.free()
		return false
	hole_node.free()
	print("Verified CSG building with subtracted courtyard hole.")
	
	# Verify build_buildings_node with use_csg = true
	var csg_root = BldBuilder.build_buildings_node([simple_bld, courtyard_bld], true, false, true)
	if csg_root.get_child_count() != 2:
		printerr("FAIL: Expected 2 children in csg_root, got: ", csg_root.get_child_count())
		csg_root.free()
		return false
	for child in csg_root.get_children():
		if not (child is CSGPolygon3D):
			printerr("FAIL: Root child is not CSGPolygon3D: ", child.get_class())
			csg_root.free()
			return false
	csg_root.free()
	print("Verified build_buildings_node with use_csg=true.")
	
	print("CSG building generation tests passed!")
	return true

func _calc_indexed_area_2d(points: PackedVector2Array, indices: PackedInt32Array) -> float:
	var total = 0.0
	for t in range(0, indices.size(), 3):
		var a = points[indices[t]]
		var b = points[indices[t + 1]]
		var c = points[indices[t + 2]]
		total += abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * 0.5
	return total
