extends SceneTree

const RoadBuilderClass = preload("res://addons/osm_importer/road_builder.gd")

func _init() -> void:
	print("--- Test Edge Case 2: Cul-de-sacs and Dead-End Roads ---")
	
	# Test 1: Explicit generate_road_ribbon with round cap
	var pts = PackedVector3Array([Vector3(0, 0, 0), Vector3(10, 0, 0)])
	var flat_ribbon = RoadBuilderClass.generate_road_ribbon(pts, 4.0, 0.0, 0.05, 2.0, "flat", "flat")
	var round_ribbon = RoadBuilderClass.generate_road_ribbon(pts, 4.0, 0.0, 0.05, 2.0, "round", "round")
	var square_ribbon = RoadBuilderClass.generate_road_ribbon(pts, 4.0, 0.0, 0.05, 2.0, "square", "square")
	
	print("Flat ribbon verts: ", flat_ribbon.vertices.size(), " indices: ", flat_ribbon.indices.size())
	print("Round cap verts: ", round_ribbon.vertices.size(), " indices: ", round_ribbon.indices.size())
	print("Square cap verts: ", square_ribbon.vertices.size(), " indices: ", square_ribbon.indices.size())
	
	assert(flat_ribbon.vertices.size() == 4)
	assert(flat_ribbon.indices.size() == 6)
	assert(square_ribbon.vertices.size() == 8)
	assert(square_ribbon.indices.size() == 18) # 6 base + 12 (6 for start, 6 for end)
	assert(round_ribbon.vertices.size() > 4)
	assert(round_ribbon.indices.size() > 6)
	print("Ribbon cap generation: SUCCESS")
	
	# Test 2: Dead-end detection in build_roads_node
	var dead_end_road = {
		"id": 101,
		"tags": {"highway": "residential"},
		"points": PackedVector3Array([Vector3(0, 0, 0), Vector3(50, 0, 0)]),
		"is_closed": false
	}
	var node = RoadBuilderClass.build_roads_node([dead_end_road])
	assert(node != null)
	var mesh_inst = node.get_child(0) as MeshInstance3D
	assert(mesh_inst != null)
	var m = mesh_inst.mesh as ArrayMesh
	assert(m != null)
	var arrays = m.surface_get_arrays(0)
	var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	print("Dead end mesh total vertices: ", verts.size())
	assert(verts.size() > 4, "Dead end road should have round end caps, increasing vertex count above 4")
	print("Dead end road network capping: SUCCESS")
	
	node.free()
	print("All cul-de-sac & dead-end tests PASSED!")
	quit(0)
