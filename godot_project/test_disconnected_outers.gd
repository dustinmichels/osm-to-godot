extends SceneTree

const OSMParse = preload("res://addons/osm_importer/osm_parser.gd")

func _init() -> void:
	print("--- Test Edge Case 3: Multipolygon Relations with Disconnected Outer Rings ---")
	var parser = OSMParse.new()
	
	# Create relation with 2 disconnected outer rings and 1 inner ring inside the first outer ring
	var multi_outer_data = {
		"elements": [
			# Outer ring 1 nodes
			{"type": "node", "id": 1, "lat": 42.3600, "lon": -71.0600},
			{"type": "node", "id": 2, "lat": 42.3605, "lon": -71.0600},
			{"type": "node", "id": 3, "lat": 42.3605, "lon": -71.0595},
			{"type": "node", "id": 4, "lat": 42.3600, "lon": -71.0595},
			
			# Inner ring 1 (hole inside Outer 1) nodes
			{"type": "node", "id": 5, "lat": 42.3601, "lon": -71.0599},
			{"type": "node", "id": 6, "lat": 42.3603, "lon": -71.0599},
			{"type": "node", "id": 7, "lat": 42.3603, "lon": -71.0597},
			{"type": "node", "id": 8, "lat": 42.3601, "lon": -71.0597},
			
			# Outer ring 2 (separate pavilion/wing 100m away) nodes
			{"type": "node", "id": 9, "lat": 42.3610, "lon": -71.0610},
			{"type": "node", "id": 10, "lat": 42.3612, "lon": -71.0610},
			{"type": "node", "id": 11, "lat": 42.3612, "lon": -71.0608},
			{"type": "node", "id": 12, "lat": 42.3610, "lon": -71.0608},
			
			# Relation
			{
				"type": "relation",
				"id": 88001,
				"tags": {
					"type": "multipolygon",
					"building": "university"
				},
				"members": [
					{"type": "way", "ref": 801, "role": "outer", "geometry": [
						{"lat": 42.3600, "lon": -71.0600}, {"lat": 42.3605, "lon": -71.0600},
						{"lat": 42.3605, "lon": -71.0595}, {"lat": 42.3600, "lon": -71.0595},
						{"lat": 42.3600, "lon": -71.0600}
					]},
					{"type": "way", "ref": 802, "role": "inner", "geometry": [
						{"lat": 42.3601, "lon": -71.0599}, {"lat": 42.3603, "lon": -71.0599},
						{"lat": 42.3603, "lon": -71.0597}, {"lat": 42.3601, "lon": -71.0597},
						{"lat": 42.3601, "lon": -71.0599}
					]},
					{"type": "way", "ref": 803, "role": "outer", "geometry": [
						{"lat": 42.3610, "lon": -71.0610}, {"lat": 42.3612, "lon": -71.0610},
						{"lat": 42.3612, "lon": -71.0608}, {"lat": 42.3610, "lon": -71.0608},
						{"lat": 42.3610, "lon": -71.0610}
					]}
				]
			}
		]
	}
	
	var res = parser.parse_data(multi_outer_data)
	var buildings = res["buildings"]
	print("Parsed building count from multi-outer relation: ", buildings.size())
	assert(buildings.size() == 2, "Should parse each disconnected outer ring as a separate building footprint")
	
	var b1 = buildings[0]
	var b2 = buildings[1]
	print("Building 1 ID: ", b1["id"], " inners: ", b1["inner_rings"].size())
	print("Building 2 ID: ", b2["id"], " inners: ", b2["inner_rings"].size())
	
	assert(b1["inner_rings"].size() == 1, "Building 1 should contain the courtyard hole")
	assert(b2["inner_rings"].size() == 0, "Building 2 should have no courtyard holes")
	assert(str(b1["id"]).begins_with("88001_"))
	assert(str(b2["id"]).begins_with("88001_"))
	
	print("All disconnected outer ring tests PASSED!")
	quit(0)
