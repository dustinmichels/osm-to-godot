extends SceneTree

const OSMParse = preload("res://addons/osm_importer/osm_parser.gd")
const SceneBuilder = preload("res://addons/osm_importer/scene_builder.gd")
const BuildingBuilder = preload("res://addons/osm_importer/building_builder.gd")
func _init() -> void:
	print("========================================")
	print("Running OSM Importer Phase 5 Test Suite")
	print("========================================")

	var passed = true
	passed = test_scene_construction_and_serialization() and passed
	passed = test_base_pbr_materials() and passed
	passed = test_triplanar_wall_mapping() and passed
	if passed:
		print("========================================")
		print("ALL PHASE 5 TESTS PASSED!")
		print("========================================")
		quit(0)
	else:
		print("========================================")
		printerr("PHASE 5 TESTS FAILED!")
		print("========================================")
		quit(1)

func test_scene_construction_and_serialization() -> bool:
	print("\n--- Test 5.1: Complete 3D City Scene Generation & Serialization ---")

	var fixture_path = "res://data/osm_export.json"
	var file = FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		fixture_path = "../tests/fixtures/sample_city_export.json"
		file = FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		printerr("FAIL: Could not open test data file")
		return false

	var json_str = file.get_as_text()
	file.close()

	var parser = OSMParse.new()
	var parsed = parser.parse_json_string(json_str)
	var buildings: Array = parsed.get("buildings", [])

	if buildings.is_empty():
		printerr("FAIL: No buildings parsed from ", fixture_path)
		return false

	print("Parsed ", buildings.size(), " buildings for scene test.")

	# 1. Build hierarchy
	var city_root = SceneBuilder.build_city_scene(buildings, parsed.get("roads", []), true)
	if city_root == null or city_root.name != "CityRoot":
		printerr("FAIL: CityRoot node missing or named incorrectly")
		return false

	# 2. Check essential sub-nodes
	var env_node = city_root.get_node_or_null("WorldEnvironment") as WorldEnvironment
	if env_node == null or env_node.environment == null:
		printerr("FAIL: Missing WorldEnvironment or Environment resource")
		return false

	var sun_node = city_root.get_node_or_null("DirectionalLight3D") as DirectionalLight3D
	if sun_node == null or not sun_node.shadow_enabled:
		printerr("FAIL: Missing DirectionalLight3D or shadows disabled")
		return false

	var cam_node = city_root.get_node_or_null("Camera3D") as Camera3D
	if cam_node == null or not cam_node.current:
		printerr("FAIL: Missing Camera3D or not marked current")
		return false

	var bld_node = city_root.get_node_or_null("Buildings") as Node3D
	if bld_node == null or bld_node.get_child_count() != buildings.size():
		printerr("FAIL: Buildings node missing or child count mismatch: ", bld_node.get_child_count(), " vs ", buildings.size())
		return false

	print("Hierarchy validated: WorldEnvironment, Sun, Camera, and ", bld_node.get_child_count(), " buildings verified.")

	# 3. Test saving to disk
	var test_path = "res://city_viewer.tscn"
	var err = SceneBuilder.save_city_scene(city_root, test_path)
	if err != OK:
		printerr("FAIL: Failed to save city scene: ", err)
		return false

	city_root.free()

	# 4. Test loading back and verifying serialized hierarchy
	var loaded_scene: PackedScene = load(test_path)
	if loaded_scene == null:
		printerr("FAIL: Failed to load saved scene from ", test_path)
		return false

	var loaded_root = loaded_scene.instantiate() as Node3D
	if loaded_root == null:
		printerr("FAIL: Loaded root is null")
		return false

	var loaded_blds = loaded_root.get_node_or_null("Buildings") as Node3D
	if loaded_blds == null or loaded_blds.get_child_count() != buildings.size():
		printerr("FAIL: Loaded buildings child count mismatch: ", loaded_blds.get_child_count() if loaded_blds else "null")
		return false

	# Check sample building in loaded scene
	var sample_bld = loaded_blds.get_child(0) as MeshInstance3D
	if sample_bld == null or sample_bld.mesh == null or sample_bld.mesh.get_surface_count() == 0:
		printerr("FAIL: Sample building missing mesh or surfaces in loaded scene")
		return false

	var sample_col = sample_bld.get_node_or_null("StaticBody3D")
	if sample_col == null:
		printerr("FAIL: Sample building missing collider in loaded scene")
		return false

	print("Successfully loaded and verified serialized scene with ", loaded_blds.get_child_count(), " buildings and colliders.")
	loaded_root.free()

	print("Scene construction and serialization tests passed!")
	return true
func test_base_pbr_materials() -> bool:
	print("\n--- Test 5.3: Base StandardMaterial3D Resources ---")
	
	# 1. asphalt_road.tres
	var mat_asphalt = load("res://materials/asphalt_road.tres") as StandardMaterial3D
	if mat_asphalt == null:
		printerr("FAIL: Could not load res://materials/asphalt_road.tres")
		return false
	if abs(mat_asphalt.albedo_color.r - Color("#2A2A2A").r) > 0.02 or abs(mat_asphalt.roughness - 0.85) > 0.02:
		printerr("FAIL: asphalt_road albedo/roughness mismatch: ", mat_asphalt.albedo_color, " roughness: ", mat_asphalt.roughness)
		return false
	if not mat_asphalt.normal_enabled or mat_asphalt.normal_texture == null:
		printerr("FAIL: asphalt_road missing normal map")
		return false
		
	# 2. bike_lane.tres
	var mat_bike = load("res://materials/bike_lane.tres") as StandardMaterial3D
	if mat_bike == null:
		printerr("FAIL: Could not load res://materials/bike_lane.tres")
		return false
	var is_emerald = abs(mat_bike.albedo_color.r - Color("#206B42").r) < 0.02 and abs(mat_bike.albedo_color.g - Color("#206B42").g) < 0.02
	var is_brick_red = abs(mat_bike.albedo_color.r - Color("#9E382B").r) < 0.02
	if not (is_emerald or is_brick_red) or abs(mat_bike.roughness - 0.75) > 0.02:
		printerr("FAIL: bike_lane albedo/roughness mismatch: ", mat_bike.albedo_color, " roughness: ", mat_bike.roughness)
		return false
		
	# 3. concrete_sidewalk.tres
	var mat_sidewalk = load("res://materials/concrete_sidewalk.tres") as StandardMaterial3D
	if mat_sidewalk == null:
		printerr("FAIL: Could not load res://materials/concrete_sidewalk.tres")
		return false
	if abs(mat_sidewalk.albedo_color.r - Color("#7F7F7F").r) > 0.02 or abs(mat_sidewalk.roughness - 0.90) > 0.02:
		printerr("FAIL: concrete_sidewalk albedo/roughness mismatch: ", mat_sidewalk.albedo_color, " roughness: ", mat_sidewalk.roughness)
		return false
		
	# 4. building_wall_default.tres
	var mat_wall = load("res://materials/building_wall_default.tres") as StandardMaterial3D
	if mat_wall == null:
		printerr("FAIL: Could not load res://materials/building_wall_default.tres")
		return false
	if abs(mat_wall.albedo_color.r - Color("#D0C8B8").r) > 0.02 or abs(mat_wall.roughness - 0.80) > 0.02:
		printerr("FAIL: building_wall_default albedo/roughness mismatch: ", mat_wall.albedo_color, " roughness: ", mat_wall.roughness)
		return false
		
	# 5. building_roof_default.tres
	var mat_roof = load("res://materials/building_roof_default.tres") as StandardMaterial3D
	if mat_roof == null:
		printerr("FAIL: Could not load res://materials/building_roof_default.tres")
		return false
	if abs(mat_roof.albedo_color.r - Color("#4A4540").r) > 0.02 or abs(mat_roof.roughness - 0.90) > 0.02:
		printerr("FAIL: building_roof_default albedo/roughness mismatch: ", mat_roof.albedo_color, " roughness: ", mat_roof.roughness)
		return false
		
	print("Base StandardMaterial3D resources verified successfully!")
	return true
func test_triplanar_wall_mapping() -> bool:
	print("\n--- Test 5.3 (Triplanar): Building Wall Triplanar Mapping ---")
	
	# 1. Base wall resource triplanar check
	var mat_wall_res = load("res://materials/building_wall_default.tres") as StandardMaterial3D
	if not mat_wall_res.uv1_triplanar:
		printerr("FAIL: res://materials/building_wall_default.tres does not have uv1_triplanar enabled")
		return false
		
	# 2. Default wall material resolution triplanar check
	var mat_default = BuildingBuilder.resolve_wall_material({})
	if not mat_default.uv1_triplanar:
		printerr("FAIL: Default resolved wall material missing uv1_triplanar")
		return false
		
	# 3. Custom tag material resolution triplanar check
	var mat_custom = BuildingBuilder.resolve_wall_material({"building:material": "brick", "building:colour": "red"})
	if not mat_custom.uv1_triplanar:
		printerr("FAIL: Custom tagged wall material missing uv1_triplanar")
		return false
		
	# 4. Building node surface 0 material check
	var sample_bld = {
		"id": 9999,
		"tags": {"building": "yes"},
		"outer_rings": [
			PackedVector3Array([
				Vector3(0, 0, 0),
				Vector3(10, 0, 0),
				Vector3(10, 0, 10),
				Vector3(0, 0, 10),
				Vector3(0, 0, 0)
			])
		],
		"inner_rings": []
	}
	var bld_node = BuildingBuilder.create_building_node(sample_bld, false)
	if bld_node == null:
		printerr("FAIL: Could not build sample building node")
		return false
		
	var mesh_inst = bld_node as MeshInstance3D
	var wall_mat = mesh_inst.mesh.surface_get_material(0) as StandardMaterial3D
	if wall_mat == null or not wall_mat.uv1_triplanar:
		printerr("FAIL: Building surface 0 wall material is not triplanar")
		bld_node.free()
		return false
		
	bld_node.free()
	print("Building wall triplanar mapping verified successfully!")
	return true
