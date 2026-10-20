@tool
extends EditorPlugin

const OSMHttpServerClass = preload("http_server.gd")
const OSMDockClass = preload("osm_dock.gd")

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
		push_warning("[OSM Importer] Could not start local server on port 8080 (err: " + str(err) + ")")

	# 2. Add Bottom Panel Dock
	dock = OSMDockClass.new()
	dock.open_browser_requested.connect(_on_open_browser_requested)
	dock.open_dev_browser_requested.connect(_on_open_dev_browser_requested)
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
	var stats = {
		"roads": parsed_data.get("roads", []).size(),
		"buildings": parsed_data.get("buildings", []).size(),
		"elements": raw_payload.get("elements", []).size()
	}
	var metadata = raw_payload.get("metadata", {})
	var save_path = http_server.save_file_path if http_server else "res://data/osm_export.json"

	if dock and dock.has_method("log_import_success"):
		dock.log_import_success(stats, metadata, save_path)
		if dock.is_inside_tree():
			make_bottom_panel_item_visible(dock)

func _on_import_failed(error_msg: String) -> void:
	if dock and dock.has_method("log_import_error"):
		dock.log_import_error(error_msg)
