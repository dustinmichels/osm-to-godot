class_name OSMCameraController
extends Camera3D

## 3D Fly-through and Inspection Camera
## Controls:
## - Left or Right Mouse Button + Drag: Look around
## - Mouse Wheel / Trackpad Scroll: Zoom in / out
## - Middle Mouse Button + Drag: Pan camera
## - W / S / A / D or Arrow Keys: Move Forward / Backward / Left / Right
## - E / Space: Move Up
## - Q / C / Ctrl: Move Down
## - Shift: Fast move multiplier
## - H: Toggle on-screen controls HUD
## - Esc: Release mouse cursor capture

@export var move_speed: float = 60.0
@export var fast_speed_multiplier: float = 3.0
@export var look_sensitivity: float = 0.003
@export var zoom_speed: float = 15.0
@export var pan_sensitivity: float = 0.25
@export var show_hud: bool = true

var _mouse_captured: bool = false
var _is_panning: bool = false
var _active_button: int = 0
var _yaw: float = 0.0
var _pitch: float = 0.0
var _hud_layer: CanvasLayer = null


func _ready() -> void:
	_yaw = rotation.y
	_pitch = rotation.x
	if show_hud:
		_setup_hud()


func _input(event: InputEvent) -> void:
	if not current:
		if (
			event is InputEventKey
			and event.pressed
			and (event.keycode == KEY_V or event.keycode == KEY_TAB)
		):
			_switch_to_player_camera()
		return

	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT or event.button_index == MOUSE_BUTTON_RIGHT:
			if event.pressed:
				Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
				_mouse_captured = true
				_is_panning = false
				_active_button = event.button_index
			elif event.button_index == _active_button:
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
				_mouse_captured = false
				_active_button = 0
		elif event.button_index == MOUSE_BUTTON_MIDDLE:
			if event.pressed:
				Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
				_mouse_captured = true
				_is_panning = true
				_active_button = event.button_index
			elif event.button_index == _active_button:
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
				_mouse_captured = false
				_is_panning = false
				_active_button = 0
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP:
			var zoom_mult = fast_speed_multiplier if Input.is_key_pressed(KEY_SHIFT) else 1.0
			global_position -= transform.basis.z * (zoom_speed * zoom_mult)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			var zoom_mult = fast_speed_multiplier if Input.is_key_pressed(KEY_SHIFT) else 1.0
			global_position += transform.basis.z * (zoom_speed * zoom_mult)

	elif event is InputEventMouseMotion and _mouse_captured:
		if _is_panning:
			var pan_mult = fast_speed_multiplier if Input.is_key_pressed(KEY_SHIFT) else 1.0
			global_position -= transform.basis.x * (event.relative.x * pan_sensitivity * pan_mult)
			global_position += transform.basis.y * (event.relative.y * pan_sensitivity * pan_mult)
		else:
			_yaw -= event.relative.x * look_sensitivity
			_pitch = clampf(
				_pitch - event.relative.y * look_sensitivity, -deg_to_rad(89.0), deg_to_rad(89.0)
			)
			rotation = Vector3(_pitch, _yaw, 0.0)

	elif event is InputEventKey and event.pressed:
		if event.keycode == KEY_ESCAPE:
			if _mouse_captured:
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
				_mouse_captured = false
				_is_panning = false
				_active_button = 0
		elif event.keycode == KEY_H:
			_toggle_hud()
		elif event.keycode == KEY_V or event.keycode == KEY_TAB:
			_switch_to_player_camera()


func _process(delta: float) -> void:
	if not current:
		return

	var speed = move_speed
	if Input.is_key_pressed(KEY_SHIFT):
		speed *= fast_speed_multiplier

	var dir = Vector3.ZERO
	if Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP):
		dir -= transform.basis.z
	if Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN):
		dir += transform.basis.z
	if Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT):
		dir -= transform.basis.x
	if Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT):
		dir += transform.basis.x
	if Input.is_key_pressed(KEY_E) or Input.is_key_pressed(KEY_SPACE):
		dir += Vector3.UP
	if Input.is_key_pressed(KEY_Q) or Input.is_key_pressed(KEY_C) or Input.is_key_pressed(KEY_CTRL):
		dir += Vector3.DOWN

	if dir.length_squared() > 0.001:
		dir = dir.normalized()
		global_position += dir * speed * delta


func _setup_hud() -> void:
	if Engine.is_editor_hint():
		return

	_hud_layer = CanvasLayer.new()
	_hud_layer.name = "ViewerHUD"
	add_child(_hud_layer)

	var margin = MarginContainer.new()
	margin.mouse_filter = Control.MOUSE_FILTER_IGNORE
	margin.add_theme_constant_override("margin_left", 16)
	margin.add_theme_constant_override("margin_top", 16)
	_hud_layer.add_child(margin)

	var panel = PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var style = StyleBoxFlat.new()
	style.bg_color = Color(0.08, 0.10, 0.14, 0.85)
	style.set_corner_radius_all(8)
	style.set_content_margin_all(12.0)
	style.set_border_width_all(1)
	style.border_color = Color(0.25, 0.35, 0.45, 0.6)
	panel.add_theme_stylebox_override("panel", style)
	margin.add_child(panel)

	var vbox = VBoxContainer.new()
	vbox.mouse_filter = Control.MOUSE_FILTER_IGNORE
	vbox.add_theme_constant_override("separation", 6)
	panel.add_child(vbox)

	var title = Label.new()
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	title.text = "🏙️ 3D City Viewer"
	title.add_theme_font_size_override("font_size", 16)
	title.add_theme_color_override("font_color", Color(0.9, 0.95, 1.0))
	vbox.add_child(title)

	var sep = HSeparator.new()
	sep.mouse_filter = Control.MOUSE_FILTER_IGNORE
	vbox.add_child(sep)

	var instructions = [
		"🖱️ Left / Right Drag : Look around",
		"🔄 Scroll Wheel : Zoom in / out",
		"⌨️ W A S D / Arrows : Fly camera",
		"🚀 Shift : Speed boost (3x)",
		"⬆️ Space / E : Move up",
		"⬇️ Q / C : Move down",
		"🖐️ Middle Drag : Pan view",
		"🚶 [V] / [Tab] : Switch to Player character",
		"ℹ️ [H] : Toggle this guide"
	]

	for line in instructions:
		var lbl = Label.new()
		lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
		lbl.text = line
		lbl.add_theme_font_size_override("font_size", 12)
		lbl.add_theme_color_override("font_color", Color(0.8, 0.85, 0.9))
		vbox.add_child(lbl)


func _toggle_hud() -> void:
	if _hud_layer:
		_hud_layer.visible = not _hud_layer.visible


func _switch_to_player_camera() -> void:
	var root = get_tree().current_scene if get_tree() else null
	if not root:
		root = get_parent()
	if root:
		var player = root.find_child("Player", true, false)
		if player:
			var player_cam = player.find_child("Camera3D", true, false)
			if player_cam is Camera3D:
				self.current = false
				player_cam.current = true
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
				_mouse_captured = false
				if _hud_layer:
					_hud_layer.visible = false
