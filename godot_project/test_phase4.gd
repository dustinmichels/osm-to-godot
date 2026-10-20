extends SceneTree

const RoadBuilderClass = preload("res://addons/osm_importer/road_builder.gd")

func _init() -> void:
	print("========================================")
	print("Running OSM Importer Phase 4 Test Suite")
	print("========================================")
	
	var passed = true
	passed = test_width_inference() and passed
	passed = test_surface_classification() and passed
	passed = test_bike_lane_detection_and_slicing() and passed
	passed = test_road_ribbon_generation() and passed
	passed = test_vertical_layering_and_bridges() and passed
	if passed:
		print("========================================")
		print("ALL PHASE 4 TESTS PASSED!")
		print("========================================")
		quit(0)
	else:
		print("========================================")
		printerr("PHASE 4 TESTS FAILED!")
		print("========================================")
		quit(1)

func test_width_inference() -> bool:
	print("\n--- Test 4.1: Street Width Inference ---")
	
	# 1. Explicit width tag
	var w1 = RoadBuilderClass.resolve_road_width({"highway": "residential", "width": "12"})
	if abs(w1.width - 12.0) > 0.01:
		printerr("FAIL: Expected 12.0m for width='12', got: ", w1)
		return false
	
	# 2. Explicit est_width tag with 'm'
	var w2 = RoadBuilderClass.resolve_road_width({"highway": "primary", "est_width": "10.5 m"})
	if abs(w2.width - 10.5) > 0.01:
		printerr("FAIL: Expected 10.5m for est_width='10.5 m', got: ", w2)
		return false

	# 3. Lanes tag on motorway / primary -> 3.5m lane width
	var w3 = RoadBuilderClass.resolve_road_width({"highway": "motorway", "lanes": "3"})
	if abs(w3.width - 10.5) > 0.01 or w3.lanes != 3 or abs(w3.lane_width - 3.5) > 0.01:
		printerr("FAIL: Expected 10.5m (3x3.5) for motorway with 3 lanes, got: ", w3)
		return false
		
	var w4 = RoadBuilderClass.resolve_road_width({"highway": "residential", "lanes": "3"})
	if abs(w4.width - 9.0) > 0.01 or w4.lanes != 3 or abs(w4.lane_width - 3.0) > 0.01:
		printerr("FAIL: Expected 9.0m (3x3.0) for residential with 3 lanes, got: ", w4)
		return false

	# 4. Fallback table
	var table_checks = {
		"motorway": 14.0,
		"motorway_link": 14.0,
		"trunk": 10.5,
		"trunk_link": 10.5,
		"primary": 9.0,
		"primary_link": 9.0,
		"secondary": 8.0,
		"tertiary": 7.0,
		"residential": 6.0,
		"unclassified": 6.0,
		"living_street": 4.5,
		"service": 4.0,
		"cycleway": 2.5,
		"footway": 2.0,
		"pedestrian": 2.0,
		"path": 2.0,
	}
	
	for h in table_checks.keys():
		var res = RoadBuilderClass.resolve_road_width({"highway": h})
		var expected = table_checks[h]
		if abs(res.width - expected) > 0.01:
			printerr("FAIL: Highway fallback '", h, "' expected ", expected, " got ", res.width)
			return false
			
	print("Width inference tests passed!")
	return true

func test_surface_classification() -> bool:
	print("\n--- Test 4.2: Surface Type Classification ---")
	
	# Explicit surface tags
	var s1 = RoadBuilderClass.resolve_surface_type({"surface": "asphalt"})
	var s2 = RoadBuilderClass.resolve_surface_type({"surface": "tarmac"})
	var s3 = RoadBuilderClass.resolve_surface_type({"surface": "paved"})
	if s1 != "asphalt" or s2 != "asphalt" or s3 != "asphalt":
		printerr("FAIL: Expected asphalt mappings, got: ", [s1, s2, s3])
		return false
		
	var s_conc = RoadBuilderClass.resolve_surface_type({"surface": "concrete"})
	var s_paving = RoadBuilderClass.resolve_surface_type({"surface": "paving_stones"})
	if s_conc != "concrete" or s_paving != "concrete":
		printerr("FAIL: Expected concrete mappings, got: ", [s_conc, s_paving])
		return false
		
	var s_cobble = RoadBuilderClass.resolve_surface_type({"surface": "cobblestone"})
	var s_sett = RoadBuilderClass.resolve_surface_type({"surface": "sett"})
	if s_cobble != "cobblestone" or s_sett != "cobblestone":
		printerr("FAIL: Expected cobblestone mappings, got: ", [s_cobble, s_sett])
		return false
		
	var s_gravel = RoadBuilderClass.resolve_surface_type({"surface": "gravel"})
	var s_compacted = RoadBuilderClass.resolve_surface_type({"surface": "compacted"})
	if s_gravel != "gravel" or s_compacted != "gravel":
		printerr("FAIL: Expected gravel mappings, got: ", [s_gravel, s_compacted])
		return false
		
	var s_dirt = RoadBuilderClass.resolve_surface_type({"surface": "dirt"})
	var s_ground = RoadBuilderClass.resolve_surface_type({"surface": "ground"})
	var s_unpaved = RoadBuilderClass.resolve_surface_type({"surface": "unpaved"})
	if s_dirt != "dirt" or s_ground != "dirt" or s_unpaved != "dirt":
		printerr("FAIL: Expected dirt mappings, got: ", [s_dirt, s_ground, s_unpaved])
		return false
		
	# Fallback when surface is absent
	var f_motorway = RoadBuilderClass.resolve_surface_type({"highway": "motorway"})
	var f_path = RoadBuilderClass.resolve_surface_type({"highway": "path"})
	var f_track = RoadBuilderClass.resolve_surface_type({"highway": "track"})
	var f_footway = RoadBuilderClass.resolve_surface_type({"highway": "footway"})
	var f_cycleway = RoadBuilderClass.resolve_surface_type({"highway": "cycleway"})
	
	if f_motorway != "asphalt":
		printerr("FAIL: Expected motorway to fallback to asphalt, got: ", f_motorway)
		return false
	if f_path != "dirt" or f_track != "dirt":
		printerr("FAIL: Expected path/track to fallback to dirt, got: ", [f_path, f_track])
		return false
	if f_footway != "concrete":
		printerr("FAIL: Expected footway to fallback to concrete, got: ", f_footway)
		return false
	if f_cycleway != "asphalt":
		printerr("FAIL: Expected cycleway to fallback to asphalt, got: ", f_cycleway)
		return false
		
	# Material creation test
	var m_asphalt = RoadBuilderClass.get_surface_material("asphalt")
	var m_dirt = RoadBuilderClass.get_surface_material("dirt")
	if m_asphalt == null or m_dirt == null:
		printerr("FAIL: Could not generate materials")
		return false
	if m_asphalt.resource_name != "RoadAsphaltMaterial":
		printerr("FAIL: Material resource name mismatch: ", m_asphalt.resource_name)
		return false
		
	print("Surface classification tests passed!")
	return true

func test_bike_lane_detection_and_slicing() -> bool:
	print("\n--- Test 4.3: Bike Lane Detection & Geometry Slicing ---")
	
	# 1. Dedicated cycleway
	var b1 = RoadBuilderClass.parse_bike_lanes({"highway": "cycleway"})
	if not b1.has_bike_lane or not b1.is_dedicated or abs(b1.total_bike_width - 2.5) > 0.01:
		printerr("FAIL: Dedicated cycleway parsing failed: ", b1)
		return false
		
	var sec1 = RoadBuilderClass.compute_cross_sections({"highway": "cycleway"})
	if sec1.size() != 1 or sec1[0].material_type != "bike_lane" or abs(sec1[0].width - 2.5) > 0.01:
		printerr("FAIL: Dedicated cycleway cross-sections failed: ", sec1)
		return false
		
	# 2. Both sides bike lanes: cycleway=lane
	var b2 = RoadBuilderClass.parse_bike_lanes({"highway": "tertiary", "cycleway": "lane"})
	if not b2.has_bike_lane or b2.left_width != 1.5 or b2.right_width != 1.5:
		printerr("FAIL: cycleway=lane parsing failed: ", b2)
		return false
		
	# Tertiary default width = 7.0m. Both sides lane = 1.5m each (total 3.0m). Carriageway = 4.0m.
	var sec2 = RoadBuilderClass.compute_cross_sections({"highway": "tertiary", "cycleway": "lane"})
	if sec2.size() != 3:
		printerr("FAIL: Expected 3 sections for cycleway=lane, got: ", sec2.size())
		return false
	if sec2[0].type != "bike_lane" or sec2[0].width != 1.5 or sec2[0].offset != -2.75:
		printerr("FAIL: Left bike lane slice mismatch: ", sec2[0])
		return false
	if sec2[1].type != "carriageway" or abs(sec2[1].width - 4.0) > 0.01 or abs(sec2[1].offset) > 0.01:
		printerr("FAIL: Carriageway slice mismatch: ", sec2[1])
		return false
	if sec2[2].type != "bike_lane" or sec2[2].width != 1.5 or sec2[2].offset != 2.75:
		printerr("FAIL: Right bike lane slice mismatch: ", sec2[2])
		return false
		
	# 3. Right side only: cycleway:right=lane (1.5m)
	var sec3 = RoadBuilderClass.compute_cross_sections({"highway": "secondary", "cycleway:right": "lane"})
	# Secondary = 8.0m. Right bike lane = 1.5m. Carriageway = 6.5m.
	if sec3.size() != 2:
		printerr("FAIL: Expected 2 sections for cycleway:right=lane, got: ", sec3.size())
		return false
	if sec3[0].type != "carriageway" or abs(sec3[0].width - 6.5) > 0.01:
		printerr("FAIL: Carriageway slice for cycleway:right failed: ", sec3[0])
		return false
	if sec3[1].type != "bike_lane" or sec3[1].width != 1.5:
		printerr("FAIL: Right bike lane slice failed: ", sec3[1])
		return false
		
	# 4. Separated track: cycleway=track (2.0m each side)
	var b4 = RoadBuilderClass.parse_bike_lanes({"highway": "primary", "cycleway": "track"})
	if b4.left_width != 2.0 or b4.right_width != 2.0:
		printerr("FAIL: cycleway=track width parsing failed: ", b4)
		return false
		
	print("Bike lane detection & geometry slicing tests passed!")
	return true

func test_road_ribbon_generation() -> bool:
	print("\n--- Test 4.4: Road Ribbon Mesh Generation & Miter Clamping ---")
	
	# 1. Straight line along X axis: (0, 0, 0) to (10, 0, 0)
	# Tangent is (+1, 0, 0), normal is (0, 0, -1) in 3D (or (0, -1) in 2D)
	var pts = PackedVector3Array([Vector3(0, 0, 0), Vector3(10, 0, 0)])
	var ribbon = RoadBuilderClass.generate_road_ribbon(pts, 4.0, 0.0, 0.05)
	
	if ribbon.vertices.size() != 4:
		printerr("FAIL: Expected 4 vertices for 2-point line, got: ", ribbon.vertices.size())
		return false
	if ribbon.indices.size() != 6:
		printerr("FAIL: Expected 6 indices (2 triangles) for 1 segment, got: ", ribbon.indices.size())
		return false
		
	# Width check: distance between left and right vertices at vertex 0 must be 4.0m
	var w0 = ribbon.vertices[0].distance_to(ribbon.vertices[1])
	if abs(w0 - 4.0) > 0.01:
		printerr("FAIL: Ribbon width mismatch: ", w0)
		return false
	# Elevation check: Y should be 0.05
	if abs(ribbon.vertices[0].y - 0.05) > 0.001:
		printerr("FAIL: Ribbon elevation mismatch: ", ribbon.vertices[0].y)
		return false
		
	# 2. Miter clamping on sharp angle (sharp hairpin turn)
	# (0, 0, 0) -> (10, 0, 0) -> (0.1, 0, 0.1)
	var sharp_pts = PackedVector3Array([
		Vector3(0, 0, 0),
		Vector3(10, 0, 0),
		Vector3(0.1, 0, 0.5)
	])
	var sharp_ribbon = RoadBuilderClass.generate_road_ribbon(sharp_pts, 2.0, 0.0, 0.05, 2.0)
	# Verify vertex count (3 * 2 = 6 vertices, 2 segments * 6 = 12 indices)
	if sharp_ribbon.vertices.size() != 6 or sharp_ribbon.indices.size() != 12:
		printerr("FAIL: Sharp ribbon vertex/index count mismatch")
		return false
	# Miter distance at corner (vertex index 2 & 3) should be clamped:
	# without clamp it would explode to > 20m. With clamp (miter_limit = 2.0), offset is at most 2.0 * half_width = 2.0m
	var corner_dist = sharp_ribbon.vertices[2].distance_to(sharp_pts[1])
	if corner_dist > 2.0 * 2.0 + 0.1: # miter limit * half_width
		printerr("FAIL: Miter was not clamped! Corner distance: ", corner_dist)
		return false
		
	# 3. Clipper offset polyline verification
	var pts_2d = PackedVector2Array([Vector2(0, 0), Vector2(20, 0), Vector2(20, 20)])
	var clipper_res = RoadBuilderClass.generate_clipper_ribbon_2d(pts_2d, 4.0)
	if clipper_res.is_empty():
		printerr("FAIL: Clipper offset polyline returned empty")
		return false
	if clipper_res[0].size() < 6:
		printerr("FAIL: Clipper offset polyline polygon has fewer vertices than expected: ", clipper_res[0].size())
		return false
		
	print("Road ribbon mesh generation and miter clamping tests passed!")
	return true

func test_vertical_layering_and_bridges() -> bool:
	print("\n--- Test 4.5: Vertical Layering, Bridges, and Tunnels ---")
	
	# 1. Z-fighting prevention elevations:
	# Roads: 0.05m
	# Bike lanes: 0.07m
	# Footpaths: 0.09m
	var y_road = RoadBuilderClass.calculate_elevation({"highway": "residential"}, "carriageway")
	if abs(y_road - 0.05) > 0.001:
		printerr("FAIL: Road default elevation mismatch: ", y_road)
		return false
		
	var y_bike = RoadBuilderClass.calculate_elevation({"highway": "residential"}, "bike_lane")
	if abs(y_bike - 0.07) > 0.001:
		printerr("FAIL: Bike lane elevation mismatch: ", y_bike)
		return false
		
	var y_foot = RoadBuilderClass.calculate_elevation({"highway": "footway"}, "footway")
	if abs(y_foot - 0.09) > 0.001:
		printerr("FAIL: Footway elevation mismatch: ", y_foot)
		return false
		
	# 2. Layer multiplier: Y = base + (layer * 4.5m)
	var y_layer1 = RoadBuilderClass.calculate_elevation({"highway": "primary", "layer": "1"}, "carriageway")
	if abs(y_layer1 - (0.05 + 4.5)) > 0.001:
		printerr("FAIL: Layer 1 elevation mismatch: ", y_layer1)
		return false
		
	var y_layer2 = RoadBuilderClass.calculate_elevation({"highway": "primary", "layer": "2"}, "carriageway")
	if abs(y_layer2 - (0.05 + 9.0)) > 0.001:
		printerr("FAIL: Layer 2 elevation mismatch: ", y_layer2)
		return false
		
	# Layer clamping [-5, 5]
	var l_clamp = RoadBuilderClass.parse_layer({"layer": "10"})
	if l_clamp != 5:
		printerr("FAIL: Layer was not clamped to 5, got: ", l_clamp)
		return false
		
	# 3. Bridge minimum elevation
	var y_bridge = RoadBuilderClass.calculate_elevation({"highway": "primary", "bridge": "yes"}, "carriageway")
	if y_bridge < 4.5:
		printerr("FAIL: Bridge elevation below 4.5m: ", y_bridge)
		return false
		
	# 4. Bridge barrier generation
	var br_pts = PackedVector3Array([Vector3(0, 0, 0), Vector3(50, 0, 0)])
	var barriers = RoadBuilderClass.generate_bridge_barriers(br_pts, 8.0, 4.5, 1.0)
	if barriers.vertices.is_empty() or barriers.indices.is_empty():
		printerr("FAIL: Bridge barriers geometry empty")
		return false
	# Check barrier height: bottom is 4.5, top is 5.5
	if abs(barriers.vertices[0].y - 4.5) > 0.01 or abs(barriers.vertices[2].y - 5.5) > 0.01:
		printerr("FAIL: Bridge barrier height mismatch: ", barriers.vertices[0], barriers.vertices[2])
		return false
		
	# 5. Bridge pillar generation
	var pillars = RoadBuilderClass.generate_bridge_pillars(br_pts, 4.5, 0.6, 20.0)
	if pillars.vertices.is_empty() or pillars.indices.is_empty():
		printerr("FAIL: Bridge pillars geometry empty")
		return false
	# Pillars must extend to ground Y = 0
	var min_py = 999.0
	var max_py = -999.0
	for v in pillars.vertices:
		if v.y < min_py:
			min_py = v.y
		if v.y > max_py:
			max_py = v.y
	if abs(min_py - 0.0) > 0.01 or abs(max_py - 4.5) > 0.01:
		printerr("FAIL: Pillar vertical extent mismatch: min=", min_py, " max=", max_py)
		return false
		
	# 6. Full roads node generation with mock data
	var mock_roads = [
		{
			"id": 1001,
			"tags": {"highway": "residential", "name": "Main St"},
			"points": PackedVector3Array([Vector3(0, 0, 0), Vector3(30, 0, 0), Vector3(30, 0, 40)])
		},
		{
			"id": 1002,
			"tags": {"highway": "secondary", "bridge": "yes", "cycleway": "lane"},
			"points": PackedVector3Array([Vector3(-50, 0, 0), Vector3(0, 0, 0), Vector3(50, 0, 0)])
		}
	]
	var roads_node = RoadBuilderClass.build_roads_node(mock_roads, true)
	if roads_node == null:
		printerr("FAIL: build_roads_node returned null")
		return false
	if roads_node.get_child_count() == 0:
		printerr("FAIL: build_roads_node produced 0 children")
		return false
		
	print("Generated ", roads_node.get_child_count(), " road meshes.")
	roads_node.free()
	
	print("Vertical layering, bridges, and tunnels tests passed!")
	return true
