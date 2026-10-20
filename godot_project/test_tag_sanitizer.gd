extends SceneTree

const BuildingBuilderClass = preload("res://addons/osm_importer/building_builder.gd")
const RoadBuilderClass = preload("res://addons/osm_importer/road_builder.gd")

func _init() -> void:
	print("--- Test Edge Case 5: Non-numeric values in numeric tags ---")
	
	# Test "12 meters"
	var h1 = BuildingBuilderClass.parse_numeric_dimension("12 meters", 0.0)
	print("Parsed '12 meters': ", h1)
	assert(h1 == 12.0)
	
	# Test "lanes=two"
	var l1 = BuildingBuilderClass.parse_numeric_dimension("two", 1.0)
	print("Parsed 'two': ", l1)
	assert(l1 == 2.0)
	
	# Test "building:levels=approx 3"
	var lvl1 = BuildingBuilderClass.parse_numeric_dimension("approx 3", 1.0)
	print("Parsed 'approx 3': ", lvl1)
	assert(lvl1 == 3.0)
	
	# Test decimal with comma "14,5 m"
	var h2 = BuildingBuilderClass.parse_numeric_dimension("14,5 m", 0.0)
	print("Parsed '14,5 m': ", h2)
	assert(h2 == 14.5)
	
	# Test "three lanes"
	var l2 = RoadBuilderClass.parse_numeric_dimension("three lanes", 1.0)
	print("RoadBuilder parsed 'three lanes': ", l2)
	assert(l2 == 3.0)
	
	# Test resolve_height with "approx 4" levels
	var b_tags = {
		"building": "yes",
		"building:levels": "approx 4"
	}
	var h_res = BuildingBuilderClass.resolve_height(b_tags)
	print("Resolved height for approx 4 levels: ", h_res.height)
	assert(abs(h_res.height - 13.2) < 0.01)
	
	# Test resolve_road_width with lanes="two"
	var r_tags = {
		"highway": "residential",
		"lanes": "two"
	}
	var r_width = RoadBuilderClass.resolve_road_width(r_tags)
	print("Resolved road width for lanes='two': ", r_width.width, " lanes: ", r_width.lanes)
	assert(r_width.lanes == 2)
	assert(r_width.width == 6.0)
	
	print("All non-numeric tag sanitization tests PASSED!")
	quit(0)
