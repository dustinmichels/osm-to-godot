class_name OSMChunkManager
extends RefCounted

## 2D Spatial Chunking & Visibility/LOD Manager for large-scale OSM environments.
## Partitions building and road geometries into regular 2D grid cells (e.g. 500m x 500m).
## Supports chunked material batching and distance-based LOD / visibility culling.

const BuildingBuilderClass = preload("building_builder.gd")
const RoadBuilderClass = preload("road_builder.gd")

const DEFAULT_CHUNK_SIZE: float = 500.0

## Compute 2D grid key (e.g. "cx,cz" or Vector2i) for a given world-space coordinate
static func get_chunk_coord(world_pos: Vector3, chunk_size: float = DEFAULT_CHUNK_SIZE) -> Vector2i:
	var cx = int(floor(world_pos.x / chunk_size))
	var cz = int(floor(world_pos.z / chunk_size))
	return Vector2i(cx, cz)

## Calculate centroid / center of a building feature in XZ plane
static func get_building_center(building: Dictionary) -> Vector3:
	var outer_rings: Array = building.get("outer_rings", [])
	if outer_rings.is_empty():
		return Vector3.ZERO
	var ring: PackedVector3Array = outer_rings[0]
	if ring.is_empty():
		return Vector3.ZERO
	
	var sum_v = Vector3.ZERO
	for pt in ring:
		sum_v += pt
	return sum_v / float(ring.size())

## Calculate centroid / center of a road polyline in XZ plane
static func get_road_center(road: Dictionary) -> Vector3:
	var points: PackedVector3Array = road.get("points", PackedVector3Array())
	if points.is_empty():
		return Vector3.ZERO
	var sum_v = Vector3.ZERO
	for pt in points:
		sum_v += pt
	return sum_v / float(points.size())

## Partition buildings and roads into 2D spatial grid chunks.
## Returns Dictionary mapping Vector2i -> { "buildings": Array, "roads": Array, "aabb": AABB }
static func partition_into_chunks(buildings: Array, roads: Array, chunk_size: float = DEFAULT_CHUNK_SIZE) -> Dictionary:
	var chunks: Dictionary = {} # Vector2i -> Dictionary
	
	for b in buildings:
		var center = get_building_center(b)
		var coord = get_chunk_coord(center, chunk_size)
		if not chunks.has(coord):
			chunks[coord] = {
				"coord": coord,
				"buildings": [],
				"roads": [],
				"center": Vector3((float(coord.x) + 0.5) * chunk_size, 0.0, (float(coord.y) + 0.5) * chunk_size)
			}
		chunks[coord]["buildings"].append(b)
		
	for r in roads:
		var center = get_road_center(r)
		var coord = get_chunk_coord(center, chunk_size)
		if not chunks.has(coord):
			chunks[coord] = {
				"coord": coord,
				"buildings": [],
				"roads": [],
				"center": Vector3((float(coord.x) + 0.5) * chunk_size, 0.0, (float(coord.y) + 0.5) * chunk_size)
			}
		chunks[coord]["roads"].append(r)
		
	return chunks

## Build a root Node3D with spatial chunk children.
## Each chunk contains batched buildings and roads, and configures visibility culling / LOD limits.
static func build_chunked_world(buildings: Array, roads: Array, chunk_size: float = DEFAULT_CHUNK_SIZE, create_colliders: bool = true, max_visible_distance: float = 1500.0) -> Node3D:
	var chunks_root = Node3D.new()
	chunks_root.name = "ChunkedWorld"
	
	var partitions = partition_into_chunks(buildings, roads, chunk_size)
	
	for coord in partitions.keys():
		var chunk_data = partitions[coord]
		var c_blds: Array = chunk_data.get("buildings", [])
		var c_roads: Array = chunk_data.get("roads", [])
		
		var chunk_node = Node3D.new()
		chunk_node.name = "Chunk_%d_%d" % [coord.x, coord.y]
		chunk_node.set_meta("chunk_coord", coord)
		chunk_node.set_meta("chunk_center", chunk_data.get("center", Vector3.ZERO))
		
		# Build batched roads for this chunk
		if not c_roads.is_empty():
			var roads_node = RoadBuilderClass.build_roads_node(c_roads, create_colliders)
			roads_node.name = "Roads"
			_apply_lod_culling(roads_node, max_visible_distance)
			chunk_node.add_child(roads_node)
			
		# Build batched buildings for this chunk
		if not c_blds.is_empty():
			var blds_node = BuildingBuilderClass.build_buildings_node(c_blds, create_colliders, true)
			blds_node.name = "Buildings"
			_apply_lod_culling(blds_node, max_visible_distance)
			chunk_node.add_child(blds_node)
			
		chunks_root.add_child(chunk_node)
		
	return chunks_root

## Apply visibility range (distance-based culling / LOD) to all GeometryInstance3D nodes in a subtree
static func _apply_lod_culling(root: Node3D, max_dist: float) -> void:
	if max_dist <= 0.0:
		return
	for child in root.get_children():
		if child is GeometryInstance3D:
			var gi = child as GeometryInstance3D
			gi.visibility_range_end = max_dist
			gi.visibility_range_end_margin = max_dist * 0.1
			gi.visibility_range_fade_mode = GeometryInstance3D.VISIBILITY_RANGE_FADE_SELF
		if child.get_child_count() > 0:
			_apply_lod_culling(child, max_dist)
