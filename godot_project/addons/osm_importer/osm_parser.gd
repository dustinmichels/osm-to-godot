class_name OSMParser
extends RefCounted
const OSMProjection = preload("projection.gd")

const DUPLICATE_VERTEX_TOLERANCE: float = 0.05 # 5cm in meters

var projection: OSMProjection

func _init(custom_projection: OSMProjection = null) -> void:
	projection = custom_projection

## Parse OSM JSON string and return normalized features
func parse_json_string(json_text: String) -> Dictionary:
	var json = JSON.new()
	var error = json.parse(json_text)
	if error != OK:
		push_error("OSMParser: JSON parse error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
		return { "error": json.get_error_message() }
	
	var data = json.data
	if typeof(data) != TYPE_DICTIONARY:
		push_error("OSMParser: Root JSON must be an object.")
		return { "error": "Invalid root JSON type" }
		
	return parse_data(data)

## Parse an OSM JSON file from disk
func parse_file(file_path: String) -> Dictionary:
	var file = FileAccess.open(file_path, FileAccess.READ)
	if file == null:
		var err = FileAccess.get_open_error()
		push_error("OSMParser: Failed to open file: " + file_path + " (error " + str(err) + ")")
		return { "error": "File open error: " + str(err) }
		
	var content = file.get_as_text()
	file.close()
	return parse_json_string(content)

## Main parsing and feature extraction method
func parse_data(data: Dictionary) -> Dictionary:
	var elements: Array = []
	if data.has("elements") and typeof(data["elements"]) == TYPE_ARRAY:
		elements = data["elements"]
	
	var metadata: Dictionary = {}
	if data.has("metadata") and typeof(data["metadata"]) == TYPE_DICTIONARY:
		metadata = data["metadata"]
		
	# Setup projection origin
	_init_projection_origin(metadata, elements)
	
	# Pre-index standalone nodes by ID for geometry resolution
	var node_coords: Dictionary = {}
	for el in elements:
		if typeof(el) == TYPE_DICTIONARY and el.get("type") == "node":
			var node_id = el.get("id")
			var lat = el.get("lat")
			var lon = el.get("lon")
			if node_id != null and lat != null and lon != null:
				node_coords[node_id] = { "lat": float(lat), "lon": float(lon) }

	var roads: Array = []
	var buildings: Array = []
	var building_ways_in_relations: Dictionary = {}
	
	# Pass 1: Parse multipolygon relations to collect relation-owned ways
	for el in elements:
		if typeof(el) != TYPE_DICTIONARY:
			continue
		if el.get("type") == "relation":
			var tags: Dictionary = el.get("tags", {})
			var is_multipolygon = tags.get("type") == "multipolygon"
			var is_building = tags.has("building")
			if is_multipolygon and is_building:
				var b_feat = _parse_building_relation(el, node_coords)
				if b_feat != null:
					buildings.append(b_feat)
					# Mark member ways so we don't duplicate them in Pass 2
					for m in el.get("members", []):
						if typeof(m) == TYPE_DICTIONARY and m.get("type") == "way":
							var ref = m.get("ref")
							if ref != null:
								building_ways_in_relations[ref] = true
	
	# Pass 2: Parse ways (highways & standalone buildings)
	for el in elements:
		if typeof(el) != TYPE_DICTIONARY:
			continue
		if el.get("type") == "way":
			var way_id = el.get("id")
			var tags: Dictionary = el.get("tags", {})
			
			# Check highways
			if tags.has("highway"):
				var raw_pts = _extract_way_points_3d(el, node_coords)
				var clean_pts = sanitize_polyline(raw_pts)
				if clean_pts.size() >= 2:
					var is_closed = clean_pts[0].distance_to(clean_pts[clean_pts.size() - 1]) < DUPLICATE_VERTEX_TOLERANCE
					roads.append({
						"id": way_id,
						"tags": tags,
						"points": clean_pts,
						"is_closed": is_closed
					})
			
			# Check standalone buildings (not already handled as part of a multipolygon)
			elif tags.has("building") and not building_ways_in_relations.has(way_id):
				var raw_pts = _extract_way_points_3d(el, node_coords)
				var clean_ring = sanitize_polygon(raw_pts)
				if clean_ring.size() >= 4: # Minimum closed triangle: 3 unique pts + 1 closing pt
					clean_ring = ensure_winding(clean_ring, true) # Exterior ring must be CCW
					buildings.append({
						"id": way_id,
						"tags": tags,
						"outer_rings": [clean_ring],
						"inner_rings": []
					})

	return {
		"metadata": metadata,
		"projection_origin": {
			"lat": projection.origin_lat_deg,
			"lon": projection.origin_lon_deg
		},
		"roads": roads,
		"buildings": buildings
	}

## Initialize projection origin from metadata or compute centroid
func _init_projection_origin(metadata: Dictionary, elements: Array) -> void:
	if projection != null and (projection.origin_lat_deg != 0.0 or projection.origin_lon_deg != 0.0):
		return # Already set externally
		
	if projection == null:
		projection = OSMProjection.new()
		
	# Check metadata centroid
	if metadata.has("centroid") and typeof(metadata["centroid"]) == TYPE_DICTIONARY:
		var c = metadata["centroid"]
		if c.has("lat") and c.has("lon"):
			projection.set_origin(float(c["lat"]), float(c["lon"]))
			return
			
	# Check metadata bbox
	if metadata.has("bbox") and typeof(metadata["bbox"]) == TYPE_DICTIONARY:
		var b = metadata["bbox"]
		if b.has("south") and b.has("west") and b.has("north") and b.has("east"):
			projection.set_origin_from_bbox(float(b["south"]), float(b["west"]), float(b["north"]), float(b["east"]))
			return

	# Fallback: scan elements for min/max lat/lon
	var min_lat = 90.0
	var max_lat = -90.0
	var min_lon = 180.0
	var max_lon = -180.0
	var found_any = false
	
	for el in elements:
		if typeof(el) != TYPE_DICTIONARY:
			continue
		if el.has("lat") and el.has("lon"):
			var lat = float(el["lat"])
			var lon = float(el["lon"])
			min_lat = min(min_lat, lat)
			max_lat = max(max_lat, lat)
			min_lon = min(min_lon, lon)
			max_lon = max(max_lon, lon)
			found_any = true
		elif el.has("geometry") and typeof(el["geometry"]) == TYPE_ARRAY:
			for pt in el["geometry"]:
				if typeof(pt) == TYPE_DICTIONARY and pt.has("lat") and pt.has("lon"):
					var lat = float(pt["lat"])
					var lon = float(pt["lon"])
					min_lat = min(min_lat, lat)
					max_lat = max(max_lat, lat)
					min_lon = min(min_lon, lon)
					max_lon = max(max_lon, lon)
					found_any = true

	if found_any:
		projection.set_origin((min_lat + max_lat) * 0.5, (min_lon + max_lon) * 0.5)
	else:
		projection.set_origin(0.0, 0.0)

## Extract 3D points from a way element using inline geometry or node lookup
func _extract_way_points_3d(way: Dictionary, node_coords: Dictionary) -> PackedVector3Array:
	var pts = PackedVector3Array()
	
	if way.has("geometry") and typeof(way["geometry"]) == TYPE_ARRAY:
		var geom: Array = way["geometry"]
		pts.resize(geom.size())
		var idx = 0
		for item in geom:
			if typeof(item) == TYPE_DICTIONARY and item.has("lat") and item.has("lon"):
				pts[idx] = projection.project(float(item["lat"]), float(item["lon"]))
				idx += 1
		pts.resize(idx)
		return pts
		
	if way.has("nodes") and typeof(way["nodes"]) == TYPE_ARRAY:
		var node_ids: Array = way["nodes"]
		for nid in node_ids:
			if node_coords.has(nid):
				var c = node_coords[nid]
				pts.append(projection.project(c["lat"], c["lon"]))
				
	return pts

## Parse a multipolygon building relation
func _parse_building_relation(rel: Dictionary, node_coords: Dictionary) -> Variant:
	var rel_id = rel.get("id")
	var tags: Dictionary = rel.get("tags", {})
	var members: Array = rel.get("members", [])
	
	var outer_segments: Array = []
	var inner_segments: Array = []
	
	for m in members:
		if typeof(m) != TYPE_DICTIONARY:
			continue
		var role = m.get("role", "")
		var seg = _extract_way_points_3d(m, node_coords)
		if seg.size() < 2:
			continue
		if role == "outer":
			outer_segments.append(seg)
		elif role == "inner":
			inner_segments.append(seg)
			
	if outer_segments.is_empty():
		return null
		
	var outer_rings = stitch_rings(outer_segments)
	var inner_rings = stitch_rings(inner_segments)
	
	var clean_outer_rings: Array[PackedVector3Array] = []
	for r in outer_rings:
		var clean = sanitize_polygon(r)
		if clean.size() >= 4:
			clean = ensure_winding(clean, true) # CCW for exterior
			clean_outer_rings.append(clean)
			
	if clean_outer_rings.is_empty():
		return null
		
	var clean_inner_rings: Array[PackedVector3Array] = []
	for r in inner_rings:
		var clean = sanitize_polygon(r)
		if clean.size() >= 4:
			clean = ensure_winding(clean, false) # CW for interior holes
			clean_inner_rings.append(clean)
			
	return {
		"id": rel_id,
		"tags": tags,
		"outer_rings": clean_outer_rings,
		"inner_rings": clean_inner_rings
	}

## Deduplicate consecutive vertices in a polyline
func sanitize_polyline(points: PackedVector3Array, tolerance: float = DUPLICATE_VERTEX_TOLERANCE) -> PackedVector3Array:
	if points.size() < 2:
		return points
		
	var result = PackedVector3Array()
	result.append(points[0])
	
	var tol_sq = tolerance * tolerance
	for i in range(1, points.size()):
		var prev = result[result.size() - 1]
		var curr = points[i]
		if prev.distance_squared_to(curr) >= tol_sq:
			result.append(curr)
			
	return result

## Sanitize polygon: deduplicate adjacent vertices and enforce ring closure
func sanitize_polygon(points: PackedVector3Array, tolerance: float = DUPLICATE_VERTEX_TOLERANCE) -> PackedVector3Array:
	if points.size() < 3:
		return PackedVector3Array()
		
	var cleaned = sanitize_polyline(points, tolerance)
	if cleaned.size() < 3:
		return PackedVector3Array()
		
	# Check if first and last are already closed
	var first = cleaned[0]
	var last = cleaned[cleaned.size() - 1]
	if first.distance_squared_to(last) >= (tolerance * tolerance):
		cleaned.append(first) # Close the loop
		
	# Minimum valid closed polygon ring has 3 unique vertices + 1 duplicate closure = 4 vertices
	if cleaned.size() < 4:
		return PackedVector3Array()
		
	return cleaned

## Calculates 2D signed area on local tangent plane (East = +X, North = -Z)
## Positive = Counter-Clockwise (CCW), Negative = Clockwise (CW)
func calculate_signed_area_2d(ring: PackedVector3Array) -> float:
	var n = ring.size()
	if n < 3:
		return 0.0
		
	var area2d = 0.0
	for i in range(n - 1):
		var p1 = ring[i]
		var p2 = ring[i + 1]
		# x is East, y_north is -z
		var y1 = -p1.z
		var y2 = -p2.z
		area2d += (p1.x * y2 - p2.x * y1)
		
	return area2d * 0.5

## Enforces winding order: want_ccw = true enforces CCW, false enforces CW
func ensure_winding(ring: PackedVector3Array, want_ccw: bool) -> PackedVector3Array:
	var area = calculate_signed_area_2d(ring)
	var is_ccw = area >= 0.0
	if is_ccw != want_ccw:
		var reversed = ring.duplicate()
		reversed.reverse()
		return reversed
	return ring

## Stitch line segments together into closed loops (for multipolygons)
func stitch_rings(segments: Array, tolerance: float = 0.1) -> Array[PackedVector3Array]:
	var closed_rings: Array[PackedVector3Array] = []
	var tol_sq = tolerance * tolerance
	
	var remaining: Array[PackedVector3Array] = []
	for seg in segments:
		if seg is PackedVector3Array and seg.size() >= 2:
			# If segment is already closed
			if seg[0].distance_squared_to(seg[seg.size() - 1]) <= tol_sq:
				closed_rings.append(seg)
			else:
				remaining.append(seg)
				
	while not remaining.is_empty():
		var current = remaining.pop_front()
		var chained = true
		
		while chained and current[0].distance_squared_to(current[current.size() - 1]) > tol_sq:
			chained = false
			var cur_end = current[current.size() - 1]
			
			for i in range(remaining.size()):
				var candidate = remaining[i]
				var cand_start = candidate[0]
				var cand_end = candidate[candidate.size() - 1]
				
				# Connect start to current end
				if cur_end.distance_squared_to(cand_start) <= tol_sq:
					for k in range(1, candidate.size()):
						current.append(candidate[k])
					remaining.remove_at(i)
					chained = true
					break
				# Connect reversed candidate (cand_end to current end)
				elif cur_end.distance_squared_to(cand_end) <= tol_sq:
					for k in range(candidate.size() - 2, -1, -1):
						current.append(candidate[k])
					remaining.remove_at(i)
					chained = true
					break
					
		closed_rings.append(current)
		
	return closed_rings
