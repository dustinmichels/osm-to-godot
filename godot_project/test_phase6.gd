extends SceneTree

const OSMParse = preload("res://addons/osm_importer/osm_parser.gd")
const SceneBuilder = preload("res://addons/osm_importer/scene_builder.gd")
const BuildingBuilder = preload("res://addons/osm_importer/building_builder.gd")
const RoadBuilder = preload("res://addons/osm_importer/road_builder.gd")
const ChunkManager = preload("res://addons/osm_importer/chunk_manager.gd")

func _init() -> void:
	print("========================================")
	print("Running OSM Importer Phase 6 Test Suite")
	print("========================================")

	var passed = true
	passed = test_draw_call_reduction_batching() and passed
	passed = test_draw_call_budget() and passed
	passed = test_spatial_grid_partitioning() and passed
	passed = test_chunk_lod_and_culling() and passed

	if passed:
		print("========================================")
		print("ALL PHASE 6 TESTS PASSED!")
		print("========================================")
		quit(0)
	else:
		print("========================================")
		printerr("PHASE 6 TESTS FAILED!")
		print("========================================")
		quit(1)

func test_draw_call_reduction_batching() -> bool:
	print("\n--- Test 6.1: Draw Call Reduction (Material Batching) ---")

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
	var roads: Array = parsed.get("roads", [])

	print("Parsed ", buildings.size(), " buildings and ", roads.size(), " roads.")

	# 1. Unbatched building node count
	var unbatched_root = BuildingBuilder.build_buildings_node(buildings, false, false)
	var unbatched_count = unbatched_root.get_child_count()
	unbatched_root.free()

	# 2. Batched building node count
	var batched_root = BuildingBuilder.build_buildings_node(buildings, true, true)
	var batched_count = batched_root.get_child_count()
	print("Buildings: unbatched MeshInstances = ", unbatched_count, " -> batched MeshInstances = ", batched_count)

	if unbatched_count > 1 and batched_count >= unbatched_count:
		printerr("FAIL: Batched count should be significantly smaller than unbatched count")
		batched_root.free()
		return false

	# Verify batched meshes have geometry and materials
	for child in batched_root.get_children():
		var mi = child as MeshInstance3D
		if mi == null or mi.mesh == null or mi.mesh.get_surface_count() == 0:
			printerr("FAIL: Batched building mesh invalid: ", child.name)
			batched_root.free()
			return false
		print("  Verified batched building node: ", mi.name, " with ", mi.mesh.get_surface_count(), " surfaces")

	batched_root.free()

	# 3. Roads batching verification:
	# Asphalt and bike lanes consolidated into single combined ArrayMesh nodes
	var roads_root = RoadBuilder.build_roads_node(roads, true)
	var road_meshes: Array[String] = []
	for child in roads_root.get_children():
		if child is MeshInstance3D:
			road_meshes.append(child.name)
			var mi = child as MeshInstance3D
			if mi.mesh == null or mi.mesh.get_surface_count() == 0:
				printerr("FAIL: Road mesh empty: ", child.name)
				roads_root.free()
				return false
			print("  Verified road batch node: ", mi.name, " with ", mi.mesh.get_surface_count(), " surfaces")

	print("Road batch nodes: ", road_meshes)
	if not road_meshes.has("RoadMesh_Asphalt"):
		printerr("FAIL: Expected RoadMesh_Asphalt in roads root")
		roads_root.free()
		return false

	roads_root.free()
	print("Material batching tests passed!")
	return true

func test_draw_call_budget() -> bool:
	print("\n--- Test 6.1 (Budget): Draw Call Budget Verification ---")
	# Simulate a large 2 km x 2 km dataset with 2,000 buildings and 500 road segments
	var large_buildings: Array = []
	for i in range(2000):
		var mat = "brick" if (i % 3 == 0) else ("concrete" if (i % 3 == 1) else "glass")
		var roof_mat = "tile" if (i % 2 == 0) else "metal"
		var ox = float((i % 45) * 40 - 900)
		var oz = float((i / 45) * 40 - 900)
		large_buildings.append({
			"id": 10000 + i,
			"tags": {
				"building": "yes",
				"height": "12.0",
				"building:material": mat,
				"roof:material": roof_mat
			},
			"outer_rings": [
				PackedVector3Array([
					Vector3(ox, 0.0, oz),
					Vector3(ox + 20.0, 0.0, oz),
					Vector3(ox + 20.0, 0.0, oz + 20.0),
					Vector3(ox, 0.0, oz + 20.0),
					Vector3(ox, 0.0, oz)
				])
			],
			"inner_rings": []
		})

	var large_roads: Array = []
	for r in range(500):
		var is_bike = (r % 4 == 0)
		var z_pos = float(r * 8 - 1000)
		var tags = {
			"highway": "primary" if not is_bike else "cycleway",
			"surface": "asphalt" if not is_bike else "asphalt"
		}
		if is_bike:
			tags["bicycle"] = "designated"
		large_roads.append({
			"id": 20000 + r,
			"tags": tags,
			"points": PackedVector3Array([
				Vector3(-1000.0, 0.0, z_pos),
				Vector3(0.0, 0.0, z_pos),
				Vector3(1000.0, 0.0, z_pos)
			])
		})

	# Unbatched draw call estimate:
	# 2000 buildings * 2 surfaces (walls + roof) = 4,000 draw calls
	# 500 roads * 1-2 slices = ~800 draw calls
	# Total unbatched draw calls > 4,800
	
	# Batched building generation:
	var batched_buildings_root = BuildingBuilder.build_buildings_node(large_buildings, false, true)
	var bld_draw_calls = 0
	for child in batched_buildings_root.get_children():
		var mi = child as MeshInstance3D
		if mi and mi.mesh:
			bld_draw_calls += mi.mesh.get_surface_count()

	var roads_root = RoadBuilder.build_roads_node(large_roads, false)
	var road_draw_calls = 0
	for child in roads_root.get_children():
		var mi = child as MeshInstance3D
		if mi and mi.mesh:
			road_draw_calls += mi.mesh.get_surface_count()

	var total_draw_calls = bld_draw_calls + road_draw_calls
	print("Simulated 2km x 2km area (2,000 buildings, 500 roads):")
	print("  Building draw calls (batched surfaces): ", bld_draw_calls)
	print("  Road draw calls (batched surfaces): ", road_draw_calls)
	print("  Total draw calls: ", total_draw_calls, " (Target budget: < 25)")

	batched_buildings_root.free()
	roads_root.free()

	if total_draw_calls >= 25:
		printerr("FAIL: Total draw calls ", total_draw_calls, " exceeds target budget of < 25!")
		return false

	print("Draw call budget verification passed! Total draw calls: ", total_draw_calls, " < 25.")
	return true

func test_spatial_grid_partitioning() -> bool:
	print("\n--- Test 6.2 (Partitioning): 2D Spatial Grid Partitioning (500m x 500m) ---")
	# Create items spanning across 4 distinct 500m cells: (-500..500, -500..500)
	# Cell (-1, -1): center around (-250, -250)
	# Cell (-1, 0): center around (-250, 250)
	# Cell (0, -1): center around (250, -250)
	# Cell (0, 0): center around (250, 250)
	var test_buildings = [
		{
			"id": 1,
			"tags": {"building": "yes", "height": "10"},
			"outer_rings": [PackedVector3Array([Vector3(-300, 0, -300), Vector3(-280, 0, -300), Vector3(-280, 0, -280), Vector3(-300, 0, -280)])],
			"inner_rings": []
		},
		{
			"id": 2,
			"tags": {"building": "yes", "height": "10"},
			"outer_rings": [PackedVector3Array([Vector3(-300, 0, 300), Vector3(-280, 0, 300), Vector3(-280, 0, 320), Vector3(-300, 0, 320)])],
			"inner_rings": []
		},
		{
			"id": 3,
			"tags": {"building": "yes", "height": "10"},
			"outer_rings": [PackedVector3Array([Vector3(300, 0, -300), Vector3(320, 0, -300), Vector3(320, 0, -280), Vector3(300, 0, -280)])],
			"inner_rings": []
		},
		{
			"id": 4,
			"tags": {"building": "yes", "height": "10"},
			"outer_rings": [PackedVector3Array([Vector3(300, 0, 300), Vector3(320, 0, 300), Vector3(320, 0, 320), Vector3(300, 0, 320)])],
			"inner_rings": []
		}
	]

	var test_roads = [
		{
			"id": 101,
			"tags": {"highway": "residential"},
			"points": PackedVector3Array([Vector3(-350, 0, -350), Vector3(-250, 0, -250)])
		},
		{
			"id": 102,
			"tags": {"highway": "residential"},
			"points": PackedVector3Array([Vector3(250, 0, 250), Vector3(350, 0, 350)])
		}
	]

	var partitions = ChunkManager.partition_into_chunks(test_buildings, test_roads, 500.0)
	print("Partitioned into ", partitions.size(), " grid cells: ", partitions.keys())

	if partitions.size() != 4:
		printerr("FAIL: Expected 4 spatial grid cells, got: ", partitions.size())
		return false

	var c_neg1_neg1: Vector2i = Vector2i(-1, -1)
	var c_0_0: Vector2i = Vector2i(0, 0)
	if not partitions.has(c_neg1_neg1) or not partitions.has(c_0_0):
		printerr("FAIL: Expected cells (-1, -1) and (0, 0) in partitions")
		return false

	if partitions[c_neg1_neg1]["buildings"].size() != 1 or partitions[c_neg1_neg1]["roads"].size() != 1:
		printerr("FAIL: Chunk (-1, -1) content mismatch: ", partitions[c_neg1_neg1])
		return false

	print("Spatial grid partitioning tests passed!")
	return true

func test_chunk_lod_and_culling() -> bool:
	print("\n--- Test 6.2 (LOD/Culling): Distance-based Visibility Culling per Chunk ---")
	var buildings = [
		{
			"id": 1,
			"tags": {"building": "yes", "height": "10"},
			"outer_rings": [PackedVector3Array([Vector3(10, 0, 10), Vector3(30, 0, 10), Vector3(30, 0, 30), Vector3(10, 0, 30)])],
			"inner_rings": []
		}
	]
	var roads = [
		{
			"id": 10,
			"tags": {"highway": "primary"},
			"points": PackedVector3Array([Vector3(0, 0, 0), Vector3(100, 0, 0)])
		}
	]

	var chunked_world = ChunkManager.build_chunked_world(buildings, roads, 500.0, true, 800.0)
	if chunked_world == null:
		printerr("FAIL: build_chunked_world returned null")
		return false

	var chunk_count = chunked_world.get_child_count()
	print("Generated chunked world with ", chunk_count, " chunk(s).")
	if chunk_count != 1:
		printerr("FAIL: Expected 1 chunk node, got: ", chunk_count)
		chunked_world.free()
		return false

	var chunk_0_0 = chunked_world.get_child(0) as Node3D
	var blds = chunk_0_0.get_node_or_null("Buildings") as Node3D
	var rds = chunk_0_0.get_node_or_null("Roads") as Node3D

	if blds == null or rds == null:
		printerr("FAIL: Chunk missing Buildings or Roads container")
		chunked_world.free()
		return false

	# Verify visibility range / LOD limits applied on GeometryInstance3D
	var checked_any_mesh = false
	for mi in blds.get_children():
		if mi is GeometryInstance3D:
			var gi = mi as GeometryInstance3D
			if abs(gi.visibility_range_end - 800.0) > 0.1:
				printerr("FAIL: Expected visibility_range_end 800.0, got: ", gi.visibility_range_end)
				chunked_world.free()
				return false
			if gi.visibility_range_fade_mode != GeometryInstance3D.VISIBILITY_RANGE_FADE_SELF:
				printerr("FAIL: Expected VISIBILITY_RANGE_FADE_SELF")
				chunked_world.free()
				return false
			checked_any_mesh = true

	for mi in rds.get_children():
		if mi is GeometryInstance3D:
			var gi = mi as GeometryInstance3D
			if abs(gi.visibility_range_end - 800.0) > 0.1:
				printerr("FAIL: Expected road visibility_range_end 800.0, got: ", gi.visibility_range_end)
				chunked_world.free()
				return false
			checked_any_mesh = true

	if not checked_any_mesh:
		printerr("FAIL: No meshes checked for LOD culling properties")
		chunked_world.free()
		return false

	chunked_world.free()

	# Also verify SceneBuilder with spatial chunking enabled
	var scene_root = SceneBuilder.build_city_scene(buildings, roads, true, false, true, 500.0, 1200.0)
	var chunked_sub = scene_root.get_node_or_null("ChunkedWorld")
	if chunked_sub == null:
		printerr("FAIL: SceneBuilder missing ChunkedWorld when use_spatial_chunks=true")
		scene_root.free()
		return false
	print("SceneBuilder successfully constructed scene with ChunkedWorld hierarchy.")
	scene_root.free()

	print("Distance-based LOD & visibility culling tests passed!")
	return true
