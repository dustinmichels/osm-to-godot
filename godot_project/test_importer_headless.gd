extends SceneTree

## Automated headless test script for OSM Importer.
## Runs Godot headless importer against all fixtures in tests/fixtures/.
## Verifies vertex counts, valid AABB bounding boxes, zero NaN values, and non-empty mesh surfaces.

const OSMParserClass = preload("res://addons/osm_importer/osm_parser.gd")
const OSMSceneBuilderClass = preload("res://addons/osm_importer/scene_builder.gd")
const BuildingBuilderClass = preload("res://addons/osm_importer/building_builder.gd")
const RoadBuilderClass = preload("res://addons/osm_importer/road_builder.gd")

const FIXTURES: Array[String] = [
	"../tests/fixtures/simple_grid.json",
	"../tests/fixtures/bike_infrastructure.json",
	"../tests/fixtures/complex_buildings.json",
	"../tests/fixtures/bridge_overpass.json",
	"../tests/fixtures/sample_city_export.json",
	"../tests/fixtures/medford_y_export.json"
]

func _init() -> void:
	print("==================================================")
	print("Running OSM Importer Headless Verification Suite")
	print("==================================================")
	
	var total_tests = FIXTURES.size()
	var passed_tests = 0
	
	for fixture_path in FIXTURES:
		print("\n--- Verifying Fixture: " + fixture_path + " ---")
		var ok = verify_fixture(fixture_path)
		if ok:
			print("PASS: " + fixture_path)
			passed_tests += 1
		else:
			printerr("FAIL: " + fixture_path)
			
	print("\n--- Verifying POI & Address Fallback Naming ---")
	var naming_ok = verify_poi_and_address_naming()
	if naming_ok:
		print("PASS: POI and address fallback naming verified")
	else:
		printerr("FAIL: POI and address fallback naming verification failed")
		quit(1)
		return

	print("\n==================================================")
	if passed_tests == total_tests and naming_ok:
		print("ALL " + str(total_tests) + " FIXTURES & NAMING VERIFIED SUCCESSFULLY! (100% PASS)")
		print("==================================================")
		quit(0)
	else:
		printerr("HEADLESS VERIFICATION SUITE FAILED: " + str(total_tests - passed_tests) + " failures.")
		print("==================================================")
		quit(1)

func is_valid_aabb(aabb: AABB) -> bool:
	if is_nan(aabb.position.x) or is_nan(aabb.position.y) or is_nan(aabb.position.z):
		return false
	if is_inf(aabb.position.x) or is_inf(aabb.position.y) or is_inf(aabb.position.z):
		return false
	if is_nan(aabb.size.x) or is_nan(aabb.size.y) or is_nan(aabb.size.z):
		return false
	if is_inf(aabb.size.x) or is_inf(aabb.size.y) or is_inf(aabb.size.z):
		return false
	# Valid mesh bounding box must have non-negative size and non-zero volume/area
	if aabb.size.x < 0.0 or aabb.size.y < 0.0 or aabb.size.z < 0.0:
		return false
	if aabb.size.length_squared() <= 0.0:
		return false
	return true

func verify_fixture(fixture_path: String) -> bool:
	var parser = OSMParserClass.new()
	var parse_res = parser.parse_file(fixture_path)
	if parse_res.has("error"):
		printerr("  [FAIL] JSON parsing error: ", parse_res["error"])
		return false
		
	var roads: Array = parse_res.get("roads", [])
	var buildings: Array = parse_res.get("buildings", [])
	var pois: Array = parse_res.get("pois", [])
	print("  Parsed: roads = ", roads.size(), ", buildings = ", buildings.size(), ", pois = ", pois.size())
	
	var city_root = OSMSceneBuilderClass.build_city_scene(buildings, roads, true, false, false, 500.0, 1500.0, false, pois)
	if city_root == null:
		printerr("  [FAIL] SceneBuilder returned null root node")
		return false
	# Verify ground layer exists with PlaneMesh and grassy texture
	var ground = city_root.get_node_or_null("Ground")
	if ground == null:
		printerr("  [FAIL] Ground node missing from CityRoot")
		city_root.free()
		return false
	var ground_mesh = ground.get_node_or_null("GroundMesh") as MeshInstance3D
	if ground_mesh == null or not (ground_mesh.mesh is PlaneMesh):
		printerr("  [FAIL] GroundMesh missing or not a PlaneMesh")
		city_root.free()
		return false
	var ground_mat = ground_mesh.material_override as StandardMaterial3D
	if ground_mat == null or ground_mat.albedo_texture == null:
		printerr("  [FAIL] GroundMesh material missing or lacks grassy texture")
		city_root.free()
		return false
	var ground_col = ground.get_node_or_null("GroundCollision") as StaticBody3D
	if ground_col == null or ground_col.get_node_or_null("CollisionShape3D") == null:
		printerr("  [FAIL] Ground collider missing when create_colliders=true")
		city_root.free()
		return false

	# Find all MeshInstance3D nodes in the generated scene
	var mesh_instances: Array[MeshInstance3D] = []
	_collect_mesh_instances(city_root, mesh_instances)
	print("  Found ", mesh_instances.size(), " MeshInstance3D node(s)")
	
	if mesh_instances.is_empty() and (roads.size() > 0 or buildings.size() > 0):
		printerr("  [FAIL] Expected mesh instances but found none")
		city_root.free()
		return false
		
	var total_vertices = 0
	var total_triangles = 0
	
	for mi in mesh_instances:
		var mesh = mi.mesh
		if mesh == null:
			printerr("  [FAIL] MeshInstance3D has null mesh: ", mi.name)
			city_root.free()
			return false
			
		var surf_count = mesh.get_surface_count()
		if surf_count == 0:
			printerr("  [FAIL] Mesh has zero surfaces: ", mi.name)
			city_root.free()
			return false
			
		# Check AABB
		var aabb = mi.get_aabb()
		if not is_valid_aabb(aabb):
			printerr("  [FAIL] Invalid/NaN AABB on node: ", mi.name, " -> ", aabb)
			city_root.free()
			return false
			
		for s in range(surf_count):
			var arrays = mesh.surface_get_arrays(s)
			var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var normals: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]
			var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			
			if verts.is_empty():
				printerr("  [FAIL] Empty vertex array on surface ", s, " of ", mi.name)
				city_root.free()
				return false
				
			total_vertices += verts.size()
			if not indices.is_empty():
				total_triangles += indices.size() / 3
				
			# Check zero NaN values in vertices and normals
			for v in verts:
				if is_nan(v.x) or is_nan(v.y) or is_nan(v.z) or is_inf(v.x) or is_inf(v.y) or is_inf(v.z):
					printerr("  [FAIL] NaN/Inf detected in vertex array of ", mi.name)
					city_root.free()
					return false
					
			if not normals.is_empty():
				for n in normals:
					if is_nan(n.x) or is_nan(n.y) or is_nan(n.z) or is_inf(n.x) or is_inf(n.y) or is_inf(n.z):
						printerr("  [FAIL] NaN/Inf detected in normal array of ", mi.name)
						city_root.free()
						return false
						
	print("  Verification: total vertices = ", total_vertices, ", triangles = ", total_triangles, ", zero NaNs, valid AABBs")
	city_root.free()
	# Also verify CSG building scene generation
	if buildings.size() > 0:
		var csg_city = OSMSceneBuilderClass.build_city_scene(buildings, roads, true, false, false, 500.0, 1500.0, true)
		if csg_city == null:
			printerr("  [FAIL] SceneBuilder returned null root node for CSG mode")
			return false
		var csg_nodes: Array[CSGPolygon3D] = []
		_collect_csg_instances(csg_city, csg_nodes)
		if csg_nodes.is_empty():
			printerr("  [FAIL] Expected CSGPolygon3D nodes but found none")
			csg_city.free()
			return false
		print("  CSG Mode Verification: found ", csg_nodes.size(), " CSGPolygon3D node(s)")
		csg_city.free()

	return true

func _collect_mesh_instances(node: Node, out_list: Array[MeshInstance3D]) -> void:
	if node is MeshInstance3D:
		out_list.append(node)
	for child in node.get_children():
		_collect_mesh_instances(child, out_list)

func _collect_csg_instances(node: Node, out_list: Array[CSGPolygon3D]) -> void:
	if node is CSGPolygon3D:
		out_list.append(node)
	for child in node.get_children():
		_collect_csg_instances(child, out_list)
func verify_poi_and_address_naming() -> bool:
	var parser = OSMParserClass.new()
	var parse_res = parser.parse_file("../tests/fixtures/medford_y_export.json")
	if parse_res.has("error"):
		printerr("  [FAIL] Could not load medford_y_export.json: ", parse_res["error"])
		return false

	var pois: Array = parse_res.get("pois", [])
	if pois.size() != 9:
		printerr("  [FAIL] Expected 9 POIs in medford_y_export, got: ", pois.size())
		return false
	print("  Extracted ", pois.size(), " POI nodes.")

	var buildings: Array = parse_res.get("buildings", [])
	var b_root = BuildingBuilderClass.build_buildings_node(buildings, true, false, false)
	if b_root == null:
		printerr("  [FAIL] Failed to build buildings node")
		return false

	var found_names: Dictionary = {}
	for child in b_root.get_children():
		found_names[child.name] = true

	# Check Dunkin' (named directly in OSM)
	if not found_names.has("Dunkin'"):
		printerr("  [FAIL] Missing 'Dunkin'' building node")
		b_root.free()
		return false

	# Check POI fallback: 7-Eleven
	if not found_names.has("7-Eleven"):
		printerr("  [FAIL] Missing '7-Eleven' building node (from POI)")
		b_root.free()
		return false

	# Check POI fallback: Circle K
	if not found_names.has("Circle K"):
		printerr("  [FAIL] Missing 'Circle K' building node (from POI)")
		b_root.free()
		return false

	# Check address fallback: 9 Emerson Street
	if not found_names.has("9 Emerson Street"):
		printerr("  [FAIL] Missing '9 Emerson Street' building node (from address)")
		b_root.free()
		return false

	# Check address fallback: 20 Thomas Street
	if not found_names.has("20 Thomas Street"):
		printerr("  [FAIL] Missing '20 Thomas Street' building node (from address)")
		b_root.free()
		return false

	# Check metadata on 7-Eleven node
	var seven_eleven = b_root.get_node_or_null("7-Eleven") as MeshInstance3D
	if seven_eleven == null or not seven_eleven.has_meta("osm_name"):
		printerr("  [FAIL] Missing osm_name metadata on 7-Eleven node")
		b_root.free()
		return false

	print("  Verified building names: Dunkin', 7-Eleven, Circle K, 9 Emerson Street, 20 Thomas Street.")
	b_root.free()

	# Also verify SceneBuilder creates POIs group with Marker3D children
	var city_root = OSMSceneBuilderClass.build_city_scene(buildings, [], false, false, false, 500.0, 1500.0, false, pois)
	var pois_node = city_root.get_node_or_null("POIs")
	if pois_node == null or pois_node.get_child_count() != 9:
		printerr("  [FAIL] Expected POIs node with 9 Marker3D children in CityRoot")
		city_root.free()
		return false
	print("  Verified SceneBuilder POIs node with 9 children.")
	city_root.free()

	return true
