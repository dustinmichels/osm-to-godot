class_name OSMSceneBuilder
extends RefCounted

## Constructs and serializes a complete 3D visualization scene (res://city_viewer.tscn)
## containing procedural buildings, lighting, sky environment, and inspection camera.

const BuildingBuilderClass = preload("building_builder.gd")
const RoadBuilderClass = preload("road_builder.gd")
const CameraControllerScript = preload("camera_controller.gd")
const ChunkManagerClass = preload("chunk_manager.gd")


## Build a complete CityRoot Node3D hierarchy with lighting, environment, camera, buildings, and roads
static func build_city_scene(buildings_data: Array, roads_data: Array = [], create_colliders: bool = true, batched_buildings: bool = false, use_spatial_chunks: bool = false, chunk_size: float = 500.0, lod_max_distance: float = 1500.0, use_csg_buildings: bool = false, pois_data: Array = [], spawn_player: bool = true, create_ground: bool = true) -> Node3D:
	var city_root = Node3D.new()
	city_root.name = "CityRoot"

	# 1. World Environment with Procedural Sky & Ambient Light
	var env_node = WorldEnvironment.new()
	env_node.name = "WorldEnvironment"
	var env = Environment.new()
	env.background_mode = Environment.BG_SKY

	var sky = Sky.new()
	var sky_mat = ProceduralSkyMaterial.new()
	sky_mat.sky_top_color = Color(0.38, 0.45, 0.55)
	sky_mat.sky_horizon_color = Color(0.65, 0.70, 0.76)
	sky_mat.ground_bottom_color = Color(0.20, 0.20, 0.22)
	sky_mat.ground_horizon_color = Color(0.55, 0.58, 0.62)
	sky.sky_material = sky_mat
	env.sky = sky

	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_sky_contribution = 0.5
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	env.ssao_enabled = true
	env_node.environment = env
	city_root.add_child(env_node)

	# 2. Directional Sun Light with Shadows
	var sun = DirectionalLight3D.new()
	sun.name = "DirectionalLight3D"
	sun.rotation_degrees = Vector3(-45.0, 35.0, 0.0)
	sun.shadow_enabled = true
	sun.light_energy = 1.0
	city_root.add_child(sun)

	# 3 & 4. Roads and Buildings (Chunked or Standard)
	var streets: Node3D = null
	var buildings_root: Node3D = null
	var chunked_world: Node3D = null

	if use_spatial_chunks:
		chunked_world = ChunkManagerClass.build_chunked_world(buildings_data, roads_data, chunk_size, create_colliders, lod_max_distance)
		city_root.add_child(chunked_world)
	else:
		streets = RoadBuilderClass.build_roads_node(roads_data, create_colliders)
		streets.name = "Streets"
		city_root.add_child(streets)
		buildings_root = BuildingBuilderClass.build_buildings_node(buildings_data, create_colliders, batched_buildings, use_csg_buildings)
		buildings_root.name = "Buildings"
		city_root.add_child(buildings_root)

	# POIs (Points of Interest)
	if not pois_data.is_empty():
		var pois_root = Node3D.new()
		pois_root.name = "POIs"
		for poi in pois_data:
			if poi is Dictionary:
				var marker = Marker3D.new()
				var p_name = str(poi.get("name", "")).strip_edges()
				if p_name.is_empty():
					p_name = "POI_" + str(poi.get("id", "unknown"))
				marker.name = BuildingBuilderClass.sanitize_node_name(p_name)
				marker.position = poi.get("position", Vector3.ZERO)
				var p_id = poi.get("id")
				if p_id != null:
					marker.set_meta("osm_id", p_id)
				var p_disp = str(poi.get("name", "")).strip_edges()
				if not p_disp.is_empty():
					marker.set_meta("osm_name", p_disp)
				var p_tags: Dictionary = poi.get("tags", {})
				if not p_tags.is_empty():
					marker.set_meta("osm_tags", p_tags)
				pois_root.add_child(marker, true)
		city_root.add_child(pois_root)

	# Calculate bounds of buildings or streets
	var aabb = calculate_bounds(chunked_world if chunked_world != null else buildings_root)
	if aabb.size.length_squared() < 0.1 and streets != null:
		aabb = calculate_bounds(streets)
	var center = aabb.get_center() if aabb.size.length() > 0.1 else Vector3.ZERO
	var span = maxf(aabb.size.x, aabb.size.z)
	if span < 50.0:
		span = 120.0

	# 5. Ground Plane with Grassy Texture (and optional static collider)
	if create_ground:
		var ground = _create_ground_node(aabb, create_colliders)
		city_root.add_child(ground)

	# 6. Inspection Camera with Fly-through Controller
	var camera = Camera3D.new()
	camera.name = "Camera3D"
	camera.current = not spawn_player
	camera.set_script(CameraControllerScript)

	var cam_pos = center + Vector3(0.0, span * 0.65 + 35.0, span * 0.75 + 45.0)
	camera.look_at_from_position(cam_pos, center, Vector3.UP)
	city_root.add_child(camera)

	# 7. Player Character for 3D Scene Exploration
	if spawn_player:
		var spawn_pos = _determine_player_spawn_point(roads_data, buildings_data, center)
		var player = _create_player_node(spawn_pos)
		if player:
			city_root.add_child(player)
		else:
			camera.current = true

	return city_root

## Create a walkable ground surface and static collider with a grassy texture
static func _create_ground_node(scene_bounds: AABB, create_colliders: bool = true) -> Node3D:
	var ground_root = Node3D.new()
	ground_root.name = "Ground"

	var half_size = maxf(maxf(scene_bounds.size.x, scene_bounds.size.z) * 1.5, 1000.0)
	var center = scene_bounds.get_center() if scene_bounds.size.length_squared() > 0.1 else Vector3.ZERO

	if create_colliders:
		var sb = StaticBody3D.new()
		sb.name = "GroundCollision"
		ground_root.add_child(sb)

		var cs = CollisionShape3D.new()
		cs.name = "CollisionShape3D"
		var box_shape = BoxShape3D.new()
		box_shape.size = Vector3(half_size * 2.0, 1.0, half_size * 2.0)
		cs.shape = box_shape
		cs.position = Vector3(center.x, -0.5, center.z)
		sb.add_child(cs)

	var mi = MeshInstance3D.new()
	mi.name = "GroundMesh"
	var plane_mesh = PlaneMesh.new()
	plane_mesh.size = Vector2(half_size * 2.0, half_size * 2.0)
	mi.mesh = plane_mesh
	mi.position = Vector3(center.x, 0.0, center.z)

	var ground_mat = _get_ground_material()
	mi.material_override = ground_mat
	ground_root.add_child(mi)

	return ground_root

## Get or fallback create the grassy ground material
static func _get_ground_material() -> StandardMaterial3D:
	const GROUND_GRASS_MATERIAL_PATH = "res://materials/ground_grass.tres"
	if ResourceLoader.exists(GROUND_GRASS_MATERIAL_PATH):
		var res_mat = load(GROUND_GRASS_MATERIAL_PATH) as StandardMaterial3D
		if res_mat != null:
			return res_mat

	var mat = StandardMaterial3D.new()
	mat.resource_name = "GroundGrassMaterial"
	mat.albedo_color = Color(0.28, 0.48, 0.22, 1.0)
	mat.roughness = 0.9
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	return mat

## Find a suitable spawn point for the player near the center of the scene
static func _determine_player_spawn_point(roads_data: Array, buildings_data: Array, center: Vector3) -> Vector3:
	var best_pos = center + Vector3(0.0, 0.2, 0.0)
	var min_dist_sq = INF

	# 1. Prefer spawning on a road near the bounding box center
	if not roads_data.is_empty():
		for road in roads_data:
			var pts = road.get("points", [])
			for pt in pts:
				var dist_sq = Vector2(pt.x - center.x, pt.z - center.z).length_squared()
				if dist_sq < min_dist_sq:
					min_dist_sq = dist_sq
					best_pos = Vector3(pt.x, maxf(pt.y, 0.0) + 0.2, pt.z)
	# 2. If no roads, spawn in an open area near the center
	elif not buildings_data.is_empty():
		best_pos = Vector3(center.x, 0.2, center.z)

	return best_pos

## Instantiate and initialize the player character node
static func _create_player_node(spawn_pos: Vector3) -> CharacterBody3D:
	var char_scene_path = "res://character/character.tscn"
	var player: CharacterBody3D = null
	if ResourceLoader.exists(char_scene_path):
		var char_scene = load(char_scene_path)
		if char_scene:
			player = char_scene.instantiate() as CharacterBody3D

	if player:
		player.position = spawn_pos
		player.set("spawn_position", spawn_pos)
		var cam = player.find_child("Camera3D", true, false)
		if cam is Camera3D:
			cam.current = true
	return player

## Calculate combined AABB of all MeshInstance3D nodes under a root
static func calculate_bounds(root: Node3D) -> AABB:
	if root == null:
		return AABB()
	var state = {"aabb": AABB(), "found": false}
	_accumulate_bounds_recursive(root, Transform3D.IDENTITY, state)
	return state["aabb"]

static func _accumulate_bounds_recursive(node: Node, parent_xform: Transform3D, state: Dictionary) -> void:
	var cur_xform = parent_xform
	if node is Node3D:
		cur_xform = parent_xform * (node as Node3D).transform
	if node is MeshInstance3D:
		var mi = node as MeshInstance3D
		if mi.mesh:
			var local_aabb = mi.mesh.get_aabb()
			var transformed_aabb = cur_xform * local_aabb
			if not state["found"]:
				state["aabb"] = transformed_aabb
				state["found"] = true
			else:
				state["aabb"] = (state["aabb"] as AABB).merge(transformed_aabb)
	elif node is CSGPolygon3D:
		var csg = node as CSGPolygon3D
		var poly = csg.polygon
		if poly.size() > 0:
			var min_x = poly[0].x
			var max_x = poly[0].x
			var min_y = poly[0].y
			var max_y = poly[0].y
			for pt in poly:
				min_x = minf(min_x, pt.x)
				max_x = maxf(max_x, pt.x)
				min_y = minf(min_y, pt.y)
				max_y = maxf(max_y, pt.y)
			var depth = csg.depth
			var local_aabb = AABB(Vector3(min_x, min_y, -depth), Vector3(max_x - min_x, max_y - min_y, depth))
			var transformed_aabb = cur_xform * local_aabb
			if not state["found"]:
				state["aabb"] = transformed_aabb
				state["found"] = true
			else:
				state["aabb"] = (state["aabb"] as AABB).merge(transformed_aabb)
	for child in node.get_children():
		_accumulate_bounds_recursive(child, cur_xform, state)
## Recursively set node ownership so PackedScene serializes all children
static func set_owner_recursive(node: Node, scene_root: Node) -> void:
	for child in node.get_children():
		child.owner = scene_root
		set_owner_recursive(child, scene_root)

## Save the city scene to a .tscn file on disk
static func save_city_scene(city_root: Node3D, save_path: String = "res://city_viewer.tscn") -> Error:
	var dir_path = save_path.get_base_dir()
	var dir = DirAccess.open("res://")
	if dir and not dir.dir_exists(dir_path.trim_prefix("res://")):
		dir.make_dir_recursive(dir_path.trim_prefix("res://"))

	set_owner_recursive(city_root, city_root)

	var packed = PackedScene.new()
	var pack_err = packed.pack(city_root)
	if pack_err != OK:
		push_error("[OSM Importer] Failed to pack city scene: " + str(pack_err))
		return pack_err

	var save_err = ResourceSaver.save(packed, save_path)
	if save_err != OK:
		push_error("[OSM Importer] Failed to save city scene to " + save_path + ": " + str(save_err))
		return save_err

	print("[OSM Importer] Successfully saved city scene to: ", save_path)
	return OK
