extends SceneTree

const OSMProj = preload("res://addons/osm_importer/projection.gd")
const OSMParse = preload("res://addons/osm_importer/osm_parser.gd")

func _init() -> void:
	print("========================================")
	print("Running OSM Importer Phase 2 Test Suite")
	print("========================================")
	
	var passed = true
	passed = test_projection() and passed
	passed = test_parser() and passed
	
	if passed:
		print("========================================")
		print("ALL PHASE 2 TESTS PASSED!")
		print("========================================")
		quit(0)
	else:
		print("========================================")
		printerr("PHASE 2 TESTS FAILED!")
		print("========================================")
		quit(1)

func test_projection() -> bool:
	print("\n--- Test 1: OSMProjection ---")
	var proj = OSMProj.new(42.3600, -71.0600)
	
	# Centroid must project to (0, 0, 0)
	var origin_p = proj.project(42.3600, -71.0600)
	print("Centroid projected: ", origin_p)
	if origin_p.length() > 0.001:
		printerr("FAIL: Origin was not at (0, 0, 0), got: ", origin_p)
		return false
		
	# Point to the North should have -Z
	var north_p = proj.project(42.3610, -71.0600)
	print("North projected: ", north_p)
	if north_p.z >= 0.0 or north_p.z > -100.0:
		printerr("FAIL: Expected negative Z for North point: ", north_p)
		return false
		
	# Point to the East should have +X
	var east_p = proj.project(42.3600, -71.0590)
	print("East projected: ", east_p)
	if east_p.x <= 0.0 or east_p.x < 50.0:
		printerr("FAIL: Expected positive X for East point: ", east_p)
		return false
		
	# Unproject roundtrip
	var unproj = proj.unproject(north_p)
	print("Unprojected North: ", unproj)
	if abs(unproj.lat - 42.3610) > 1e-6 or abs(unproj.lon - (-71.0600)) > 1e-6:
		printerr("FAIL: Unproject roundtrip mismatch: ", unproj)
		return false
		
	print("Projection tests passed!")
	return true

func test_parser() -> bool:
	print("\n--- Test 2: OSMParser ---")
	var fixture_path = "../tests/fixtures/sample_city_export.json"
	var file = FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		# Try relative to project root
		fixture_path = "res://../tests/fixtures/sample_city_export.json"
		file = FileAccess.open(fixture_path, FileAccess.READ)
	if file == null:
		printerr("FAIL: Could not open fixture file: ", fixture_path)
		return false
		
	var json_str = file.get_as_text()
	file.close()
	
	var parser = OSMParse.new()
	var result = parser.parse_json_string(json_str)
	
	if result.has("error"):
		printerr("FAIL: Parser reported error: ", result.error)
		return false
		
	var roads: Array = result.roads
	var buildings: Array = result.buildings
	
	print("Parsed roads count: ", roads.size())
	print("Parsed buildings count: ", buildings.size())
	
	# Verify Road
	if roads.size() != 1:
		printerr("FAIL: Expected 1 road, got: ", roads.size())
		return false
	var road = roads[0]
	if road.id != 1001:
		printerr("FAIL: Road ID mismatch: ", road.id)
		return false
	# Original geometry had 4 points with a duplicate consecutive vertex; clean should have 3
	if road.points.size() != 3:
		printerr("FAIL: Road points count after deduplication expected 3, got: ", road.points.size())
		return false
	print("Road #1001 points: ", road.points)
	
	# Verify Buildings: 1 standalone building + 1 multipolygon building
	if buildings.size() != 2:
		printerr("FAIL: Expected 2 buildings, got: ", buildings.size())
		return false
		
	# Find standalone building (id 2001)
	var b_simple: Dictionary = {}
	var b_multi: Dictionary = {}
	for b in buildings:
		if b.id == 2001:
			b_simple = b
		elif b.id == 3001:
			b_multi = b
			
	if b_simple.is_empty():
		printerr("FAIL: Simple building #2001 not found.")
		return false
	if b_multi.is_empty():
		printerr("FAIL: Multipolygon building #3001 not found.")
		return false
		
	# Verify simple building winding (must be CCW)
	var ring = b_simple.outer_rings[0]
	var area = parser.calculate_signed_area_2d(ring)
	print("Simple building signed area: ", area)
	if area <= 0.0:
		printerr("FAIL: Building outer ring must be CCW (positive area), got: ", area)
		return false
	# Verify closure
	if ring[0].distance_to(ring[ring.size() - 1]) > 0.01:
		printerr("FAIL: Building ring not closed: ", ring[0], " vs ", ring[ring.size() - 1])
		return false
		
	# Verify multipolygon building has 1 outer ring (CCW) and 1 inner ring (CW)
	if b_multi.outer_rings.size() != 1:
		printerr("FAIL: Multipolygon expected 1 outer ring, got: ", b_multi.outer_rings.size())
		return false
	if b_multi.inner_rings.size() != 1:
		printerr("FAIL: Multipolygon expected 1 inner ring, got: ", b_multi.inner_rings.size())
		return false
		
	var multi_outer = b_multi.outer_rings[0]
	var multi_inner = b_multi.inner_rings[0]
	var outer_area = parser.calculate_signed_area_2d(multi_outer)
	var inner_area = parser.calculate_signed_area_2d(multi_inner)
	print("Multipolygon outer signed area: ", outer_area, " (CCW: ", outer_area > 0, ")")
	print("Multipolygon inner signed area: ", inner_area, " (CW: ", inner_area < 0, ")")
	
	if outer_area <= 0.0:
		printerr("FAIL: Multipolygon outer ring must be CCW.")
		return false
	if inner_area >= 0.0:
		printerr("FAIL: Multipolygon inner ring must be CW (hole).")
		return false
		
	print("Parser tests passed!")
	return true
