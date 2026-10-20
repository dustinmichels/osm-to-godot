@tool
class_name OSMImporterDock
extends PanelContainer

signal open_browser_requested()
signal open_dev_browser_requested()
signal generate_requested(create_colliders: bool, custom_path: String)

var status_label: Label
var log_display: RichTextLabel
var server_url_label: Label
var auto_gen_checkbox: CheckBox
var colliders_checkbox: CheckBox
var generate_btn: Button
var chunking_checkbox: CheckBox
var csg_checkbox: CheckBox
var dataset_option: OptionButton
var player_checkbox: CheckBox

func _init() -> void:
	custom_minimum_size = Vector2(0, 180)
	_build_ui()

func _build_ui() -> void:
	var margin = MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 12)
	margin.add_theme_constant_override("margin_right", 12)
	margin.add_theme_constant_override("margin_top", 10)
	margin.add_theme_constant_override("margin_bottom", 10)
	add_child(margin)

	var root_vbox = VBoxContainer.new()
	root_vbox.add_theme_constant_override("separation", 10)
	margin.add_child(root_vbox)

	# --- Header Row ---
	var header_hbox = HBoxContainer.new()
	header_hbox.add_theme_constant_override("separation", 12)
	root_vbox.add_child(header_hbox)

	var title_lbl = Label.new()
	title_lbl.text = "OSM-to-Godot Importer"
	title_lbl.add_theme_font_size_override("font_size", 14)
	header_hbox.add_child(title_lbl)

	status_label = Label.new()
	status_label.text = "● Local Server Active"
	status_label.modulate = Color(0.3, 0.9, 0.4)
	header_hbox.add_child(status_label)

	server_url_label = Label.new()
	server_url_label.text = "(http://127.0.0.1:8080)"
	server_url_label.modulate = Color(0.65, 0.7, 0.8)
	header_hbox.add_child(server_url_label)

	header_hbox.add_spacer(false)

	var open_btn = Button.new()
	open_btn.text = "🌐 Open Web Selector"
	open_btn.tooltip_text = "Launch embedded MapLibre web interface in default browser"
	open_btn.pressed.connect(func(): open_browser_requested.emit())
	header_hbox.add_child(open_btn)

	var dev_btn = Button.new()
	dev_btn.text = "⚡ Dev Server (5173)"
	dev_btn.tooltip_text = "Open Vite development server (http://localhost:5173)"
	dev_btn.pressed.connect(func(): open_dev_browser_requested.emit())
	header_hbox.add_child(dev_btn)

	# --- Content Split: Left Info, Right Activity Log ---
	var split_hbox = HBoxContainer.new()
	split_hbox.add_theme_constant_override("separation", 14)
	split_hbox.size_flags_vertical = Control.SIZE_EXPAND_FILL
	root_vbox.add_child(split_hbox)

	# Left Sidebar
	var left_vbox = VBoxContainer.new()
	left_vbox.custom_minimum_size = Vector2(260, 0)
	left_vbox.add_theme_constant_override("separation", 6)
	split_hbox.add_child(left_vbox)

	var workflow_lbl = Label.new()
	workflow_lbl.text = "Workflow:"
	workflow_lbl.add_theme_font_size_override("font_size", 12)
	left_vbox.add_child(workflow_lbl)

	var steps_lbl = Label.new()
	steps_lbl.text = "1. Click 'Open Web Selector'\n2. Choose city bounding box\n3. Click 'Send to Godot'\n4. Scene auto-generates here"
	steps_lbl.modulate = Color(0.75, 0.8, 0.85)
	steps_lbl.add_theme_font_size_override("font_size", 11)
	left_vbox.add_child(steps_lbl)

	var file_dest_lbl = Label.new()
	file_dest_lbl.text = "Export target: res://data/osm_export.json"
	file_dest_lbl.modulate = Color(0.55, 0.6, 0.7)
	file_dest_lbl.add_theme_font_size_override("font_size", 10.5)
	left_vbox.add_child(file_dest_lbl)

	var sep = HSeparator.new()
	sep.add_theme_constant_override("separation", 8)
	left_vbox.add_child(sep)

	var gen_header = Label.new()
	gen_header.text = "3D Generation:"
	gen_header.add_theme_font_size_override("font_size", 12)
	left_vbox.add_child(gen_header)

	auto_gen_checkbox = CheckBox.new()
	auto_gen_checkbox.text = "Auto-build on Import"
	auto_gen_checkbox.button_pressed = true
	auto_gen_checkbox.tooltip_text = "Automatically generate 3D buildings when data is received from browser"
	left_vbox.add_child(auto_gen_checkbox)

	colliders_checkbox = CheckBox.new()
	colliders_checkbox.text = "Generate Colliders"
	colliders_checkbox.button_pressed = true
	colliders_checkbox.tooltip_text = "Generate StaticBody3D collision shapes for each building"
	left_vbox.add_child(colliders_checkbox)
	csg_checkbox = CheckBox.new()
	csg_checkbox.text = "Extrude 2D Footprints (CSG)"
	csg_checkbox.button_pressed = true
	csg_checkbox.tooltip_text = "Generate buildings as editable 2D CSGPolygon3D footprint extrusions (best for small areas)"
	left_vbox.add_child(csg_checkbox)
	chunking_checkbox = CheckBox.new()
	chunking_checkbox.text = "Spatial Chunking (500m)"
	chunking_checkbox.button_pressed = false
	chunking_checkbox.tooltip_text = "Partition large city scopes into 500m x 500m grid chunks with distance-based LOD culling"
	left_vbox.add_child(chunking_checkbox)
	player_checkbox = CheckBox.new()
	player_checkbox.text = "Spawn Player Character"
	player_checkbox.button_pressed = true
	player_checkbox.tooltip_text = "Spawn animated 3D human character with third-person camera to explore using arrow keys"
	left_vbox.add_child(player_checkbox)

	var dataset_lbl = Label.new()
	dataset_lbl.text = "Dataset Source:"
	dataset_lbl.add_theme_font_size_override("font_size", 11)
	left_vbox.add_child(dataset_lbl)

	dataset_option = OptionButton.new()
	dataset_option.add_item("Current Export (res://data/osm_export.json)", 0)
	dataset_option.add_item("Medford-Y Preset (res://data/medford_y_export.json)", 1)
	left_vbox.add_child(dataset_option)

	generate_btn = Button.new()
	generate_btn.text = "🔨 Generate 3D City"
	generate_btn.tooltip_text = "Build 3D city scene from selected dataset"
	generate_btn.pressed.connect(func(): generate_requested.emit(colliders_checkbox.button_pressed, get_selected_dataset_path()))
	left_vbox.add_child(generate_btn)
	# Right Activity Log
	var right_vbox = VBoxContainer.new()
	right_vbox.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right_vbox.size_flags_vertical = Control.SIZE_EXPAND_FILL
	split_hbox.add_child(right_vbox)

	var log_header = Label.new()
	log_header.text = "Import Activity:"
	log_header.add_theme_font_size_override("font_size", 12)
	right_vbox.add_child(log_header)

	log_display = RichTextLabel.new()
	log_display.bbcode_enabled = true
	log_display.scroll_following = true
	log_display.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	log_display.size_flags_vertical = Control.SIZE_EXPAND_FILL
	log_display.custom_minimum_size = Vector2(0, 90)
	log_display.text = "[color=#64748b]Waiting for export data from browser...[/color]\n"
	right_vbox.add_child(log_display)

func set_server_info(url: String, is_active: bool) -> void:
	if is_active:
		status_label.text = "● Local Server Active"
		status_label.modulate = Color(0.3, 0.9, 0.4)
		server_url_label.text = "(" + url + ")"
	else:
		status_label.text = "○ Server Stopped"
		status_label.modulate = Color(0.8, 0.3, 0.3)
		server_url_label.text = ""

func log_import_success(stats: Dictionary, metadata: Dictionary, save_path: String) -> void:
	var time_str = Time.get_time_string_from_system()
	var roads = stats.get("roads", 0)
	var buildings = stats.get("buildings", 0)
	var elements = stats.get("elements", 0)

	var origin_text = ""
	if metadata.has("centroid"):
		var c = metadata["centroid"]
		origin_text = " | Centroid: (%.4f, %.4f)" % [float(c.get("lat", 0.0)), float(c.get("lon", 0.0))]

	var log_entry = "[color=#38bdf8][%s][/color] [color=#4ade80][b]Direct Import Received![/b][/color]\n" % time_str
	log_entry += "  [color=#e2e8f0]• Features:[/color] [b]%d[/b] roads, [b]%d[/b] buildings (%d OSM elements)%s\n" % [roads, buildings, elements, origin_text]
	log_entry += "  [color=#94a3b8]• Saved to: %s[/color]\n" % save_path

	log_display.append_text(log_entry)

func log_import_error(err_msg: String) -> void:
	var time_str = Time.get_time_string_from_system()
	log_display.append_text("[color=#38bdf8][%s][/color] [color=#f87171]Import Failed:[/color] %s\n" % [time_str, err_msg])

func is_auto_generate_enabled() -> bool:
	return auto_gen_checkbox.button_pressed if auto_gen_checkbox else true

func should_create_colliders() -> bool:
	return colliders_checkbox.button_pressed if colliders_checkbox else true
func should_use_spatial_chunks() -> bool:
	return chunking_checkbox.button_pressed if chunking_checkbox else false

func should_use_csg_buildings() -> bool:
	return csg_checkbox.button_pressed if csg_checkbox else true

func should_spawn_player() -> bool:
	return player_checkbox.button_pressed if player_checkbox else true
func get_selected_dataset_path() -> String:
	if dataset_option == null:
		return "res://data/osm_export.json"
	match dataset_option.selected:
		1:
			return "res://data/medford_y_export.json"
		_:
			return "res://data/osm_export.json"


func log_generation_success(count: int, scene_path: String) -> void:
	var time_str = Time.get_time_string_from_system()
	var log_entry = "[color=#38bdf8][%s][/color] [color=#38bdf8][b]3D City Generated![/b][/color]\n" % time_str
	log_entry += "  [color=#e2e8f0]• Generated:[/color] [b]%d[/b] buildings with materials & colliders\n" % count
	log_entry += "  [color=#94a3b8]• Active Scene: %s[/color]\n" % scene_path
	log_display.append_text(log_entry)

func log_generation_error(err_msg: String) -> void:
	var time_str = Time.get_time_string_from_system()
	log_display.append_text("[color=#38bdf8][%s][/color] [color=#f87171]Generation Error:[/color] %s\n" % [time_str, err_msg])
