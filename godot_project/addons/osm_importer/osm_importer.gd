@tool
extends EditorPlugin

const OSMHttpServerClass = preload("http_server.gd")
const OSMDockClass = preload("osm_dock.gd")
const OSMSceneBuilderClass = preload("scene_builder.gd")
const OSMParserClass = preload("osm_parser.gd")
const GeoJSONParserClass = preload("geojson_parser.gd")
var http_server: OSMHttpServer
var dock: Control
var bottom_panel_button: Button
var toolbar_button: Button


func _enter_tree() -> void:
	print("[OSM Importer] Initializing plugin...")

	# 1. Initialize HTTP Server
	http_server = OSMHttpServerClass.new(8080)
	http_server.import_received.connect(_on_import_received)
	http_server.import_failed.connect(_on_import_failed)
	var err = http_server.start(8080)
	if err != OK:
		push_warning(
			"[OSM Importer] Could not start local server on port 8080 (err: " + str(err) + ")"
		)

	# 2. Add Bottom Panel Dock
	dock = OSMDockClass.new()
	dock.open_browser_requested.connect(_on_open_browser_requested)
	dock.open_dev_browser_requested.connect(_on_open_dev_browser_requested)
	dock.generate_requested.connect(_on_generate_requested)
	dock.set_server_info(http_server.get_url(), http_server.is_running)
	bottom_panel_button = add_control_to_bottom_panel(dock, "OSM Importer")

	# 3. Add 3D Spatial Editor Toolbar Button
	toolbar_button = Button.new()
	toolbar_button.text = "🗺️ OSM Selector"
	toolbar_button.flat = true
	toolbar_button.tooltip_text = "Open Web Bounding Box Selector & Importer"
	toolbar_button.pressed.connect(_on_toolbar_button_pressed)
	add_control_to_container(CONTAINER_SPATIAL_EDITOR_MENU, toolbar_button)

	# 4. Add Project -> Tools Menu Item
	add_tool_menu_item("Open OSM Selector", Callable(self, "_on_open_browser_requested"))

	set_process(true)
	print("[OSM Importer] Initialized. Server running at: ", http_server.get_url())


func _exit_tree() -> void:
	print("[OSM Importer] Disabling plugin...")

	if http_server:
		http_server.stop()
		http_server = null

	if toolbar_button:
		remove_control_from_container(CONTAINER_SPATIAL_EDITOR_MENU, toolbar_button)
		toolbar_button.queue_free()
		toolbar_button = null

	if dock:
		remove_control_from_bottom_panel(dock)
		dock.queue_free()
		dock = null

	remove_tool_menu_item("Open OSM Selector")
	print("[OSM Importer] Disabled.")


func _process(_delta: float) -> void:
	if http_server:
		http_server.poll()


func _on_toolbar_button_pressed() -> void:
	if dock:
		make_bottom_panel_item_visible(dock)
	_on_open_browser_requested()


func _on_open_browser_requested() -> void:
	if http_server and http_server.is_running:
		var url = http_server.get_url()
		print("[OSM Importer] Launching web app in browser: ", url)
		OS.shell_open(url)
	else:
		OS.shell_open("http://127.0.0.1:8080")


func _on_open_dev_browser_requested() -> void:
	print("[OSM Importer] Launching Vite dev server: http://localhost:5173")
	OS.shell_open("http://localhost:5173")


func _on_import_received(parsed_data: Dictionary, raw_payload: Dictionary) -> void:
	var is_geojson = raw_payload.get("type") in ["FeatureCollection", "Feature"]
	var elem_count = (
		raw_payload.get("features", []).size()
		if is_geojson
		else raw_payload.get("elements", []).size()
	)
	var stats = {
		"roads": parsed_data.get("roads", []).size(),
		"buildings": parsed_data.get("buildings", []).size(),
		"elements": elem_count
	}
	var metadata = raw_payload.get("metadata", {})
	var save_path = (
		"res://data/overture_export.geojson"
		if is_geojson
		else (http_server.save_file_path if http_server else "res://data/osm_export.json")
	)

	if dock and dock.has_method("log_import_success"):
		dock.log_import_success(stats, metadata, save_path)
		if dock.is_inside_tree():
			make_bottom_panel_item_visible(dock)

	var should_auto_build = true
	var create_colliders = true
	if dock:
		if dock.has_method("is_auto_generate_enabled"):
			should_auto_build = dock.is_auto_generate_enabled()
		if dock.has_method("should_create_colliders"):
			create_colliders = dock.should_create_colliders()

	var use_spatial_chunks = (
		dock.should_use_spatial_chunks()
		if (dock and dock.has_method("should_use_spatial_chunks"))
		else false
	)
	var use_csg = (
		dock.should_use_csg_buildings()
		if (dock and dock.has_method("should_use_csg_buildings"))
		else false
	)
	var spawn_player = (
		dock.should_spawn_player() if (dock and dock.has_method("should_spawn_player")) else true
	)
	if should_auto_build:
		_generate_3d_scene(
			parsed_data.get("buildings", []),
			parsed_data.get("roads", []),
			create_colliders,
			use_spatial_chunks,
			use_csg,
			parsed_data.get("pois", []),
			spawn_player,
			metadata
		)


func _on_import_failed(error_msg: String) -> void:
	if dock and dock.has_method("log_import_error"):
		dock.log_import_error(error_msg)


func _on_generate_requested(create_colliders: bool, custom_path: String = "") -> void:
	var path = (
		custom_path
		if not custom_path.is_empty()
		else (http_server.save_file_path if http_server else "res://data/osm_export.json")
	)
	var file = FileAccess.open(path, FileAccess.READ)
	if (
		file == null
		and (path == "res://data/osm_export.json" or path == "res://data/medford_y_export.json")
	):
		var fallback_path = "res://data/medford_y_export.json"
		file = FileAccess.open(fallback_path, FileAccess.READ)
		if file == null:
			fallback_path = "../tests/fixtures/medford_y_export.json"
			file = FileAccess.open(fallback_path, FileAccess.READ)
		if file != null:
			path = fallback_path
	elif (
		file == null
		and (
			path == "res://data/overture_export.geojson"
			or path == "res://data/medford_y_overture.geojson"
		)
	):
		var fallback_path = "res://data/medford_y_overture.geojson"
		file = FileAccess.open(fallback_path, FileAccess.READ)
		if file == null:
			fallback_path = "../tests/fixtures/medford_y_overture.geojson"
			file = FileAccess.open(fallback_path, FileAccess.READ)
		if file != null:
			path = fallback_path
	elif (
		file == null
		and (
			path == "res://data/editor_export.geojson"
			or path == "res://data/editor_scene_export.geojson"
		)
	):
		var fallback_path = "res://data/editor_scene_export.geojson"
		file = FileAccess.open(fallback_path, FileAccess.READ)
		if file == null:
			fallback_path = "../tests/fixtures/editor_scene_export.geojson"
			file = FileAccess.open(fallback_path, FileAccess.READ)
		if file != null:
			path = fallback_path
	if file == null:
		var err_msg = "Could not open export file at " + path
		push_error("[OSM Importer] " + err_msg)
		if dock and dock.has_method("log_generation_error"):
			dock.log_generation_error(err_msg)
		return
	var text = file.get_as_text()
	file.close()

	var parsed: Dictionary
	if path.ends_with(".geojson"):
		var geo_parser = GeoJSONParserClass.new()
		parsed = geo_parser.parse_json_string(text)
	else:
		var json = JSON.new()
		if json.parse(text) == OK and typeof(json.data) == TYPE_DICTIONARY:
			var root_type = str(json.data.get("type", ""))
			if root_type in ["FeatureCollection", "Feature"]:
				var geo_parser = GeoJSONParserClass.new()
				parsed = geo_parser.parse_data(json.data)
			else:
				var parser = OSMParserClass.new()
				parsed = parser.parse_data(json.data)
		else:
			var parser = OSMParserClass.new()
			parsed = parser.parse_json_string(text)
	var use_spatial_chunks = (
		dock.should_use_spatial_chunks()
		if (dock and dock.has_method("should_use_spatial_chunks"))
		else false
	)
	var use_csg = (
		dock.should_use_csg_buildings()
		if (dock and dock.has_method("should_use_csg_buildings"))
		else false
	)
	var spawn_player = (
		dock.should_spawn_player() if (dock and dock.has_method("should_spawn_player")) else true
	)
	_generate_3d_scene(
		parsed.get("buildings", []),
		parsed.get("roads", []),
		create_colliders,
		use_spatial_chunks,
		use_csg,
		parsed.get("pois", []),
		spawn_player,
		parsed.get("metadata", {})
	)


func _generate_3d_scene(
	buildings: Array,
	roads: Array,
	create_colliders: bool = true,
	use_spatial_chunks: bool = false,
	use_csg: bool = false,
	pois: Array = [],
	spawn_player: bool = true,
	scene_metadata: Dictionary = {}
) -> void:
	if buildings.is_empty():
		push_warning("[OSM Importer] No buildings found to generate.")
		if dock and dock.has_method("log_generation_error"):
			dock.log_generation_error("No buildings found in export dataset.")
		return

	var scene_path = "res://city_viewer.tscn"
	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings,
		roads,
		create_colliders,
		false,
		use_spatial_chunks,
		500.0,
		1500.0,
		use_csg,
		pois,
		spawn_player,
		true,
		scene_metadata
	)
	var err = OSMSceneBuilderClass.save_city_scene(city_root, scene_path)
	if err != OK:
		var err_msg = "Failed to save city scene to " + scene_path + " (code: " + str(err) + ")"
		if dock and dock.has_method("log_generation_error"):
			dock.log_generation_error(err_msg)
		city_root.free()
		return

	city_root.free()

	if Engine.is_editor_hint():
		var editor_interface = get_editor_interface()
		if editor_interface:
			editor_interface.open_scene_from_path(scene_path)

	if dock and dock.has_method("log_generation_success"):
		dock.log_generation_success(buildings.size(), scene_path)
