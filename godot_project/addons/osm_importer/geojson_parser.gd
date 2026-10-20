class_name GeoJSONParser
extends RefCounted

const SUPPORTED_EDITOR_PAYLOAD_VERSIONS: Array[String] = ["1.0.0"]

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

	_init_projection_origin(metadata, features, data)

	var is_editor_payload = (
		data.has("editorPayloadVersion")
		or data.has("editor_payload_version")
		or metadata.has("editorPayloadVersion")
		or metadata.has("editor_payload_version")
		or str(metadata.get("generator", "")).begins_with("osm-to-godot-editor")
		or str(data.get("generator", "")).begins_with("osm-to-godot-editor")
	)

	if is_editor_payload:
		var version_val = data.get("editorPayloadVersion", data.get("editor_payload_version", null))
		if version_val == null and metadata.size() > 0:
			version_val = metadata.get(
				"editorPayloadVersion",
				metadata.get("editor_payload_version", metadata.get("version", null))
			)
		var version_str = "" if version_val == null else str(version_val).strip_edges()
		if version_str.is_empty():
			var err_msg = (
				"Missing editor payload version. Supported versions: "
				+ ", ".join(SUPPORTED_EDITOR_PAYLOAD_VERSIONS)
				+ "."
			)
			push_error("GeoJSONParser: " + err_msg)
			return {"error": err_msg}
		elif not (version_str in SUPPORTED_EDITOR_PAYLOAD_VERSIONS):
			var err_msg = (
				'Unsupported editor payload version: "'
				+ version_str
				+ '". Supported versions: '
				+ ", ".join(SUPPORTED_EDITOR_PAYLOAD_VERSIONS)
				+ "."
			)
			push_error("GeoJSONParser: " + err_msg)
			return {"error": err_msg}

	var has_authoritative_surfaces = false
	for feat in features:
		if typeof(feat) == TYPE_DICTIONARY:
			var p = feat.get("properties", {})
			if typeof(p) == TYPE_DICTIONARY:
				if p.get("isFootprintAuthority", false) or p.get("is_footprint_authority", false):
					has_authoritative_surfaces = true
					break

	var source_type = "unknown"
	if is_editor_payload or has_authoritative_surfaces:
		source_type = "editor"
	else:
		var overture_score = 0
		var osm_score = 0
		var src_meta = str(metadata.get("source", "")).to_lower()
		if (
			src_meta.contains("overture")
			or metadata.has("counts")
			or data.has("theme")
			or metadata.has("theme")
		):
			overture_score += 5
		elif (
			src_meta.contains("osm")
			or src_meta.contains("openstreetmap")
			or str(metadata.get("generator", "")).to_lower().contains("overpass")
		):
			osm_score += 5

		for feat in features:
			if typeof(feat) != TYPE_DICTIONARY:
				continue
			var p = feat.get("properties", {})
			if typeof(p) != TYPE_DICTIONARY:
				continue
			if (
				p.has("theme")
				or p.has("subtype")
				or p.has("class")
				or p.has("subclass")
				or p.has("width_rules")
				or p.has("lanes_rules")
				or p.has("connectors")
				or p.has("overture_type")
			):
				overture_score += 1
			if (
				p.has("highway")
				or p.has("building")
				or p.has("osm_id")
				or p.has("amenity")
				or p.has("sourceTags")
			):
				osm_score += 1

		if overture_score > osm_score:
			source_type = "overture"
		elif osm_score > 0:
			source_type = "osm"
		else:
			source_type = "raw_geojson"

	var is_raw_source_import = source_type != "editor"

	var export_inclusions: Dictionary = {}
	if metadata.has("exportInclusions") and typeof(metadata["exportInclusions"]) == TYPE_DICTIONARY:
		export_inclusions = metadata["exportInclusions"]
	elif (
		metadata.has("export_inclusions")
		and typeof(metadata["export_inclusions"]) == TYPE_DICTIONARY
	):
		export_inclusions = metadata["export_inclusions"]
	elif data.has("exportInclusions") and typeof(data["exportInclusions"]) == TYPE_DICTIONARY:
		export_inclusions = data["exportInclusions"]
	elif data.has("export_inclusions") and typeof(data["export_inclusions"]) == TYPE_DICTIONARY:
		export_inclusions = data["export_inclusions"]

	var exclusions: Array = []
	if metadata.has("exclusions") and typeof(metadata["exclusions"]) == TYPE_ARRAY:
		exclusions = metadata["exclusions"]
	elif data.has("exclusions") and typeof(data["exclusions"]) == TYPE_ARRAY:
		exclusions = data["exclusions"]

	var attribution: String = ""
	if metadata.has("attribution") and typeof(metadata["attribution"]) == TYPE_STRING:
		attribution = metadata["attribution"]
	elif data.has("attribution") and typeof(data["attribution"]) == TYPE_STRING:
		attribution = data["attribution"]
	elif metadata.has("sourceMetadata") and typeof(metadata["sourceMetadata"]) == TYPE_DICTIONARY:
		attribution = str(metadata["sourceMetadata"].get("attribution", ""))

	var license_info: String = ""
	if metadata.has("license") and typeof(metadata["license"]) == TYPE_STRING:
		license_info = metadata["license"]
	elif data.has("license") and typeof(data["license"]) == TYPE_STRING:
		license_info = data["license"]
	elif metadata.has("sourceMetadata") and typeof(metadata["sourceMetadata"]) == TYPE_DICTIONARY:
		license_info = str(metadata["sourceMetadata"].get("license", ""))

	if not attribution.is_empty():
		metadata["attribution"] = attribution
	if not license_info.is_empty():
		metadata["license"] = license_info
	var buildings: Array = []
	var roads: Array = []
	var pois: Array = []
	var centerlines: Array = []

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
		if props.has("exportInclusion") and not bool(props["exportInclusion"]):
			continue
		if props.has("is_export_included") and not bool(props["is_export_included"]):
			continue
		if props.has("included") and not bool(props["included"]):
			continue

		var feat_id = feat.get("id", "")
		var overture_type = str(feat.get("overture_type", props.get("theme", "")))
		var role = str(props.get("role", "")).strip_edges().to_lower()
		var kind = str(props.get("kind", "")).strip_edges().to_lower()
		var is_authoritative = (
			bool(props.get("isFootprintAuthority", false))
			or bool(props.get("is_footprint_authority", false))
		)
		const ROAD_ROLES = [
			"carriageway",
			"road",
			"street",
			"sidewalk",
			"footway",
			"pedestrian",
			"path",
			"bike_lane",
			"cycleway",
			"bike_facility",
			"junction",
			"intersection",
			"parking",
			"median",
			"buffer",
			"verge"
		]
		var is_road_role = (
			role in ROAD_ROLES
			or kind in ROAD_ROLES
			or overture_type == "segment"
			or overture_type == "transportation"
			or props.has("roadProfile")
			or (props.has("highway") and not props.has("building"))
			or (props.has("area:highway") and not props.has("building"))
		)
		var is_building_role = (
			(
				role == "building"
				or kind == "building"
				or overture_type == "building"
				or overture_type == "buildings"
				or props.has("buildingProfile")
				or (props.has("building") and not (role in ROAD_ROLES or kind in ROAD_ROLES))
			)
			and not (role in ROAD_ROLES or kind in ROAD_ROLES)
		)
		var is_semantic_centerline = (
			role == "centerline"
			or kind == "centerline"
			or bool(props.get("isSemanticCenterline", false))
			or bool(props.get("is_semantic_centerline", false))
			or (
				(is_editor_payload or has_authoritative_surfaces)
				and (is_road_role or role == "")
				and not is_authoritative
				and (geom_type == "LineString" or geom_type == "MultiLineString")
			)
		)
		var is_authoritative_road_surface = (
			(
				is_authoritative
				or (is_editor_payload and is_road_role)
				or role in ROAD_ROLES
				or kind in ROAD_ROLES
				or (
					(props.has("highway") or props.has("area:highway"))
					and not props.has("building")
				)
			)
			and is_road_role
			and not is_building_role
			and role != "centerline"
			and kind != "centerline"
		)
		if not export_inclusions.is_empty():
			var is_excluded = false
			if is_building_role and export_inclusions.get("building") == false:
				is_excluded = true
			elif (
				role in ["sidewalk", "footway", "pedestrian", "path"]
				or kind in ["sidewalk", "footway", "pedestrian", "path"]
			):
				if (
					export_inclusions.get("sidewalk") == false
					or export_inclusions.get("footway") == false
				):
					is_excluded = true
			elif (
				role in ["bike_lane", "cycleway", "bike_facility"]
				or kind in ["bike_lane", "cycleway", "bike_facility"]
			):
				if (
					export_inclusions.get("cycling") == false
					or export_inclusions.get("bike_lane") == false
					or export_inclusions.get("cycleway") == false
				):
					is_excluded = true
			elif role in ["junction", "intersection"] or kind in ["junction", "intersection"]:
				if export_inclusions.get("junction") == false:
					is_excluded = true
			elif is_road_role:
				if (
					export_inclusions.get("road") == false
					or export_inclusions.get("carriageway") == false
				):
					is_excluded = true
			if is_excluded:
				continue

		match geom_type:
			"Polygon":
				if is_authoritative_road_surface:
					_process_authoritative_surface(
						feat_id, props, coords, "Polygon", roads, centerlines
					)
				elif (
					is_building_role
					or is_raw_source_import
					or (role != "unsupported" and kind != "unsupported" and not is_road_role)
				):
					_process_polygon(feat_id, props, coords, buildings)
			"MultiPolygon":
				if is_authoritative_road_surface:
					_process_authoritative_surface(
						feat_id, props, coords, "MultiPolygon", roads, centerlines
					)
				elif (
					is_building_role
					or is_raw_source_import
					or (role != "unsupported" and kind != "unsupported" and not is_road_role)
				):
					_process_multipolygon(feat_id, props, coords, buildings)
			"LineString":
				if is_semantic_centerline:
					_process_semantic_centerline(
						feat_id, props, coords, "LineString", centerlines, roads
					)
				elif role != "building":
					_process_linestring(feat_id, props, coords, roads)
			"MultiLineString":
				if is_semantic_centerline:
					_process_semantic_centerline(
						feat_id, props, coords, "MultiLineString", centerlines, roads
					)
				elif role != "building":
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
		if outer_rings.is_empty() or pois.is_empty():
			continue

		var outer_polys_2d: Array[PackedVector2Array] = []
		for ring in outer_rings:
			var poly_2d = PackedVector2Array()
			poly_2d.resize(ring.size())
			for i in range(ring.size()):
				poly_2d[i] = Vector2(ring[i].x, ring[i].z)
			outer_polys_2d.append(poly_2d)

		var inner_polys_2d: Array[PackedVector2Array] = []
		for hole in inner_rings:
			var hole_2d = PackedVector2Array()
			hole_2d.resize(hole.size())
			for i in range(hole.size()):
				hole_2d[i] = Vector2(hole[i].x, hole[i].z)
			inner_polys_2d.append(hole_2d)

		for poi in pois:
			var pt_2d = Vector2(poi.position.x, poi.position.z)
			var in_outer = false
			for poly_2d in outer_polys_2d:
				if Geometry2D.is_point_in_polygon(pt_2d, poly_2d):
					in_outer = true
					break
			if in_outer:
				var in_inner = false
				for hole_2d in inner_polys_2d:
					if Geometry2D.is_point_in_polygon(pt_2d, hole_2d):
						in_inner = true
						break
				if not in_inner:
					b["pois"].append(poi)

		# If building has no name tag yet, adopt the first valid matched POI name
		if (
			str(b.get("tags", {}).get("name", "")).strip_edges().is_empty()
			and not b["pois"].is_empty()
		):
			for p in b["pois"]:
				var p_name = str(p.get("name", "")).strip_edges()
				if not p_name.is_empty() and p_name != "<null>":
					b["tags"]["name"] = p_name
					break
	return {
		"source_type": source_type,
		"is_editor_payload": is_editor_payload,
		"is_raw_source_import": is_raw_source_import,
		"metadata": metadata,
		"export_inclusions": export_inclusions,
		"exclusions": exclusions,
		"projection_origin": {"lat": projection.origin_lat_deg, "lon": projection.origin_lon_deg},
		"roads": roads,
		"buildings": buildings,
		"pois": pois,
		"centerlines": centerlines
	}


# --- Initialization of Projection Origin ---


func _init_projection_origin(
	metadata: Dictionary, features: Array, root_data: Dictionary = {}
) -> void:
	if projection != null:
		return

	projection = OSMProjection.new()

	# 1. Try explicit projectionOrigin from root or metadata
	var p_orig = metadata.get("projectionOrigin", root_data.get("projectionOrigin", {}))
	if typeof(p_orig) == TYPE_DICTIONARY and p_orig.has("lat") and p_orig.has("lon"):
		projection.set_origin(float(p_orig["lat"]), float(p_orig["lon"]))
		return
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


static func extract_name_from_props(props: Dictionary) -> String:
	var names_prop = props.get("names")
	if typeof(names_prop) == TYPE_DICTIONARY:
		var primary = names_prop.get("primary")
		if primary != null:
			var s = str(primary).strip_edges()
			if not s.is_empty() and s != "<null>":
				return s
		var common = names_prop.get("common")
		if common != null:
			var s = str(common).strip_edges()
			if not s.is_empty() and s != "<null>":
				return s
	if props.has("name") and props["name"] != null:
		var s = str(props["name"]).strip_edges()
		if not s.is_empty() and s != "<null>":
			return s
	if props.has("name:en") and props["name:en"] != null:
		var s = str(props["name:en"]).strip_edges()
		if not s.is_empty() and s != "<null>":
			return s
	var brand_prop = props.get("brand")
	if typeof(brand_prop) == TYPE_DICTIONARY:
		var b_names = brand_prop.get("names")
		if typeof(b_names) == TYPE_DICTIONARY:
			var b_prim = b_names.get("primary")
			if b_prim != null:
				var s = str(b_prim).strip_edges()
				if not s.is_empty() and s != "<null>":
					return s
			var b_comm = b_names.get("common")
			if b_comm != null:
				var s = str(b_comm).strip_edges()
				if not s.is_empty() and s != "<null>":
					return s
	elif brand_prop != null:
		var s = str(brand_prop).strip_edges()
		if not s.is_empty() and s != "<null>":
			return s
	var addresses = props.get("addresses")
	if typeof(addresses) == TYPE_ARRAY and not addresses.is_empty():
		var addr_0 = addresses[0]
		if typeof(addr_0) == TYPE_DICTIONARY:
			var freeform = addr_0.get("freeform")
			if freeform != null:
				var s = str(freeform).strip_edges()
				if not s.is_empty() and s != "<null>":
					return s
	var number = props.get("number")
	var street = props.get("street")
	if number != null and street != null:
		var n = str(number).strip_edges()
		var st = str(street).strip_edges().capitalize()
		if not n.is_empty() and not st.is_empty() and n != "<null>" and st != "<null>":
			return n + " " + st
	elif street != null:
		var st = str(street).strip_edges().capitalize()
		if not st.is_empty() and st != "<null>":
			return st
	var category = props.get("basic_category")
	if category != null:
		var s = str(category).strip_edges()
		if not s.is_empty() and s != "<null>":
			return s.capitalize().replace("_", " ")
	return ""


func _normalize_building_tags(props: Dictionary) -> Dictionary:
	var name_str = extract_name_from_props(props)

	var b_class = str(props.get("class", props.get("subtype", "yes")))
	if b_class.is_empty():
		b_class = "yes"

	var tags: Dictionary = {"building": b_class, "name": name_str}

	var addresses = props.get("addresses")
	if typeof(addresses) == TYPE_ARRAY and not addresses.is_empty():
		var addr_0 = addresses[0]
		if typeof(addr_0) == TYPE_DICTIONARY:
			if addr_0.has("freeform") and addr_0["freeform"] != null:
				tags["addr:full"] = str(addr_0["freeform"]).strip_edges()
			if addr_0.has("postcode") and addr_0["postcode"] != null:
				tags["addr:postcode"] = str(addr_0["postcode"]).strip_edges()
			if addr_0.has("locality") and addr_0["locality"] != null:
				tags["addr:city"] = str(addr_0["locality"]).strip_edges()

	if props.has("heightMeters") and props["heightMeters"] != null:
		tags["height"] = str(props["heightMeters"])
	elif props.has("height") and props["height"] != null:
		tags["height"] = str(props["height"])
	if props.has("min_height") and props["min_height"] != null:
		tags["min_height"] = str(props["min_height"])
	if props.has("levels") and props["levels"] != null:
		tags["building:levels"] = str(props["levels"])
	elif props.has("num_floors") and props["num_floors"] != null:
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

	# Forward any existing OSM tags and properties if present (preserving explicit zeros & scalars)
	if props.has("sourceTags") and typeof(props["sourceTags"]) == TYPE_DICTIONARY:
		for k in props["sourceTags"].keys():
			if not tags.has(k):
				tags[k] = str(props["sourceTags"][k])

	for k in props.keys():
		if not tags.has(k) and typeof(props[k]) in [TYPE_STRING, TYPE_INT, TYPE_FLOAT, TYPE_BOOL]:
			tags[k] = str(props[k])

	return tags


func _normalize_road_tags(props: Dictionary) -> Dictionary:
	var name_str = extract_name_from_props(props)

	var r_class = str(props.get("class", props.get("subtype", "residential"))).to_lower()
	if r_class == "road":
		r_class = "residential"

	var tags: Dictionary = {"highway": r_class, "name": name_str}

	# Width rules (preserving explicit zero)
	if props.has("widthMeters"):
		tags["width"] = str(props["widthMeters"])
	elif (
		props.has("width_rules")
		and typeof(props["width_rules"]) == TYPE_ARRAY
		and not props["width_rules"].is_empty()
	):
		var w_entry = props["width_rules"][0]
		if typeof(w_entry) == TYPE_DICTIONARY and w_entry.has("value"):
			tags["width"] = str(w_entry["value"])
	elif props.has("width"):
		tags["width"] = str(props["width"])

	# Lanes (preserving explicit zero)
	if props.has("lanes"):
		tags["lanes"] = str(props["lanes"])

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

	if props.has("tunnel"):
		tags["tunnel"] = str(props["tunnel"])

	# Vertical level (preserving explicit zero)
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

	# Explicit absence from roadProfile or properties
	if (
		props.get("sidewalk") in ["no", "none", "absent"]
		or (
			props.has("roadProfile")
			and typeof(props["roadProfile"]) == TYPE_DICTIONARY
			and props["roadProfile"].get("sidewalks", {}).get("presence") == "absent"
		)
	):
		tags["sidewalk"] = "no"
		tags["sidewalk:both"] = "no"
	elif props.has("sidewalk"):
		tags["sidewalk"] = str(props["sidewalk"])

	if (
		props.get("cycleway") in ["no", "none", "absent"]
		or (
			props.has("roadProfile")
			and typeof(props["roadProfile"]) == TYPE_DICTIONARY
			and props["roadProfile"].get("cycleFacilities", {}).get("presence") == "absent"
		)
	):
		tags["cycleway"] = "no"
		tags["cycleway:both"] = "no"
	elif props.has("cycleway"):
		tags["cycleway"] = str(props["cycleway"])

	if props.has("bicycle"):
		tags["bicycle"] = str(props["bicycle"])
	if props.has("foot"):
		tags["foot"] = str(props["foot"])

	# Forward sourceTags and remaining scalar props
	if props.has("sourceTags") and typeof(props["sourceTags"]) == TYPE_DICTIONARY:
		for k in props["sourceTags"].keys():
			if not tags.has(k):
				tags[k] = str(props["sourceTags"][k])

	for k in props.keys():
		if not tags.has(k) and typeof(props[k]) in [TYPE_STRING, TYPE_INT, TYPE_FLOAT, TYPE_BOOL]:
			tags[k] = str(props[k])

	return tags


func _normalize_surface_tags(props: Dictionary) -> Dictionary:
	var tags: Dictionary = {}
	var role = str(props.get("role", "")).strip_edges().to_lower()
	var kind = str(props.get("kind", role)).strip_edges().to_lower()
	if role.is_empty():
		role = kind
	if role.is_empty():
		var hw = str(props.get("highway", "")).strip_edges().to_lower()
		if hw in ["footway", "pedestrian", "path", "steps"]:
			role = "sidewalk"
		elif hw in ["cycleway"]:
			role = "bike_lane"
		else:
			role = "road"
	if kind.is_empty():
		kind = role
	tags["role"] = role
	tags["kind"] = kind

	# Highway / subclass mapping
	if role in ["sidewalk", "footway", "pedestrian", "path"]:
		tags["highway"] = "footway"
		tags["subclass"] = "sidewalk"
	elif role in ["bike_lane", "cycleway", "bike_facility"]:
		tags["highway"] = "cycleway"
		tags["subclass"] = "bike_lane"
	elif role in ["junction", "intersection"]:
		tags["highway"] = "residential"
		tags["subclass"] = "junction"
	else:
		tags["highway"] = "residential"

	if props.has("surface") and props["surface"] != null:
		tags["surface"] = str(props["surface"])
	elif role in ["sidewalk", "footway", "pedestrian", "path"]:
		tags["surface"] = "concrete"
	elif role in ["bike_lane", "cycleway", "bike_facility"]:
		tags["surface"] = "bike_lane"
	else:
		tags["surface"] = "asphalt"

	if props.has("layer"):
		tags["layer"] = str(props["layer"])
	else:
		tags["layer"] = "0"

	if props.has("bridge"):
		tags["bridge"] = "yes" if props["bridge"] else "no"
	if props.has("tunnel"):
		tags["tunnel"] = "yes" if props["tunnel"] else "no"

	if props.has("widthMeters"):
		tags["width"] = str(props["widthMeters"])
	elif props.has("width"):
		tags["width"] = str(props["width"])

	if props.has("lanes"):
		tags["lanes"] = str(props["lanes"])

	# Explicit facility absence from roadProfile or properties
	if (
		props.get("sidewalk") in ["no", "none", "absent"]
		or (
			props.has("roadProfile")
			and typeof(props["roadProfile"]) == TYPE_DICTIONARY
			and props["roadProfile"].get("sidewalks", {}).get("presence") == "absent"
		)
	):
		tags["sidewalk"] = "no"
		tags["sidewalk:both"] = "no"
	elif props.has("sidewalk"):
		tags["sidewalk"] = str(props["sidewalk"])

	if (
		props.get("cycleway") in ["no", "none", "absent"]
		or (
			props.has("roadProfile")
			and typeof(props["roadProfile"]) == TYPE_DICTIONARY
			and props["roadProfile"].get("cycleFacilities", {}).get("presence") == "absent"
		)
	):
		tags["cycleway"] = "no"
		tags["cycleway:both"] = "no"
	elif props.has("cycleway"):
		tags["cycleway"] = str(props["cycleway"])

	# Forward sourceTags if provided
	if props.has("sourceTags") and typeof(props["sourceTags"]) == TYPE_DICTIONARY:
		for k in props["sourceTags"].keys():
			if not tags.has(k):
				tags[k] = str(props["sourceTags"][k])

	for k in props.keys():
		if not tags.has(k) and typeof(props[k]) in [TYPE_STRING, TYPE_INT, TYPE_FLOAT, TYPE_BOOL]:
			tags[k] = str(props[k])

	return tags


func _process_authoritative_surface(
	feat_id: Variant,
	props: Dictionary,
	coords: Array,
	geom_type: String,
	out_roads: Array,
	out_centerlines: Array = []
) -> void:
	if geom_type == "MultiPolygon":
		var part_idx = 0
		for poly_coords in coords:
			if typeof(poly_coords) == TYPE_ARRAY:
				var part_id = (
					feat_id if coords.size() == 1 else (str(feat_id) + "_part_" + str(part_idx))
				)
				_process_authoritative_surface_polygon(
					part_id, props, poly_coords, out_roads, out_centerlines
				)
				part_idx += 1
	else:
		_process_authoritative_surface_polygon(feat_id, props, coords, out_roads, out_centerlines)


func _process_authoritative_surface_polygon(
	feat_id: Variant,
	props: Dictionary,
	rings_coords: Array,
	out_roads: Array,
	out_centerlines: Array = []
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

	var tags = _normalize_surface_tags(props)
	var centerline_pts = PackedVector3Array()
	if props.has("centerline") and typeof(props["centerline"]) == TYPE_DICTIONARY:
		var c_geom = props["centerline"]
		if c_geom.get("type") == "LineString" and typeof(c_geom.get("coordinates")) == TYPE_ARRAY:
			centerline_pts = _project_polyline(c_geom["coordinates"])

	var profile_dict = props.get("roadProfile", {})

	out_roads.append(
		{
			"id": feat_id,
			"parent_id": props.get("parentFeatureId", ""),
			"strip_id": props.get("stripId", ""),
			"role": str(props.get("role", tags.get("role", "road"))),
			"kind": str(props.get("kind", tags.get("kind", ""))),
			"tags": tags,
			"properties": props,
			"is_authoritative_surface": true,
			"outer_rings": [clean_outer],
			"inner_rings": inner_rings,
			"centerline": centerline_pts,
			"profile": profile_dict
		}
	)

	if centerline_pts.size() >= 2:
		out_centerlines.append(
			{
				"id": str(feat_id) + "_centerline",
				"parent_id": props.get("parentFeatureId", feat_id),
				"strip_id": props.get("stripId", ""),
				"role": "centerline",
				"points": centerline_pts,
				"centerline": centerline_pts,
				"profile": profile_dict,
				"tags": tags,
				"properties": props
			}
		)


func _process_semantic_centerline(
	feat_id: Variant,
	props: Dictionary,
	coords: Array,
	geom_type: String,
	out_centerlines: Array,
	out_roads: Array
) -> void:
	if geom_type == "MultiLineString":
		for line_coords in coords:
			if typeof(line_coords) == TYPE_ARRAY:
				_process_single_semantic_centerline(
					feat_id, props, line_coords, out_centerlines, out_roads
				)
	else:
		_process_single_semantic_centerline(feat_id, props, coords, out_centerlines, out_roads)


func _process_single_semantic_centerline(
	feat_id: Variant,
	props: Dictionary,
	line_coords: Array,
	out_centerlines: Array,
	out_roads: Array
) -> void:
	var raw_pts = _project_polyline(line_coords)
	var clean_pts = sanitize_polyline(raw_pts)
	if clean_pts.size() < 2:
		return

	var is_closed = (
		clean_pts[0].distance_to(clean_pts[clean_pts.size() - 1]) < DUPLICATE_VERTEX_TOLERANCE
	)
	var tags = (
		_normalize_surface_tags(props)
		if (props.has("roadProfile") or props.has("surface"))
		else _normalize_road_tags(props)
	)
	var profile_dict = props.get("roadProfile", {})

	var cl_entry = {
		"id": feat_id,
		"parent_id": props.get("parentFeatureId", feat_id),
		"role": "centerline",
		"kind": str(props.get("kind", "centerline")),
		"points": clean_pts,
		"centerline": clean_pts,
		"profile": profile_dict,
		"tags": tags,
		"properties": props,
		"is_closed": is_closed,
		"is_semantic_only": true,
		"is_authoritative_surface": false
	}
	out_centerlines.append(cl_entry)
	out_roads.append(cl_entry)


func _process_polygon(
	feat_id: Variant, props: Dictionary, rings_coords: Array, out_buildings: Array
) -> void:
	if rings_coords.is_empty():
		return

	var role = str(props.get("role", "")).strip_edges().to_lower()
	var kind = str(props.get("kind", "")).strip_edges().to_lower()
	const NON_BUILDING_ROLES = [
		"carriageway",
		"road",
		"street",
		"sidewalk",
		"footway",
		"pedestrian",
		"path",
		"bike_lane",
		"cycleway",
		"bike_facility",
		"junction",
		"intersection",
		"parking",
		"median",
		"buffer",
		"verge",
		"centerline",
		"unsupported"
	]
	if (
		role in NON_BUILDING_ROLES
		or kind in NON_BUILDING_ROLES
		or (props.has("highway") and not props.has("building"))
		or (props.has("area:highway") and not props.has("building"))
		or props.has("roadProfile")
	):
		# Road, sidewalk, and facility polygons must not become building extrusions
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
			"role": "building",
			"tags": tags,
			"properties": props,
			"outer_rings": [clean_outer],
			"inner_rings": inner_rings,
			"pois": [],
			"is_authoritative_surface": false,
			"is_semantic_only": false
		}
	)


func _process_multipolygon(
	feat_id: Variant, props: Dictionary, polys_coords: Array, out_buildings: Array
) -> void:
	if polys_coords.is_empty():
		return

	var role = str(props.get("role", "")).strip_edges().to_lower()
	var kind = str(props.get("kind", "")).strip_edges().to_lower()
	const NON_BUILDING_ROLES = [
		"carriageway",
		"road",
		"street",
		"sidewalk",
		"footway",
		"pedestrian",
		"path",
		"bike_lane",
		"cycleway",
		"bike_facility",
		"junction",
		"intersection",
		"parking",
		"median",
		"buffer",
		"verge",
		"centerline",
		"unsupported"
	]
	if (
		role in NON_BUILDING_ROLES
		or kind in NON_BUILDING_ROLES
		or (props.has("highway") and not props.has("building"))
		or (props.has("area:highway") and not props.has("building"))
		or props.has("roadProfile")
	):
		return

	var all_outers: Array[PackedVector3Array] = []
	var all_inners: Array[PackedVector3Array] = []

	for poly_coords in polys_coords:
		if typeof(poly_coords) != TYPE_ARRAY or poly_coords.is_empty():
			continue
		var outer_raw = _project_ring(poly_coords[0])
		var clean_outer = sanitize_polygon(outer_raw, DUPLICATE_VERTEX_TOLERANCE, feat_id)
		if clean_outer.size() < 4 or is_polygon_self_intersecting(clean_outer):
			continue
		clean_outer = ensure_winding(clean_outer, true)
		all_outers.append(clean_outer)

		for i in range(1, poly_coords.size()):
			var hole_raw = _project_ring(poly_coords[i])
			var clean_hole = sanitize_polygon(hole_raw, DUPLICATE_VERTEX_TOLERANCE, feat_id)
			if clean_hole.size() >= 4 and not is_polygon_self_intersecting(clean_hole):
				clean_hole = ensure_winding(clean_hole, false)
				all_inners.append(clean_hole)

	if all_outers.is_empty():
		return

	var tags = _normalize_building_tags(props)
	out_buildings.append(
		{
			"id": feat_id,
			"role": "building",
			"tags": tags,
			"properties": props,
			"outer_rings": all_outers,
			"inner_rings": all_inners,
			"pois": [],
			"is_authoritative_surface": false,
			"is_semantic_only": false
		}
	)


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
	out_roads.append(
		{
			"id": feat_id,
			"tags": tags,
			"points": clean_pts,
			"is_closed": is_closed,
			"is_authoritative_surface": false,
			"is_semantic_only": false
		}
	)


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

	var name_str = extract_name_from_props(props)

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
