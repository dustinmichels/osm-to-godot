extends SceneTree

## Automated headless test script for OSM Importer.
## Runs Godot headless importer against all fixtures in tests/fixtures/.
## Verifies vertex counts, valid AABB bounding boxes, zero NaN values, and non-empty mesh surfaces.

const OSMParserClass = preload("res://addons/osm_importer/osm_parser.gd")
const OSMSceneBuilderClass = preload("res://addons/osm_importer/scene_builder.gd")
const BuildingBuilderClass = preload("res://addons/osm_importer/building_builder.gd")
const RoadBuilderClass = preload("res://addons/osm_importer/road_builder.gd")
const GeoJSONParserClass = preload("res://addons/osm_importer/geojson_parser.gd")
const HttpServerClass = preload("res://addons/osm_importer/http_server.gd")

const FIXTURES: Array[String] = [
	"../tests/fixtures/simple_grid.json",
	"../tests/fixtures/bike_infrastructure.json",
	"../tests/fixtures/complex_buildings.json",
	"../tests/fixtures/bridge_overpass.json",
	"../tests/fixtures/sample_city_export.json",
	"../tests/fixtures/medford_y_export.json",
	"../tests/fixtures/overture_city_sample.geojson",
	"../tests/fixtures/medford_y_overture.geojson",
	"../tests/fixtures/editor_scene_export.geojson",
	"../tests/fixtures/representative_neighborhood.json"
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

	print("\n--- Verifying Overture POI & Building Naming ---")
	var overture_naming_ok = verify_overture_poi_naming()
	if overture_naming_ok:
		print("PASS: Overture POI building naming verified")
	else:
		printerr("FAIL: Overture POI building naming verification failed")
	print("\n--- Verifying Editor Export Footprint Authority & Elevation/Thickness ---")
	var editor_export_ok = verify_editor_export_fixture()
	print("\n--- Verifying Semantic Role Dispatching (Roads vs Buildings) ---")
	var semantic_roles_ok = verify_semantic_role_dispatching()
	if semantic_roles_ok:
		print(
			"PASS: Semantic role dispatching verified: road/sidewalk polygons never become building extrusions"
		)
	else:
		printerr("FAIL: Semantic role dispatching verification failed")
		quit(1)
		return

	print("\n--- Verifying Building Holes & Multipart Footprint Extrusion ---")
	var building_holes_multipart_ok = verify_building_holes_and_multipart_extrusion()
	if building_holes_multipart_ok:
		print(
			"PASS: Building holes and multipart footprints preserved through export and extrusion"
		)
	else:
		printerr("FAIL: Building holes and multipart footprint extrusion failed")
		quit(1)
		return
	print("\n--- Verifying Explicit Zero, Absence, and Inclusions ---")
	var zero_absence_inclusions_ok = verify_explicit_zero_absence_and_inclusions()
	if zero_absence_inclusions_ok:
		print("PASS: Explicit zero, absence, and inclusion settings verified")
	else:
		printerr("FAIL: Explicit zero, absence, and inclusion settings verification failed")
		quit(1)
		return

	print("\n--- Verifying Distinct Source-Import Paths (OSM / Overture vs Editor Schema) ---")
	var distinct_paths_ok = verify_distinct_source_import_paths()
	if distinct_paths_ok:
		print(
			"PASS: Distinct source-import paths verified: raw OSM and Overture are not alternate interpretations of editor schema"
		)
	else:
		printerr("FAIL: Distinct source-import paths verification failed")
		quit(1)

	print("\n--- Verifying Editor Payload Version Rejection Contract ---")
	var version_rejection_ok = verify_editor_payload_version_rejection()
	if version_rejection_ok:
		print("PASS: Clear rejection of unsupported/missing editor payload versions verified")
	else:
		printerr("FAIL: Editor payload version rejection verification failed")
		quit(1)
		return

	print("\n--- Verifying Source Attribution and License Preservation ---")
	var attribution_preservation_ok = verify_source_attribution_and_license_preservation()
	if attribution_preservation_ok:
		print("PASS: Source attribution and license preservation verified")
	else:
		printerr("FAIL: Source attribution and license preservation verification failed")
		quit(1)
		return
	print("\n--- Verifying Editor-Specific Payload Application Flow ---")
	var app_flow_ok = verify_editor_payload_application_flow()
	if app_flow_ok:
		print("PASS: Editor-specific payload application flow verified")
	else:
		printerr("FAIL: Editor-specific payload application flow verification failed")
		quit(1)
		return

	print("\n==================================================")
	if (
		passed_tests == total_tests
		and naming_ok
		and overture_naming_ok
		and editor_export_ok
		and semantic_roles_ok
		and building_holes_multipart_ok
		and zero_absence_inclusions_ok
		and distinct_paths_ok
		and version_rejection_ok
		and attribution_preservation_ok
		and app_flow_ok
	):
		print(
			(
				"ALL "
				+ str(total_tests)
				+ " FIXTURES & SPECIAL CHECKS VERIFIED SUCCESSFULLY! (100% PASS)"
			)
		)
		print("==================================================")
		quit(0)
	else:
		printerr(
			"HEADLESS VERIFICATION SUITE FAILED: " + str(total_tests - passed_tests) + " failures."
		)
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
	var parse_res: Dictionary
	if fixture_path.ends_with(".geojson"):
		var parser = GeoJSONParserClass.new()
		parse_res = parser.parse_file(fixture_path)
	else:
		var parser = OSMParserClass.new()
		parse_res = parser.parse_file(fixture_path)
	if parse_res.has("error"):
		printerr("  [FAIL] JSON parsing error: ", parse_res["error"])
		return false

	var roads: Array = parse_res.get("roads", [])
	var buildings: Array = parse_res.get("buildings", [])
	var pois: Array = parse_res.get("pois", [])
	print(
		"  Parsed: roads = ",
		roads.size(),
		", buildings = ",
		buildings.size(),
		", pois = ",
		pois.size()
	)

	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, roads, true, false, false, 500.0, 1500.0, false, pois
	)
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
				if (
					is_nan(v.x)
					or is_nan(v.y)
					or is_nan(v.z)
					or is_inf(v.x)
					or is_inf(v.y)
					or is_inf(v.z)
				):
					printerr("  [FAIL] NaN/Inf detected in vertex array of ", mi.name)
					city_root.free()
					return false

			if not normals.is_empty():
				for n in normals:
					if (
						is_nan(n.x)
						or is_nan(n.y)
						or is_nan(n.z)
						or is_inf(n.x)
						or is_inf(n.y)
						or is_inf(n.z)
					):
						printerr("  [FAIL] NaN/Inf detected in normal array of ", mi.name)
						city_root.free()
						return false

	print(
		"  Verification: total vertices = ",
		total_vertices,
		", triangles = ",
		total_triangles,
		", zero NaNs, valid AABBs"
	)
	city_root.free()
	# Also verify CSG building scene generation
	if buildings.size() > 0:
		var csg_city = OSMSceneBuilderClass.build_city_scene(
			buildings, roads, true, false, false, 500.0, 1500.0, true
		)
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

	print(
		"  Verified building names: Dunkin', 7-Eleven, Circle K, 9 Emerson Street, 20 Thomas Street."
	)
	b_root.free()

	# Also verify SceneBuilder creates POIs group with Marker3D children
	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, [], false, false, false, 500.0, 1500.0, false, pois
	)
	var pois_node = city_root.get_node_or_null("POIs")
	if pois_node == null or pois_node.get_child_count() != 9:
		printerr("  [FAIL] Expected POIs node with 9 Marker3D children in CityRoot")
		city_root.free()
		return false
	print("  Verified SceneBuilder POIs node with 9 children.")
	city_root.free()

	return true


func verify_overture_poi_naming() -> bool:
	var parser = GeoJSONParserClass.new()
	var parse_res = parser.parse_file("../tests/fixtures/medford_y_overture.geojson")
	if parse_res.has("error"):
		printerr("  [FAIL] Could not load medford_y_overture.geojson: ", parse_res["error"])
		return false

	var pois: Array = parse_res.get("pois", [])
	if pois.is_empty():
		printerr("  [FAIL] Expected POIs in medford_y_overture.geojson, found 0")
		return false
	print("  Extracted ", pois.size(), " Overture POI nodes from 'place' features.")

	var buildings: Array = parse_res.get("buildings", [])
	if buildings.is_empty():
		printerr("  [FAIL] Expected buildings in medford_y_overture.geojson, found 0")
		return false

	var b_root = BuildingBuilderClass.build_buildings_node(buildings, true, false, false)
	if b_root == null:
		printerr("  [FAIL] Failed to build buildings node for Overture")
		return false

	var found_names: Dictionary = {}
	for child in b_root.get_children():
		found_names[child.name] = true

	# Check known buildings labeled via Overture POIs
	var expected_poi_labels = [
		"Mobil", "Grava Chrysler Dodge Jeep Ram SRT", "VOLSAR Automotive Service"
	]
	var matched_any = false
	for exp in expected_poi_labels:
		var sanitized = BuildingBuilderClass.sanitize_node_name(exp)
		if found_names.has(sanitized):
			matched_any = true
			print("  Found Overture POI-labeled building node: ", sanitized)

	if not matched_any:
		printerr(
			"  [FAIL] Expected at least one POI-labeled building from Overture, found: ",
			found_names.keys()
		)
		b_root.free()
		return false

	# Verify metadata on a labeled node
	var mobil_node = b_root.get_node_or_null("Mobil") as MeshInstance3D
	if mobil_node != null:
		if not mobil_node.has_meta("osm_name"):
			printerr("  [FAIL] Missing osm_name metadata on Mobil node")
			b_root.free()
			return false
		print(
			"  Verified osm_name metadata on Mobil building node: ", mobil_node.get_meta("osm_name")
		)

	b_root.free()

	# Verify SceneBuilder creates POIs with Marker3D nodes from Overture
	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, [], false, false, false, 500.0, 1500.0, false, pois
	)
	var pois_node = city_root.get_node_or_null("POIs")
	if pois_node == null or pois_node.get_child_count() == 0:
		printerr("  [FAIL] Expected POIs node with Marker3D children in CityRoot for Overture")
		city_root.free()
		return false
	print(
		"  Verified SceneBuilder POIs node with ",
		pois_node.get_child_count(),
		" Marker3D children."
	)
	city_root.free()

	return true


func verify_editor_export_fixture() -> bool:
	var parser = GeoJSONParserClass.new()
	var parse_res = parser.parse_file("../tests/fixtures/editor_scene_export.geojson")
	if parse_res.has("error"):
		printerr("  [FAIL] Could not load editor_scene_export.geojson: ", parse_res["error"])
		return false

	var roads: Array = parse_res.get("roads", [])
	var buildings: Array = parse_res.get("buildings", [])

	# 4 road surfaces (carriageway, sidewalk, bike lane, cross carriageway) and 1 building
	if roads.size() != 4:
		printerr("  [FAIL] Expected 4 road surfaces from editor export, found: ", roads.size())
		return false
	if buildings.size() != 1:
		printerr("  [FAIL] Expected 1 building from editor export, found: ", buildings.size())
		return false
	var centerlines: Array = parse_res.get("centerlines", [])
	if centerlines.is_empty():
		printerr("  [FAIL] Expected semantic centerlines in editor export, found 0")
		return false
	print("  Verified semantic centerlines retained: count = ", centerlines.size())
	for cl in centerlines:
		if not cl.has("points") or cl["points"].size() < 2:
			printerr("  [FAIL] Semantic centerline missing projected points: ", cl.get("id"))
			return false
		if not cl.has("profile"):
			printerr("  [FAIL] Semantic centerline missing profile dictionary: ", cl.get("id"))
			return false

	for r in roads:
		if not r.get("is_authoritative_surface", false):
			printerr("  [FAIL] Road surface missing is_authoritative_surface flag: ", r.get("id"))
			return false
		var outer: Array = r.get("outer_rings", [])
		if outer.is_empty() or outer[0].size() < 3:
			printerr("  [FAIL] Road surface missing valid outer ring: ", r.get("id"))
			return false

	# Verify building holes preserved
	var b = buildings[0]
	var b_inner: Array = b.get("inner_rings", [])
	if b_inner.is_empty():
		printerr("  [FAIL] Building plaza missing courtyard inner ring (hole)")
		return false
	print(
		"  Verified building hole in editor export: 1 outer ring, ",
		b_inner.size(),
		" inner ring(s)."
	)

	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, roads, true, false, false, 500.0, 1500.0, false
	)
	if city_root == null:
		printerr("  [FAIL] SceneBuilder returned null for editor export scene")
		return false

	var streets = city_root.get_node_or_null("Streets")
	if streets == null:
		printerr("  [FAIL] Streets node missing in city root")
		city_root.free()
		return false

	var found_asphalt = false
	var found_footway = false
	var found_bike_lane = false

	for child in streets.get_children():
		if child is MeshInstance3D:
			var c_lower = child.name.to_lower()
			if c_lower.contains("asphalt"):
				found_asphalt = true
			elif c_lower.contains("footway"):
				found_footway = true
			elif c_lower.contains("bike"):
				found_bike_lane = true

			var col = child.get_node_or_null("Collision") as StaticBody3D
			if col == null or col.get_child_count() == 0:
				printerr("  [FAIL] MeshInstance3D missing collider: ", child.name)
				city_root.free()
				return false

			# Verify mesh thickness / skirt
			var mesh = child.mesh as ArrayMesh
			if mesh != null and mesh.get_surface_count() > 0:
				var arrays = mesh.surface_get_arrays(0)
				var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
				var min_y = INF
				var max_y = -INF
				for v in verts:
					min_y = minf(min_y, v.y)
					max_y = maxf(max_y, v.y)
				if max_y <= min_y:
					printerr("  [FAIL] Road mesh has zero thickness / elevation span: ", child.name)
					city_root.free()
					return false
				print(
					"  Verified ",
					child.name,
					" vertical span: [",
					min_y,
					" .. ",
					max_y,
					"], vertices = ",
					verts.size()
				)

	if not (found_asphalt and found_footway and found_bike_lane):
		printerr(
			"  [FAIL] Expected asphalt, footway, and bike_lane meshes under Streets, found: asphalt=",
			found_asphalt,
			", footway=",
			found_footway,
			", bike_lane=",
			found_bike_lane
		)
		city_root.free()
		return false

	city_root.free()

	# Verify semantic centerline LineString features do not regenerate conflicting footprints
	var test_payload = {
		"type": "FeatureCollection",
		"editorPayloadVersion": "1.0.0",
		"generator": "osm-to-godot-editor",
		"metadata": {"generator": "osm-to-godot-editor", "version": "1.0.0"},
		"projectionOrigin": {"lon": -71.11, "lat": 42.415},
		"features":
		[
			{
				"type": "Feature",
				"id": "surf_road_1",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.41505],
							[-71.108, 42.41505],
							[-71.108, 42.41495],
							[-71.112, 42.41495],
							[-71.112, 42.41505]
						]
					]
				},
				"properties":
				{
					"id": "surf_road_1",
					"parentFeatureId": "way_1",
					"role": "road",
					"isFootprintAuthority": true,
					"roadProfile": {"carriagewayWidthMeters": {"value": 8.0, "unit": "m"}},
					"centerline":
					{"type": "LineString", "coordinates": [[-71.112, 42.415], [-71.108, 42.415]]}
				}
			},
			{
				"type": "Feature",
				"id": "centerline_way_1",
				"geometry":
				{"type": "LineString", "coordinates": [[-71.112, 42.415], [-71.108, 42.415]]},
				"properties":
				{
					"id": "centerline_way_1",
					"parentFeatureId": "way_1",
					"role": "centerline",
					"isSemanticCenterline": true,
					"isFootprintAuthority": false,
					"roadProfile": {"carriagewayWidthMeters": {"value": 8.0, "unit": "m"}}
				}
			}
		]
	}
	var test_parsed = parser.parse_data(test_payload)
	var test_roads: Array = test_parsed.get("roads", [])
	var test_cls: Array = test_parsed.get("centerlines", [])
	if test_cls.is_empty():
		printerr("  [FAIL] Expected semantic centerlines in test payload with centerline feature")
		return false
	var found_semantic_only = false
	for tr in test_roads:
		if tr.get("id") == "centerline_way_1":
			if tr.get("is_semantic_only", false) and tr.get("role") == "centerline":
				found_semantic_only = true
	if not found_semantic_only:
		printerr("  [FAIL] Expected centerline_way_1 to be marked is_semantic_only")
		return false

	var test_city = OSMSceneBuilderClass.build_city_scene([], test_roads, false)
	var test_streets = test_city.get_node_or_null("Streets")
	if test_streets:
		var mesh_count = 0
		for child in test_streets.get_children():
			if child is MeshInstance3D:
				mesh_count += 1
		if mesh_count != 1:
			printerr(
				"  [FAIL] Conflicting footprint regenerated: expected 1 road mesh, got ", mesh_count
			)
			test_city.free()
			return false
		print("  Verified no conflicting footprint regenerated for semantic centerline feature.")
	test_city.free()

	return true


func verify_semantic_role_dispatching() -> bool:
	var parser = GeoJSONParserClass.new()
	var test_payload = {
		"type": "FeatureCollection",
		"projectionOrigin": {"lon": -71.11, "lat": 42.415},
		"features":
		[
			{
				"type": "Feature",
				"id": "surf_road_carriageway",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.41505],
							[-71.108, 42.41505],
							[-71.108, 42.41495],
							[-71.112, 42.41495],
							[-71.112, 42.41505]
						]
					]
				},
				"properties": {"role": "road", "kind": "carriageway", "surface": "asphalt"}
			},
			{
				"type": "Feature",
				"id": "surf_sidewalk",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.41515],
							[-71.108, 42.41515],
							[-71.108, 42.41505],
							[-71.112, 42.41505],
							[-71.112, 42.41515]
						]
					]
				},
				"properties": {"role": "sidewalk", "kind": "sidewalk", "surface": "concrete"}
			},
			{
				"type": "Feature",
				"id": "surf_bike_lane",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.41525],
							[-71.108, 42.41525],
							[-71.108, 42.41515],
							[-71.112, 42.41515],
							[-71.112, 42.41525]
						]
					]
				},
				"properties": {"role": "bike_lane", "kind": "bike_lane"}
			},
			{
				"type": "Feature",
				"id": "surf_highway_footway_tag",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.41535],
							[-71.108, 42.41535],
							[-71.108, 42.41525],
							[-71.112, 42.41525],
							[-71.112, 42.41535]
						]
					]
				},
				"properties": {"highway": "footway"}
			},
			{
				"type": "Feature",
				"id": "real_building_1",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.111, 42.416],
							[-71.110, 42.416],
							[-71.110, 42.417],
							[-71.111, 42.417],
							[-71.111, 42.416]
						]
					]
				},
				"properties": {"role": "building", "height": 12.0}
			}
		]
	}

	var parsed = parser.parse_data(test_payload)
	var buildings: Array = parsed.get("buildings", [])
	var roads: Array = parsed.get("roads", [])

	# 1. GeoJSONParser dispatching verification
	if buildings.size() != 1:
		printerr("  [FAIL] Expected exactly 1 building, got ", buildings.size())
		return false
	if buildings[0].get("id") != "real_building_1":
		printerr("  [FAIL] Expected real_building_1 in buildings, got ", buildings[0].get("id"))
		return false
	if roads.size() != 4:
		printerr(
			"  [FAIL] Expected exactly 4 road/sidewalk/bike surfaces in roads, got ", roads.size()
		)
		return false

	for b in buildings:
		var b_role = str(b.get("role", "")).to_lower()
		if b_role in ["road", "sidewalk", "bike_lane", "carriageway", "footway"]:
			printerr("  [FAIL] Road/sidewalk feature found in buildings array: ", b.get("id"))
			return false

	# 2. Downstream BuildingBuilder verification:
	# BuildingBuilder must only generate buildings, never extrude road or sidewalk polygons
	var b_root = BuildingBuilderClass.build_buildings_node(buildings, true, false, false)
	if b_root.get_child_count() != 1:
		printerr("  [FAIL] Expected 1 building mesh instance, got ", b_root.get_child_count())
		b_root.free()
		return false
	b_root.free()

	# If road/sidewalk polygons were accidentally passed to BuildingBuilder:
	var accidental_b_root = BuildingBuilderClass.build_buildings_node(roads, true, false, false)
	if accidental_b_root.get_child_count() != 0:
		printerr(
			"  [FAIL] Road/sidewalk polygons were extruded as buildings! Child count: ",
			accidental_b_root.get_child_count()
		)
		accidental_b_root.free()
		return false
	accidental_b_root.free()

	# Accidental pass to CSG mode
	var accidental_csg_root = BuildingBuilderClass.build_buildings_node(roads, true, false, true)
	if accidental_csg_root.get_child_count() != 0:
		printerr(
			"  [FAIL] Road/sidewalk polygons were extruded as CSG buildings! Child count: ",
			accidental_csg_root.get_child_count()
		)
		accidental_csg_root.free()
		return false
	accidental_csg_root.free()

	# 3. Downstream RoadBuilder verification:
	# RoadBuilder must correctly create surfaces for the 4 road/sidewalk features
	var streets = RoadBuilderClass.build_roads_node(roads, true)
	if streets == null:
		printerr("  [FAIL] RoadBuilder failed to build roads node")
		return false
	var street_mesh_count = 0
	for child in streets.get_children():
		if child is MeshInstance3D:
			street_mesh_count += 1
	if street_mesh_count == 0:
		printerr("  [FAIL] Expected MeshInstance3D nodes under Streets, found none")
		streets.free()
		return false
	streets.free()

	# RoadBuilder must skip building features if passed
	var accidental_streets = RoadBuilderClass.build_roads_node(buildings, true)
	var accidental_road_count = 0
	for child in accidental_streets.get_children():
		if child is MeshInstance3D:
			accidental_road_count += 1
	if accidental_road_count != 0:
		printerr("  [FAIL] Building features were built as roads! Count: ", accidental_road_count)
		accidental_streets.free()
		return false
	accidental_streets.free()
	return true


func verify_building_holes_and_multipart_extrusion() -> bool:
	var parser = GeoJSONParserClass.new()
	var test_payload = {
		"type": "FeatureCollection",
		"projectionOrigin": {"lon": -71.11, "lat": 42.415},
		"features":
		[
			# 1. Building with a courtyard hole (Polygon)
			{
				"type": "Feature",
				"id": "bldg_courtyard",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						# Outer ring (CCW)
						[
							[-71.112, 42.415],
							[-71.110, 42.415],
							[-71.110, 42.417],
							[-71.112, 42.417],
							[-71.112, 42.415]
						],
						# Courtyard hole (CW)
						[
							[-71.1115, 42.4155],
							[-71.1115, 42.4165],
							[-71.1105, 42.4165],
							[-71.1105, 42.4155],
							[-71.1115, 42.4155]
						]
					]
				},
				"properties": {"role": "building", "name": "Courtyard Hall", "height": 16.0}
			},
			# 2. Multipart building (MultiPolygon) with 2 parts: part 0 has hole, part 1 has no hole
			{
				"type": "Feature",
				"id": "bldg_multipart",
				"geometry":
				{
					"type": "MultiPolygon",
					"coordinates":
					[
						# Part 0: outer + hole
						[
							[
								[-71.108, 42.415],
								[-71.106, 42.415],
								[-71.106, 42.417],
								[-71.108, 42.417],
								[-71.108, 42.415]
							],
							[
								[-71.1075, 42.4155],
								[-71.1075, 42.4165],
								[-71.1065, 42.4165],
								[-71.1065, 42.4155],
								[-71.1075, 42.4155]
							]
						],
						# Part 1: outer only
						[
							[
								[-71.105, 42.415],
								[-71.104, 42.415],
								[-71.104, 42.416],
								[-71.105, 42.416],
								[-71.105, 42.415]
							]
						]
					]
				},
				"properties": {"role": "building", "name": "Hospital Complex", "height": 22.0}
			}
		]
	}

	var parsed = parser.parse_data(test_payload)
	var buildings: Array = parsed.get("buildings", [])
	if buildings.size() != 2:
		printerr("  [FAIL] Expected 2 parsed buildings, got ", buildings.size())
		return false

	var b_court: Dictionary = buildings[0]
	var b_multi: Dictionary = buildings[1]

	# 1. Verify courtyard building structure
	var court_outers: Array = b_court.get("outer_rings", [])
	var court_inners: Array = b_court.get("inner_rings", [])
	if court_outers.size() != 1 or court_inners.size() != 1:
		printerr(
			"  [FAIL] Expected bldg_courtyard to have 1 outer ring and 1 inner ring, got ",
			court_outers.size(),
			" outers and ",
			court_inners.size(),
			" inners"
		)
		return false

	# 2. Verify multipart building structure
	var multi_outers: Array = b_multi.get("outer_rings", [])
	var multi_inners: Array = b_multi.get("inner_rings", [])
	if multi_outers.size() != 2:
		printerr(
			"  [FAIL] Expected bldg_multipart to have 2 outer rings (parts), got ",
			multi_outers.size()
		)
		return false
	if multi_inners.size() != 1:
		printerr(
			"  [FAIL] Expected bldg_multipart to have 1 inner ring (hole in part 0), got ",
			multi_inners.size()
		)
		return false

	# 3. Test Mesh Extrusion for bldg_courtyard
	var court_mesh_data = BuildingBuilderClass.build_building_mesh_data(b_court)
	var court_walls = court_mesh_data.get("walls", {})
	var court_roof = court_mesh_data.get("roof", {})
	var court_w_verts: PackedVector3Array = court_walls.get("vertices", PackedVector3Array())
	var court_r_verts: PackedVector3Array = court_roof.get("vertices", PackedVector3Array())
	var court_r_indices: PackedInt32Array = court_roof.get("indices", PackedInt32Array())
	if court_w_verts.size() < 24:  # 4 outer quads (16 verts) + 4 inner quads (16 verts)
		printerr(
			"  [FAIL] Courtyard building wall vertices missing inner hole walls: count = ",
			court_w_verts.size()
		)
		return false
	if court_r_verts.is_empty() or court_r_indices.is_empty():
		printerr("  [FAIL] Courtyard building roof triangulation produced no vertices/indices")
		return false

	var court_node = BuildingBuilderClass.create_building_node(b_court, true)
	if court_node == null or court_node.mesh == null:
		printerr(
			"  [FAIL] create_building_node returned null or meshless instance for courtyard building"
		)
		return false
	var court_col = court_node.get_node_or_null("StaticBody3D")
	if court_col == null or court_col.get_child_count() == 0:
		printerr("  [FAIL] Courtyard building node missing StaticBody3D collision")
		court_node.free()
		return false
	court_node.free()

	# 4. Test Mesh Extrusion for bldg_multipart
	var multi_mesh_data = BuildingBuilderClass.build_building_mesh_data(b_multi)
	var multi_walls = multi_mesh_data.get("walls", {})
	var multi_roof = multi_mesh_data.get("roof", {})
	var multi_w_verts: PackedVector3Array = multi_walls.get("vertices", PackedVector3Array())
	var multi_r_verts: PackedVector3Array = multi_roof.get("vertices", PackedVector3Array())
	var multi_r_indices: PackedInt32Array = multi_roof.get("indices", PackedInt32Array())
	if multi_w_verts.size() < 32:  # part 0 outer + hole walls + part 1 outer walls
		printerr(
			"  [FAIL] Multipart building wall vertices too few: count = ", multi_w_verts.size()
		)
		return false
	if multi_r_verts.is_empty() or multi_r_indices.is_empty():
		printerr("  [FAIL] Multipart building roof triangulation produced no vertices/indices")
		return false

	var multi_node = BuildingBuilderClass.create_building_node(b_multi, true)
	if multi_node == null or multi_node.mesh == null:
		printerr(
			"  [FAIL] create_building_node returned null or meshless instance for multipart building"
		)
		return false
	var multi_col = multi_node.get_node_or_null("StaticBody3D")
	if multi_col == null or multi_col.get_child_count() == 0:
		printerr("  [FAIL] Multipart building node missing StaticBody3D collision")
		multi_node.free()
		return false
	multi_node.free()

	# 5. Test CSG Extrusion for bldg_courtyard
	var court_csg = BuildingBuilderClass.create_csg_building_node(b_court, true)
	if court_csg == null:
		printerr("  [FAIL] create_csg_building_node returned null for courtyard building")
		return false
	if not (court_csg is CSGPolygon3D):
		printerr("  [FAIL] Expected single-part courtyard building CSG to be CSGPolygon3D")
		court_csg.free()
		return false
	var court_hole_child = court_csg.get_node_or_null("Hole_0") as CSGPolygon3D
	if court_hole_child == null or court_hole_child.operation != CSGShape3D.OPERATION_SUBTRACTION:
		printerr("  [FAIL] Courtyard CSG missing Hole_0 subtraction child node")
		court_csg.free()
		return false
	court_csg.free()

	# 6. Test CSG Extrusion for bldg_multipart
	var multi_csg = BuildingBuilderClass.create_csg_building_node(b_multi, true)
	if multi_csg == null:
		printerr("  [FAIL] create_csg_building_node returned null for multipart building")
		return false
	# For multipart building with 2 outer rings, create_csg_building_node returns Node3D with 2 child CSGPolygon3D nodes
	if multi_csg.get_child_count() != 2:
		printerr(
			"  [FAIL] Expected multipart CSG root to have 2 children, got ",
			multi_csg.get_child_count()
		)
		multi_csg.free()
		return false
	var csg_part_0 = multi_csg.get_child(0) as CSGPolygon3D
	var csg_part_1 = multi_csg.get_child(1) as CSGPolygon3D
	if csg_part_0 == null or csg_part_1 == null:
		printerr("  [FAIL] Multipart CSG children are not CSGPolygon3D")
		multi_csg.free()
		return false
	# Part 0 contains the hole -> has child Hole_0
	var part_0_hole = csg_part_0.get_node_or_null("Hole_0")
	if part_0_hole == null:
		printerr("  [FAIL] Multipart CSG part 0 missing Hole_0")
		multi_csg.free()
		return false
	# Part 1 does NOT contain the hole -> has NO child holes
	if csg_part_1.get_child_count() != 0:
		printerr(
			"  [FAIL] Multipart CSG part 1 erroneously received child holes: count = ",
			csg_part_1.get_child_count()
		)
		multi_csg.free()
		return false
	multi_csg.free()

	# 7. Test whole scene building node construction
	var b_root_mesh = BuildingBuilderClass.build_buildings_node(buildings, true, false, false)
	if b_root_mesh.get_child_count() != 2:
		printerr(
			"  [FAIL] build_buildings_node (mesh) expected 2 children, got ",
			b_root_mesh.get_child_count()
		)
		b_root_mesh.free()
		return false
	b_root_mesh.free()

	var b_root_csg = BuildingBuilderClass.build_buildings_node(buildings, true, false, true)
	if b_root_csg.get_child_count() != 2:
		printerr(
			"  [FAIL] build_buildings_node (CSG) expected 2 children, got ",
			b_root_csg.get_child_count()
		)
		b_root_csg.free()
		return false
	b_root_csg.free()

	print("  Verified building courtyard hole and multipart footprints in mesh and CSG extrusion.")
	return true


func verify_explicit_zero_absence_and_inclusions() -> bool:
	print("  Running explicit zero, absence, and inclusions tests...")
	var parser = GeoJSONParserClass.new()

	# 1. Test exportInclusions and per-feature exportInclusion
	var payload_with_inclusions = {
		"type": "FeatureCollection",
		"editorPayloadVersion": "1.0.0",
		"metadata":
		{
			"generator": "osm-to-godot-editor",
			"version": "1.0.0",
			"exportInclusions":
			{
				"building": false,
				"sidewalk": false,
				"road": true,
				"carriageway": true,
				"cycling": true,
				"bike_lane": true
			},
			"exclusions": ["building", "sidewalk"]
		},
		"features":
		[
			{
				"type": "Feature",
				"id": "f_carriageway",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.410],
							[-71.108, 42.410],
							[-71.108, 42.41006],
							[-71.112, 42.41006],
							[-71.112, 42.410]
						]
					]
				},
				"properties":
				{
					"role": "carriageway",
					"kind": "carriageway",
					"isFootprintAuthority": true,
					"widthMeters": 7.0,
					"sidewalk": "no",
					"cycleway": "no",
					"layer": 0
				}
			},
			{
				"type": "Feature",
				"id": "f_sidewalk",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.41006],
							[-71.108, 42.41006],
							[-71.108, 42.41008],
							[-71.112, 42.41008],
							[-71.112, 42.41006]
						]
					]
				},
				"properties": {"role": "sidewalk", "kind": "sidewalk", "isFootprintAuthority": true}
			},
			{
				"type": "Feature",
				"id": "f_bike_lane",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.40998],
							[-71.108, 42.40998],
							[-71.108, 42.410],
							[-71.112, 42.410],
							[-71.112, 42.40998]
						]
					]
				},
				"properties":
				{"role": "bike_lane", "kind": "bike_lane", "isFootprintAuthority": true}
			},
			{
				"type": "Feature",
				"id": "f_building",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.110, 42.411],
							[-71.109, 42.411],
							[-71.109, 42.412],
							[-71.110, 42.412],
							[-71.110, 42.411]
						]
					]
				},
				"properties": {"role": "building", "kind": "building", "heightMeters": 15.0}
			},
			{
				"type": "Feature",
				"id": "f_road_excluded_directly",
				"geometry":
				{"type": "LineString", "coordinates": [[-71.111, 42.410], [-71.110, 42.410]]},
				"properties": {"role": "road", "exportInclusion": false}
			}
		]
	}

	var parsed = parser.parse_data(payload_with_inclusions)
	if not parsed.has("export_inclusions"):
		printerr("  [FAIL] Parsed result missing export_inclusions")
		return false
	if parsed["export_inclusions"].get("building") != false:
		printerr("  [FAIL] export_inclusions.building was not preserved as false")
		return false
	if parsed["export_inclusions"].get("sidewalk") != false:
		printerr("  [FAIL] export_inclusions.sidewalk was not preserved as false")
		return false

	var buildings: Array = parsed.get("buildings", [])
	if not buildings.is_empty():
		printerr(
			"  [FAIL] Buildings were not excluded by exportInclusions.building = false! count: ",
			buildings.size()
		)
		return false

	var roads: Array = parsed.get("roads", [])
	# Expected: f_carriageway and f_bike_lane included; f_sidewalk excluded; f_road_excluded_directly excluded
	if roads.size() != 2:
		printerr(
			"  [FAIL] Expected exactly 2 road surfaces (carriageway & bike_lane), got: ",
			roads.size()
		)
		return false

	for r in roads:
		if r.get("id") == "f_sidewalk":
			printerr("  [FAIL] Excluded sidewalk was present in parsed roads")
			return false
		if r.get("id") == "f_road_excluded_directly":
			printerr("  [FAIL] Feature with exportInclusion=false was present in parsed roads")
			return false

	# 2. Test explicit zero dimensions surviving parsing
	var cw_road = roads[0]
	var cw_tags: Dictionary = cw_road.get("tags", {})
	if cw_tags.get("layer") != "0":
		printerr("  [FAIL] Layer 0 was not preserved as '0', got: ", cw_tags.get("layer"))
		return false
	if cw_tags.get("sidewalk") != "no":
		printerr(
			"  [FAIL] Sidewalk absence tag was not preserved as 'no', got: ",
			cw_tags.get("sidewalk")
		)
		return false
	if cw_tags.get("cycleway") != "no":
		printerr(
			"  [FAIL] Cycleway absence tag was not preserved as 'no', got: ",
			cw_tags.get("cycleway")
		)
		return false

	# 3. Test building explicit zero height
	var zero_height_tags: Dictionary = {"building": "yes", "height": "0"}
	var h_zero = BuildingBuilderClass.resolve_height(zero_height_tags)
	if h_zero["height"] != 0.0:
		printerr("  [FAIL] Explicit zero height resolved to non-zero: ", h_zero["height"])
		return false
	if not h_zero["is_explicit"]:
		printerr("  [FAIL] Explicit zero height was not marked is_explicit")
		return false

	var zero_building = {
		"id": "b_zero",
		"tags": zero_height_tags,
		"outer_rings":
		[
			PackedVector3Array(
				[
					Vector3(0, 0, 0),
					Vector3(10, 0, 0),
					Vector3(10, 0, 10),
					Vector3(0, 0, 10),
					Vector3(0, 0, 0)
				]
			)
		],
		"inner_rings": []
	}
	var zero_mesh = BuildingBuilderClass.build_building_mesh_data(zero_building)
	var zero_wall_verts: PackedVector3Array = zero_mesh["walls"]["vertices"]
	var zero_roof_verts: PackedVector3Array = zero_mesh["roof"]["vertices"]
	if not zero_wall_verts.is_empty():
		printerr(
			"  [FAIL] Explicit zero height building generated wall vertices: count = ",
			zero_wall_verts.size()
		)
		return false
	if zero_roof_verts.is_empty():
		printerr("  [FAIL] Explicit zero height building missing flat roof polygon")
		return false

	# 4. Test explicit absence for bike lanes and sidewalks (defaults do not recreate)
	var absent_cycle_tags: Dictionary = {"highway": "cycleway", "cycleway": "no", "bicycle": "no"}
	var bike_absent_info = RoadBuilderClass.parse_bike_lanes(absent_cycle_tags)
	if bike_absent_info["has_bike_lane"] or bike_absent_info["total_bike_width"] > 0.0:
		printerr(
			"  [FAIL] Defaults recreated bike lanes when explicitly absent: ", bike_absent_info
		)
		return false

	var asym_cycle_tags: Dictionary = {
		"highway": "secondary", "cycleway:left": "no", "cycleway:right": "lane"
	}
	var asym_bike_info = RoadBuilderClass.parse_bike_lanes(asym_cycle_tags)
	if asym_bike_info["left_width"] != 0.0:
		printerr(
			"  [FAIL] Left bike lane recreated when cycleway:left=no: ",
			asym_bike_info["left_width"]
		)
		return false
	if asym_bike_info["right_width"] != 1.5:
		printerr(
			"  [FAIL] Right bike lane missing with cycleway:right=lane: ",
			asym_bike_info["right_width"]
		)
		return false

	print(
		"  Verified explicit zero dimensions, explicit absence, and inclusion settings survive parsing."
	)
	return true


func verify_distinct_source_import_paths() -> bool:
	# 1. Verify Raw Overture GeoJSON Import Path
	var geojson_parser = GeoJSONParserClass.new()
	var overture_res = geojson_parser.parse_file("../tests/fixtures/overture_city_sample.geojson")
	if overture_res.has("error"):
		printerr("  [FAIL] Failed to parse Overture fixture: ", overture_res["error"])
		return false
	if overture_res.get("source_type") != "overture":
		printerr("  [FAIL] Expected source_type 'overture', got: ", overture_res.get("source_type"))
		return false
	if overture_res.get("is_editor_payload") != false:
		printerr("  [FAIL] Raw Overture must not be marked as is_editor_payload")
		return false
	if overture_res.get("is_raw_source_import") != true:
		printerr("  [FAIL] Raw Overture must be marked as is_raw_source_import")
		return false
	var ov_roads: Array = overture_res.get("roads", [])
	if ov_roads.is_empty():
		printerr("  [FAIL] Raw Overture roads array is empty")
		return false
	for r in ov_roads:
		if r.get("is_authoritative_surface", false):
			printerr("  [FAIL] Raw Overture road must not have is_authoritative_surface=true")
			return false
		if r.get("is_semantic_only", false):
			printerr("  [FAIL] Raw Overture road must not be marked is_semantic_only")
			return false

	# 2. Verify Raw OSM JSON Import Path
	var osm_parser = OSMParserClass.new()
	var osm_res = osm_parser.parse_file("../tests/fixtures/medford_y_export.json")
	if osm_res.has("error"):
		printerr("  [FAIL] Failed to parse raw OSM JSON fixture: ", osm_res["error"])
		return false
	if osm_res.get("source_type") != "osm":
		printerr("  [FAIL] Expected source_type 'osm', got: ", osm_res.get("source_type"))
		return false
	if osm_res.get("is_editor_payload") != false:
		printerr("  [FAIL] Raw OSM JSON must not be marked as is_editor_payload")
		return false
	if osm_res.get("is_raw_source_import") != true:
		printerr("  [FAIL] Raw OSM JSON must be marked as is_raw_source_import")
		return false

	# 3. Verify Raw OSM GeoJSON Import Path (FeatureCollection with OSM tags)
	var raw_osm_geojson = {
		"type": "FeatureCollection",
		"metadata": {"source": "OpenStreetMap", "generator": "Overpass Turbo"},
		"features":
		[
			{
				"type": "Feature",
				"id": "way/9001",
				"geometry":
				{"type": "LineString", "coordinates": [[-71.11, 42.41], [-71.11, 42.42]]},
				"properties":
				{"highway": "primary", "name": "Main Boulevard", "lanes": "4", "width": "14"}
			},
			{
				"type": "Feature",
				"id": "way/9002",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.112, 42.412],
							[-71.111, 42.412],
							[-71.111, 42.413],
							[-71.112, 42.413],
							[-71.112, 42.412]
						]
					]
				},
				"properties":
				{"building": "commercial", "name": "Office Complex", "building:levels": "4"}
			}
		]
	}
	var raw_osm_geo_res = geojson_parser.parse_data(raw_osm_geojson)
	if raw_osm_geo_res.get("source_type") != "osm":
		printerr(
			"  [FAIL] Expected raw OSM GeoJSON source_type 'osm', got: ",
			raw_osm_geo_res.get("source_type")
		)
		return false
	if raw_osm_geo_res.get("is_editor_payload") != false:
		printerr("  [FAIL] Raw OSM GeoJSON must not be marked as is_editor_payload")
		return false
	if raw_osm_geo_res.get("is_raw_source_import") != true:
		printerr("  [FAIL] Raw OSM GeoJSON must be marked as is_raw_source_import")
		return false
	var raw_osm_roads: Array = raw_osm_geo_res.get("roads", [])
	if raw_osm_roads.size() != 1:
		printerr("  [FAIL] Expected 1 road in raw OSM GeoJSON, got: ", raw_osm_roads.size())
		return false
	if raw_osm_roads[0].get("is_authoritative_surface", false):
		printerr("  [FAIL] Raw OSM GeoJSON road must not have is_authoritative_surface=true")
		return false
	if raw_osm_roads[0].get("is_semantic_only", false):
		printerr("  [FAIL] Raw OSM GeoJSON road must not be is_semantic_only")
		return false
	var raw_osm_buildings: Array = raw_osm_geo_res.get("buildings", [])
	if raw_osm_buildings.size() != 1:
		printerr("  [FAIL] Expected 1 building in raw OSM GeoJSON, got: ", raw_osm_buildings.size())
		return false
	if raw_osm_buildings[0].get("is_authoritative_surface", false):
		printerr("  [FAIL] Raw OSM GeoJSON building must not have is_authoritative_surface=true")
		return false

	# 4. Verify Editor Export Schema Import Path
	var editor_res = geojson_parser.parse_file("../tests/fixtures/editor_scene_export.geojson")
	if editor_res.has("error"):
		printerr("  [FAIL] Failed to parse editor export fixture: ", editor_res["error"])
		return false
	if editor_res.get("source_type") != "editor":
		printerr(
			"  [FAIL] Expected editor source_type 'editor', got: ", editor_res.get("source_type")
		)
		return false
	if editor_res.get("is_editor_payload") != true:
		printerr("  [FAIL] Editor export must be marked as is_editor_payload=true")
		return false
	if editor_res.get("is_raw_source_import") != false:
		printerr("  [FAIL] Editor export must not be marked as is_raw_source_import")
		return false
	var editor_roads: Array = editor_res.get("roads", [])
	var has_auth = false
	for er in editor_roads:
		if er.get("is_authoritative_surface", false):
			has_auth = true
			break
	if not has_auth:
		printerr("  [FAIL] Editor export roads must contain authoritative surfaces")
		return false

	# 5. Non-bleeding check: Raw GeoJSON features must NOT become authoritative surfaces
	var raw_with_road_name = {
		"type": "FeatureCollection",
		"metadata": {"source": "test_raw"},
		"features":
		[
			{
				"type": "Feature",
				"id": "poly/1",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.11, 42.41],
							[-71.109, 42.41],
							[-71.109, 42.411],
							[-71.11, 42.411],
							[-71.11, 42.41]
						]
					]
				},
				"properties": {"building": "yes", "name": "Carriageway Plaza Station"}
			}
		]
	}
	var non_bleeding_res = geojson_parser.parse_data(raw_with_road_name)
	var nb_buildings: Array = non_bleeding_res.get("buildings", [])
	if nb_buildings.size() != 1:
		printerr(
			"  [FAIL] Raw polygon was not parsed as building in raw source path: ",
			nb_buildings.size()
		)
		return false
	if nb_buildings[0].get("is_authoritative_surface", false):
		printerr("  [FAIL] Raw polygon was falsely interpreted as authoritative surface")
		return false

	print("  Verified distinct source-import paths for Overture, OSM, and Editor schemas.")
	return true


func verify_editor_payload_version_rejection() -> bool:
	var geojson_parser = GeoJSONParserClass.new()

	# 1. Supported versions advertised by HTTP server and parser
	if not ("1.0.0" in HttpServerClass.SUPPORTED_EDITOR_PAYLOAD_VERSIONS):
		printerr("  [FAIL] HttpServerClass must support version 1.0.0")
		return false
	if not ("1.0.0" in GeoJSONParserClass.SUPPORTED_EDITOR_PAYLOAD_VERSIONS):
		printerr("  [FAIL] GeoJSONParserClass must support version 1.0.0")
		return false

	# 2. HTTP Server check_editor_payload_version with valid payload
	var valid_editor_payload = {
		"type": "FeatureCollection",
		"generator": "osm-to-godot-editor",
		"editorPayloadVersion": "1.0.0",
		"features": []
	}
	var valid_check = HttpServerClass.check_editor_payload_version(valid_editor_payload)
	if not valid_check.get("is_editor", false) or not valid_check.get("valid", false):
		printerr("  [FAIL] Expected valid check for 1.0.0, got: ", valid_check)
		return false

	# 3. HTTP Server check_editor_payload_version with unsupported version (e.g. 2.0.0)
	var unsupported_editor_payload = {
		"type": "FeatureCollection",
		"generator": "osm-to-godot-editor",
		"editorPayloadVersion": "2.0.0",
		"features": []
	}
	var unsupported_check = HttpServerClass.check_editor_payload_version(unsupported_editor_payload)
	if not unsupported_check.get("is_editor", false) or unsupported_check.get("valid", true):
		printerr("  [FAIL] Expected invalid check for 2.0.0, got: ", unsupported_check)
		return false
	if not str(unsupported_check.get("error", "")).contains(
		'Unsupported editor payload version: "2.0.0"'
	):
		printerr(
			"  [FAIL] Error message must name unsupported version: ", unsupported_check.get("error")
		)
		return false
	if not str(unsupported_check.get("error", "")).contains("Supported versions: 1.0.0"):
		printerr(
			"  [FAIL] Error message must list supported versions: ", unsupported_check.get("error")
		)
		return false

	# 4. HTTP Server check_editor_payload_version with missing version
	var missing_version_payload = {
		"type": "FeatureCollection", "generator": "osm-to-godot-editor", "features": []
	}
	var missing_check = HttpServerClass.check_editor_payload_version(missing_version_payload)
	if not missing_check.get("is_editor", false) or missing_check.get("valid", true):
		printerr("  [FAIL] Expected invalid check for missing version, got: ", missing_check)
		return false
	if not str(missing_check.get("error", "")).contains("Missing editor payload version"):
		printerr(
			"  [FAIL] Error message must mention missing version: ", missing_check.get("error")
		)
		return false

	# 5. Non-editor payload is not flagged as editor error
	var raw_payload = {"type": "FeatureCollection", "features": []}
	var raw_check = HttpServerClass.check_editor_payload_version(raw_payload)
	if raw_check.get("is_editor", true) or not raw_check.get("valid", false):
		printerr("  [FAIL] Raw payload must not be flagged as editor error: ", raw_check)
		return false

	# 6. GeoJSONParser rejects unsupported editor payload version
	var parser_unsupported_res = geojson_parser.parse_data(unsupported_editor_payload)
	if not parser_unsupported_res.has("error"):
		printerr("  [FAIL] GeoJSONParser must reject unsupported version: ", parser_unsupported_res)
		return false
	if not str(parser_unsupported_res.get("error", "")).contains(
		'Unsupported editor payload version: "2.0.0"'
	):
		printerr(
			"  [FAIL] Parser error must name unsupported version: ",
			parser_unsupported_res.get("error")
		)
		return false

	# 7. GeoJSONParser rejects missing editor payload version
	var parser_missing_res = geojson_parser.parse_data(missing_version_payload)
	if not parser_missing_res.has("error"):
		printerr("  [FAIL] GeoJSONParser must reject missing version: ", parser_missing_res)
		return false
	if not str(parser_missing_res.get("error", "")).contains("Missing editor payload version"):
		printerr(
			"  [FAIL] Parser error must mention missing version: ", parser_missing_res.get("error")
		)
		return false

	print(
		"  Verified HTTP server and GeoJSON parser clear rejection of unsupported/missing editor payload versions."
	)
	return true


func verify_source_attribution_and_license_preservation() -> bool:
	var geojson_parser = GeoJSONParserClass.new()

	var payload = {
		"type": "FeatureCollection",
		"editorPayloadVersion": "1.0.0",
		"metadata":
		{
			"generator": "osm-to-godot-editor",
			"version": "1.0.0",
			"attribution": "© OpenStreetMap contributors, MassGIS",
			"license": "ODbL-1.0",
			"sourceMetadata":
			{
				"source": "osm",
				"attribution": "© OpenStreetMap contributors, MassGIS",
				"license": "ODbL-1.0"
			}
		},
		"projectionOrigin": {"lon": -71.11, "lat": 42.415},
		"features":
		[
			{
				"type": "Feature",
				"id": "surf_road_1",
				"geometry":
				{
					"type": "Polygon",
					"coordinates":
					[
						[
							[-71.1105, 42.415],
							[-71.1095, 42.415],
							[-71.1095, 42.4151],
							[-71.1105, 42.4151],
							[-71.1105, 42.415]
						]
					]
				},
				"properties":
				{"id": "surf_road_1", "role": "road", "kind": "road", "isFootprintAuthority": true}
			}
		]
	}

	var parsed = geojson_parser.parse_data(payload)
	if parsed.has("error"):
		printerr("  [FAIL] Failed to parse editor payload with attribution: ", parsed.get("error"))
		return false

	var meta = parsed.get("metadata", {})
	if meta.get("attribution") != "© OpenStreetMap contributors, MassGIS":
		printerr("  [FAIL] Attribution not preserved in metadata: ", meta.get("attribution"))
		return false
	if meta.get("license") != "ODbL-1.0":
		printerr("  [FAIL] License not preserved in metadata: ", meta.get("license"))
		return false

	# Verify scene builder attaches attribution and license to CityRoot
	var city_root = OSMSceneBuilderClass.build_city_scene(
		parsed.get("buildings", []),
		parsed.get("roads", []),
		false,
		false,
		false,
		500.0,
		1500.0,
		false,
		[],
		false,
		false,
		meta
	)

	if not city_root.has_meta("source_attribution"):
		printerr("  [FAIL] CityRoot missing source_attribution meta")
		city_root.free()
		return false
	if city_root.get_meta("source_attribution") != "© OpenStreetMap contributors, MassGIS":
		printerr(
			"  [FAIL] Incorrect source_attribution meta on CityRoot: ",
			city_root.get_meta("source_attribution")
		)
		city_root.free()
		return false
	if (
		not city_root.has_meta("source_license")
		or city_root.get_meta("source_license") != "ODbL-1.0"
	):
		printerr(
			"  [FAIL] Incorrect source_license meta on CityRoot: ",
			city_root.get_meta("source_license")
		)
		city_root.free()
		return false

	city_root.free()
	print("  Verified source attribution and license preservation in parser and CityRoot metadata.")
	return true


func verify_editor_payload_application_flow() -> bool:
	print("  Running editor-specific payload import through real application flow...")
	var file = FileAccess.open("../tests/fixtures/editor_scene_export.geojson", FileAccess.READ)
	if file == null:
		printerr("  [FAIL] Could not open editor_scene_export.geojson")
		return false
	var content = file.get_as_text()
	file.close()

	var json = JSON.new()
	if json.parse(content) != OK or typeof(json.data) != TYPE_DICTIONARY:
		printerr("  [FAIL] Failed to parse JSON from editor_scene_export.geojson")
		return false
	var raw_payload: Dictionary = json.data

	# 1. Step 1: Pre-flight payload version validation as performed by HTTP server endpoint
	var version_check = HttpServerClass.check_editor_payload_version(raw_payload)
	if not version_check.get("is_editor", false) or not version_check.get("valid", false):
		printerr(
			"  [FAIL] HTTP server version check failed for valid editor export: ", version_check
		)
		return false

	# 2. Step 2: GeoJSONParser parsing conforming to editor export schema
	var parser = GeoJSONParserClass.new()
	var parsed = parser.parse_data(raw_payload)
	if parsed.has("error"):
		printerr("  [FAIL] GeoJSONParser failed to parse editor export: ", parsed.get("error"))
		return false
	if parsed.get("source_type") != "editor":
		printerr("  [FAIL] Expected source_type 'editor', got: ", parsed.get("source_type"))
		return false

	var roads: Array = parsed.get("roads", [])
	var buildings: Array = parsed.get("buildings", [])
	var meta: Dictionary = parsed.get("metadata", {})

	if roads.size() != 4:
		printerr("  [FAIL] Expected 4 authoritative surfaces, found: ", roads.size())
		return false
	if buildings.size() != 1:
		printerr("  [FAIL] Expected 1 building, found: ", buildings.size())
		return false

	# 3. Step 3: Scene generation through OSMSceneBuilder with colliders and player character
	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, roads, true, false, false, 500.0, 1500.0, false, [], true, true, meta  # create_colliders  # batched_buildings  # use_spatial_chunks  # use_csg_buildings  # pois  # spawn_player  # create_ground
	)
	if city_root == null:
		printerr("  [FAIL] SceneBuilder returned null for editor payload import")
		return false

	# 4. Step 4: Verify Ground, Streets, Buildings, and Player nodes
	var ground = city_root.get_node_or_null("Ground")
	if ground == null:
		printerr("  [FAIL] Missing Ground node in CityRoot")
		city_root.free()
		return false
	var streets = city_root.get_node_or_null("Streets")
	if streets == null:
		printerr("  [FAIL] Missing Streets node in CityRoot")
		city_root.free()
		return false
	var buildings_node = city_root.get_node_or_null("Buildings")
	if buildings_node == null:
		printerr("  [FAIL] Missing Buildings node in CityRoot")
		city_root.free()
		return false
	var player = city_root.get_node_or_null("Player")
	if player == null:
		printerr("  [FAIL] Missing Player node in CityRoot")
		city_root.free()
		return false

	# 5. Step 5: Verify valid AABBs, non-empty surfaces, and zero NaNs across all meshes
	var mesh_instances: Array[MeshInstance3D] = []
	_collect_mesh_instances(city_root, mesh_instances)
	if mesh_instances.is_empty():
		printerr("  [FAIL] No MeshInstance3D nodes found in imported editor scene")
		city_root.free()
		return false

	for mi in mesh_instances:
		var mesh = mi.mesh
		if mesh == null or mesh.get_surface_count() == 0:
			printerr("  [FAIL] Invalid mesh on node: ", mi.name)
			city_root.free()
			return false
		var aabb = mi.get_aabb()
		if not is_valid_aabb(aabb):
			printerr("  [FAIL] Invalid AABB on node: ", mi.name, " aabb=", aabb)
			city_root.free()
			return false

	# 6. Step 6: Verify colliders on road and building meshes
	for child in streets.get_children():
		if child is MeshInstance3D:
			var col = child.get_node_or_null("Collision") as StaticBody3D
			if col == null or col.get_child_count() == 0:
				printerr("  [FAIL] Road mesh missing collision body or shape: ", child.name)
				city_root.free()
				return false

	for child in buildings_node.get_children():
		if child is MeshInstance3D:
			var col = child.get_node_or_null("StaticBody3D") as StaticBody3D
			if col == null:
				col = child.get_node_or_null("Collision") as StaticBody3D
			if col == null or col.get_child_count() == 0:
				printerr("  [FAIL] Building mesh missing collision body or shape: ", child.name)
				city_root.free()
				return false

	city_root.free()
	print("  PASS: Editor-specific payload successfully imported through real application flow.")
	return true
