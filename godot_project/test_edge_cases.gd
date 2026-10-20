extends SceneTree

const OSMProj = preload("res://addons/osm_importer/projection.gd")
const OSMParse = preload("res://addons/osm_importer/osm_parser.gd")

func _init() -> void:
	print("--- Test Edge Case 1: Unclosed & Self-intersecting Buildings ---")
	var parser = OSMParse.new()
	
	# 1. Unclosed building way (3 vertices forming open L/V, auto-repaired to triangle)
	var unclosed_data = {
		"elements": [
			{"type": "node", "id": 1, "lat": 42.3600, "lon": -71.0600},
			{"type": "node", "id": 2, "lat": 42.3601, "lon": -71.0600},
			{"type": "node", "id": 3, "lat": 42.3600, "lon": -71.0599},
			{
				"type": "way",
				"id": 9001,
				"tags": {"building": "yes"},
				"nodes": [1, 2, 3] # Note: not ending at 1
			}
		]
	}
	var res1 = parser.parse_data(unclosed_data)
	assert(res1["buildings"].size() == 1, "Unclosed building should be auto-repaired and parsed")
	var b1 = res1["buildings"][0]
	assert(b1["outer_rings"][0].size() == 4, "Should be closed into 4 vertices (3 unique + 1 closing)")
	print("Unclosed building auto-repair: SUCCESS")
	
	# 2. Self-intersecting building way (bowtie / figure 8)
	var bowtie_data = {
		"elements": [
			{"type": "node", "id": 1, "lat": 42.3600, "lon": -71.0600},
			{"type": "node", "id": 2, "lat": 42.3601, "lon": -71.0598},
			{"type": "node", "id": 3, "lat": 42.3601, "lon": -71.0600},
			{"type": "node", "id": 4, "lat": 42.3600, "lon": -71.0598},
			{
				"type": "way",
				"id": 9002,
				"tags": {"building": "yes"},
				"nodes": [1, 2, 3, 4, 1] # Bowtie intersection between (1->2) and (3->4)
			}
		]
	}
	var res2 = parser.parse_data(bowtie_data)
	assert(res2["buildings"].size() == 0, "Self-intersecting building should be skipped")
	print("Self-intersecting building skip: SUCCESS")
	
	# 3. Degenerate building (< 3 vertices)
	var degen_data = {
		"elements": [
			{"type": "node", "id": 1, "lat": 42.3600, "lon": -71.0600},
			{"type": "node", "id": 2, "lat": 42.3601, "lon": -71.0600},
			{
				"type": "way",
				"id": 9003,
				"tags": {"building": "yes"},
				"nodes": [1, 2, 1]
			}
		]
	}
	var res3 = parser.parse_data(degen_data)
	assert(res3["buildings"].size() == 0, "Degenerate building should be skipped")
	print("Degenerate building skip: SUCCESS")
	
	print("All unclosed & self-intersecting tests PASSED!")
	quit(0)
