class_name GeoJSONParser
extends RefCounted

const OSMProjection = preload("projection.gd")
const DUPLICATE_VERTEX_TOLERANCE: float = 0.05  # 5cm in meters

var projection: OSMProjection


func _init(custom_projection: OSMProjection = null) -> void:
	projection = custom_projection


## Parse GeoJSON string and return normalized features compatible with SceneBuilder
func parse_json_string(json_text: String) -> Dictionary:
	var json = JSON.new()
	var error = json.parse(json_text)
	if error != OK:
		push_error(
			(
				"GeoJSONParser: JSON parse error: "
				+ json.get_error_message()
				+ " at line "
				+ str(json.get_error_line())
			)
		)
		return {"error": json.get_error_message()}

	var data = json.data
	if typeof(data) != TYPE_DICTIONARY:
		push_error("GeoJSONParser: Root JSON must be an object.")
		return {"error": "Invalid root JSON type"}

	return parse_data(data)


## Parse GeoJSON file from disk
func parse_file(file_path: String) -> Dictionary:
	var file = FileAccess.open(file_path, FileAccess.READ)
	if file == null:
		var err = FileAccess.get_open_error()
		push_error("GeoJSONParser: Failed to open file: " + file_path + " (error " + str(err) + ")")
		return {"error": "File open error: " + str(err)}

	var content = file.get_as_text()
	file.close()
	return parse_json_string(content)


## Main parsing method for GeoJSON data
func parse_data(data: Dictionary) -> Dictionary:
	var features: Array = []
	if (
		data.get("type") == "FeatureCollection"
		and data.has("features")
		and typeof(data["features"]) == TYPE_ARRAY
	):
		features = data["features"]
	elif data.get("type") == "Feature":
		features = [data]
	else:
		push_error(
			(
				"GeoJSONParser: Expected FeatureCollection or Feature, got type: "
				+ str(data.get("type"))
			)
		)
		return {"error": "Unsupported GeoJSON structure"}

	var metadata: Dictionary = {}
	if data.has("metadata") and typeof(data["metadata"]) == TYPE_DICTIONARY:
		metadata = data["metadata"]

	_init_projection_origin(metadata, features)

	var buildings: Array = []
	var roads: Array = []
	var pois: Array = []

	for feat in features:
		if typeof(feat) != TYPE_DICTIONARY:
			continue

		var geom = feat.get("geometry")
		if typeof(geom) != TYPE_DICTIONARY:
			continue

		var geom_type = str(geom.get("type", ""))
		var coords = geom.get("coordinates")
		if typeof(coords) != TYPE_ARRAY or coords.is_empty():
			continue

		var props: Dictionary = feat.get("properties", {})
		var feat_id = feat.get("id", "")
		var overture_type = str(feat.get("overture_type", props.get("theme", "")))

		match geom_type:
			"Polygon":
				_process_polygon(feat_id, props, coords, buildings)
			"MultiPolygon":
				_process_multipolygon(feat_id, props, coords, buildings)
			"LineString":
				_process_linestring(feat_id, props, coords, roads)
			"MultiLineString":
				_process_multilinestring(feat_id, props, coords, roads)
			"Point":
				_process_point(feat_id, props, coords, pois)
			_:
				# Unknown geometry type
				pass

	# Spatially associate POIs inside buildings
	for b in buildings:
		b["pois"] = []
		var outer_rings: Array = b.get("outer_rings", [])
		var inner_rings: Array = b.get("inner_rings", [])
		for poi in pois:
			var pt_2d = Vector2(poi.position.x, poi.position.z)
			var in_outer = false
			for ring in outer_rings:
				var poly_2d = PackedVector2Array()
				poly_2d.resize(ring.size())
				for i in range(ring.size()):
					poly_2d[i] = Vector2(ring[i].x, ring[i].z)
				if Geometry2D.is_point_in_polygon(pt_2d, poly_2d):
					in_outer = true
					break
			if in_outer:
				var in_inner = false
				for hole in inner_rings:
					var hole_2d = PackedVector2Array()
					hole_2d.resize(hole.size())
					for i in range(hole.size()):
						hole_2d[i] = Vector2(hole[i].x, hole[i].z)
					if Geometry2D.is_point_in_polygon(pt_2d, hole_2d):
						in_inner = true
						break
				if not in_inner:
					b["pois"].append(poi)

	return {
		"metadata": metadata,
		"projection_origin": {"lat": projection.origin_lat_deg, "lon": projection.origin_lon_deg},
		"roads": roads,
		"buildings": buildings,
		"pois": pois
	}


# --- Initialization of Projection Origin ---


func _init_projection_origin(metadata: Dictionary, features: Array) -> void:
	if projection != null:
		return

	projection = OSMProjection.new()

	# 1. Try metadata centroid or bbox
	if metadata.has("centroid") and typeof(metadata["centroid"]) == TYPE_DICTIONARY:
		var c = metadata["centroid"]
		if c.has("lat") and c.has("lon"):
			projection.set_origin(float(c["lat"]), float(c["lon"]))
			return
	if (
		metadata.has("bbox")
		and typeof(metadata["bbox"]) == TYPE_ARRAY
		and metadata["bbox"].size() == 4
	):
		var b = metadata["bbox"]
		projection.set_origin_from_bbox(float(b[1]), float(b[0]), float(b[3]), float(b[2]))
		return

	# 2. Derive bounding box by scanning feature coordinates
	var min_lat = 90.0
	var max_lat = -90.0
	var min_lon = 180.0
	var max_lon = -180.0
	var found = false

	for feat in features:
		if typeof(feat) != TYPE_DICTIONARY:
			continue
		var geom = feat.get("geometry")
		if typeof(geom) != TYPE_DICTIONARY:
			continue
		var coords = geom.get("coordinates")
		if typeof(coords) == TYPE_ARRAY:
			var pts = _flatten_coords(coords)
			for pt in pts:
				var lon = float(pt[0])
				var lat = float(pt[1])
				min_lat = minf(min_lat, lat)
				max_lat = maxf(max_lat, lat)
				min_lon = minf(min_lon, lon)
				max_lon = maxf(max_lon, lon)
				found = true

	if found:
		projection.set_origin_from_bbox(min_lat, min_lon, max_lat, max_lon)
	else:
		projection.set_origin(0.0, 0.0)


func _flatten_coords(arr: Array) -> Array:
	var result = []
	if arr.is_empty():
		return result
	if typeof(arr[0]) != TYPE_ARRAY:
		if arr.size() >= 2:
			result.append(arr)
		return result
	for sub in arr:
		if typeof(sub) == TYPE_ARRAY:
			result.append_array(_flatten_coords(sub))
	return result


# --- Feature Processing ---


func _normalize_building_tags(props: Dictionary) -> Dictionary:
	var name_str = ""
	var names_prop = props.get("names")
	if typeof(names_prop) == TYPE_DICTIONARY:
		name_str = str(names_prop.get("primary", names_prop.get("common", "")))
	elif props.has("name"):
		name_str = str(props.get("name", ""))

	var b_class = str(props.get("class", props.get("subtype", "yes")))
	if b_class.is_empty():
		b_class = "yes"

	var tags: Dictionary = {"building": b_class, "name": name_str}

	if props.has("height") and props["height"] != null:
		tags["height"] = str(props["height"])
	if props.has("min_height") and props["min_height"] != null:
		tags["min_height"] = str(props["min_height"])
	if props.has("num_floors") and props["num_floors"] != null:
		tags["building:levels"] = str(props["num_floors"])
	elif props.has("building:levels"):
		tags["building:levels"] = str(props["building:levels"])
	if props.has("min_floor") and props["min_floor"] != null:
		tags["building:min_level"] = str(props["min_floor"])

	if props.has("roof_shape") and props["roof_shape"] != null:
		tags["roof:shape"] = str(props["roof_shape"])
	elif props.has("roof:shape"):
		tags["roof:shape"] = str(props["roof:shape"])

	if props.has("roof_height") and props["roof_height"] != null:
		tags["roof:height"] = str(props["roof_height"])
	if props.has("roof_color") and props["roof_color"] != null:
		tags["roof:colour"] = str(props["roof_color"])
	elif props.has("roof:colour"):
		tags["roof:colour"] = str(props["roof:colour"])

	if props.has("facade_color") and props["facade_color"] != null:
		tags["building:colour"] = str(props["facade_color"])
	elif props.has("building:colour"):
		tags["building:colour"] = str(props["building:colour"])

	# Forward any existing OSM tags if present
	for k in props.keys():
		if not tags.has(k) and typeof(props[k]) == TYPE_STRING:
			tags[k] = props[k]

	return tags


func _normalize_road_tags(props: Dictionary) -> Dictionary:
	var name_str = ""
	var names_prop = props.get("names")
	if typeof(names_prop) == TYPE_DICTIONARY:
		name_str = str(names_prop.get("primary", names_prop.get("common", "")))
	elif props.has("name"):
		name_str = str(props.get("name", ""))

	var r_class = str(props.get("class", props.get("subtype", "residential"))).to_lower()
	if r_class == "road":
		r_class = "residential"

	var tags: Dictionary = {"highway": r_class, "name": name_str}

	# Width rules
	if (
		props.has("width_rules")
		and typeof(props["width_rules"]) == TYPE_ARRAY
		and not props["width_rules"].is_empty()
	):
		var w_entry = props["width_rules"][0]
		if typeof(w_entry) == TYPE_DICTIONARY and w_entry.has("value"):
			tags["width"] = str(w_entry["value"])
	elif props.has("width"):
		tags["width"] = str(props["width"])

	# Surface
	if (
		props.has("road_surface")
		and typeof(props["road_surface"]) == TYPE_ARRAY
		and not props["road_surface"].is_empty()
	):
		var s_entry = props["road_surface"][0]
		if typeof(s_entry) == TYPE_DICTIONARY and s_entry.has("value"):
			tags["surface"] = str(s_entry["value"])
	elif props.has("surface"):
		tags["surface"] = str(props["surface"])

	# Bridge / tunnel flags
	if props.has("road_flags") and typeof(props["road_flags"]) == TYPE_ARRAY:
		for flag_grp in props["road_flags"]:
			if typeof(flag_grp) == TYPE_DICTIONARY:
				var vals = flag_grp.get("values", [])
				if typeof(vals) == TYPE_ARRAY and "is_bridge" in vals:
					tags["bridge"] = "yes"
	elif props.has("bridge"):
		tags["bridge"] = str(props["bridge"])

	# Vertical level
	if (
		props.has("level_rules")
		and typeof(props["level_rules"]) == TYPE_ARRAY
		and not props["level_rules"].is_empty()
	):
		var lvl_entry = props["level_rules"][0]
		if typeof(lvl_entry) == TYPE_DICTIONARY and lvl_entry.has("value"):
			tags["layer"] = str(lvl_entry["value"])
	elif props.has("layer"):
		tags["layer"] = str(props["layer"])

	# Subclass (e.g. sidewalk)
	if props.has("subclass"):
		tags["subclass"] = str(props["subclass"])

	return tags


func _process_polygon(
	feat_id: Variant, props: Dictionary, rings_coords: Array, out_buildings: Array
) -> void:
	if rings_coords.is_empty():
		return

	var outer_raw = _project_ring(rings_coords[0])
	var clean_outer = sanitize_polygon(outer_raw, DUPLICATE_VERTEX_TOLERANCE, feat_id)
	if clean_outer.size() < 4 or is_polygon_self_intersecting(clean_outer):
		return

	clean_outer = ensure_winding(clean_outer, true)  # Exterior ring must be CCW

	var inner_rings: Array[PackedVector3Array] = []
	for i in range(1, rings_coords.size()):
		var hole_raw = _project_ring(rings_coords[i])
		var clean_hole = sanitize_polygon(hole_raw, DUPLICATE_VERTEX_TOLERANCE, feat_id)
		if clean_hole.size() >= 4 and not is_polygon_self_intersecting(clean_hole):
			clean_hole = ensure_winding(clean_hole, false)  # Hole must be CW
			inner_rings.append(clean_hole)

	var tags = _normalize_building_tags(props)
	out_buildings.append(
		{
			"id": feat_id,
			"tags": tags,
			"outer_rings": [clean_outer],
			"inner_rings": inner_rings,
			"pois": []
		}
	)


func _process_multipolygon(
	feat_id: Variant, props: Dictionary, polys_coords: Array, out_buildings: Array
) -> void:
	for poly_coords in polys_coords:
		if typeof(poly_coords) == TYPE_ARRAY:
			_process_polygon(feat_id, props, poly_coords, out_buildings)


func _process_linestring(
	feat_id: Variant, props: Dictionary, line_coords: Array, out_roads: Array
) -> void:
	var raw_pts = _project_polyline(line_coords)
	var clean_pts = sanitize_polyline(raw_pts)
	if clean_pts.size() < 2:
		return

	var is_closed = (
		clean_pts[0].distance_to(clean_pts[clean_pts.size() - 1]) < DUPLICATE_VERTEX_TOLERANCE
	)
	var tags = _normalize_road_tags(props)
	out_roads.append({"id": feat_id, "tags": tags, "points": clean_pts, "is_closed": is_closed})


func _process_multilinestring(
	feat_id: Variant, props: Dictionary, lines_coords: Array, out_roads: Array
) -> void:
	for line_coords in lines_coords:
		if typeof(line_coords) == TYPE_ARRAY:
			_process_linestring(feat_id, props, line_coords, out_roads)


func _process_point(feat_id: Variant, props: Dictionary, pt_coord: Array, out_pois: Array) -> void:
	if pt_coord.size() < 2:
		return
	var lon = float(pt_coord[0])
	var lat = float(pt_coord[1])
	var pos_3d = projection.project(lat, lon)

	var name_str = ""
	var names_prop = props.get("names")
	if typeof(names_prop) == TYPE_DICTIONARY:
		name_str = str(names_prop.get("primary", names_prop.get("common", "")))
	elif props.has("name"):
		name_str = str(props.get("name", ""))

	out_pois.append(
		{"id": feat_id, "tags": props, "name": name_str, "lat": lat, "lon": lon, "position": pos_3d}
	)


# --- Projection Helpers ---


func _project_ring(coords_arr: Array) -> PackedVector3Array:
	var pts = PackedVector3Array()
	pts.resize(coords_arr.size())
	for i in range(coords_arr.size()):
		var c = coords_arr[i]
		if typeof(c) == TYPE_ARRAY and c.size() >= 2:
			pts[i] = projection.project(float(c[1]), float(c[0]))
	return pts


func _project_polyline(coords_arr: Array) -> PackedVector3Array:
	var pts = PackedVector3Array()
	pts.resize(coords_arr.size())
	for i in range(coords_arr.size()):
		var c = coords_arr[i]
		if typeof(c) == TYPE_ARRAY and c.size() >= 2:
			pts[i] = projection.project(float(c[1]), float(c[0]))
	return pts


# --- Geometric Sanitization Helpers ---


func sanitize_polygon(
	pts: PackedVector3Array, tolerance: float = DUPLICATE_VERTEX_TOLERANCE, _feature_id: Variant = 0
) -> PackedVector3Array:
	if pts.size() < 3:
		return PackedVector3Array()

	var tol_sq = tolerance * tolerance
	var cleaned = PackedVector3Array()
	cleaned.append(pts[0])

	for i in range(1, pts.size()):
		var prev = cleaned[cleaned.size() - 1]
		if pts[i].distance_squared_to(prev) > tol_sq:
			cleaned.append(pts[i])

	if cleaned.size() < 3:
		return PackedVector3Array()

	# Ensure closed loop
	if cleaned[0].distance_squared_to(cleaned[cleaned.size() - 1]) > tol_sq:
		cleaned.append(cleaned[0])

	return cleaned


func sanitize_polyline(
	pts: PackedVector3Array, tolerance: float = DUPLICATE_VERTEX_TOLERANCE
) -> PackedVector3Array:
	if pts.size() < 2:
		return PackedVector3Array()

	var tol_sq = tolerance * tolerance
	var cleaned = PackedVector3Array()
	cleaned.append(pts[0])

	for i in range(1, pts.size()):
		var prev = cleaned[cleaned.size() - 1]
		if pts[i].distance_squared_to(prev) > tol_sq:
			cleaned.append(pts[i])

	if cleaned.size() < 2:
		return PackedVector3Array()

	return cleaned


func is_polygon_self_intersecting(ring: PackedVector3Array) -> bool:
	var n = ring.size()
	if n < 4:
		return false

	var num_segs = n - 1
	for i in range(num_segs):
		var a1 = Vector2(ring[i].x, ring[i].z)
		var a2 = Vector2(ring[i + 1].x, ring[i + 1].z)

		for j in range(i + 2, num_segs):
			if i == 0 and j == num_segs - 1:
				continue
			var b1 = Vector2(ring[j].x, ring[j].z)
			var b2 = Vector2(ring[j + 1].x, ring[j + 1].z)
			var isect = Geometry2D.segment_intersects_segment(a1, a2, b1, b2)
			if isect != null:
				return true

	return false


func calculate_signed_area_2d(ring: PackedVector3Array) -> float:
	var n = ring.size()
	if n < 3:
		return 0.0

	var area2d = 0.0
	for i in range(n - 1):
		var p1 = ring[i]
		var p2 = ring[i + 1]
		var y1 = -p1.z
		var y2 = -p2.z
		area2d += (p1.x * y2 - p2.x * y1)

	return area2d * 0.5


func ensure_winding(ring: PackedVector3Array, want_ccw: bool) -> PackedVector3Array:
	var area = calculate_signed_area_2d(ring)
	var is_ccw = area >= 0.0
	if is_ccw != want_ccw:
		var reversed = ring.duplicate()
		reversed.reverse()
		return reversed
	return ring
