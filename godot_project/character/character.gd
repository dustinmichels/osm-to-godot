class_name OSMPlayer
extends CharacterBody3D

## 3D Human Player Character for City Exploration
## Controls:
## - Arrow Keys / W, A, S, D: Move character
## - Shift: Sprint
## - Space: Jump
## - Left / Right Mouse Drag: Orbit camera
## - Mouse Wheel: Zoom in / out
## - V / Tab: Toggle between 3rd-Person Player View and Free Fly Camera
## - H: Toggle controls guide HUD
## - Esc: Release mouse capture

@export var walk_speed: float = 5.0
@export var sprint_speed: float = 11.0
@export var jump_velocity: float = 5.5
@export var mouse_sensitivity: float = 0.003
@export var zoom_speed: float = 0.6
@export var min_zoom: float = 1.8
@export var max_zoom: float = 14.0
@export var rotation_speed: float = 12.0
@export var fall_respawn_y: float = -25.0
@export var show_hud: bool = true

var spawn_position: Vector3 = Vector3.ZERO
var _mouse_captured: bool = false
var _camera_yaw: float = 0.0
var _camera_pitch: float = -0.25 # Slightly looking down at character
var _hud_layer: CanvasLayer = null
var _fly_camera: Camera3D = null

@onready var model: Node3D = $Model
@onready var spring_arm: SpringArm3D = $SpringArm3D
@onready var camera: Camera3D = $SpringArm3D/Camera3D
@onready var anim_player: AnimationPlayer = $Model/human_character/AnimationPlayer

var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity", 9.8)

func _ready() -> void:
	spawn_position = global_position
	
	# Configure looping animations
	if anim_player:
		for anim_name in ["Idle_A", "Walk", "Jog", "Sprint", "Jump_air", "Crouch_Idle", "Crouch_Walk", "Dance_Simple"]:
			if anim_player.has_animation(anim_name):
				anim_player.get_animation(anim_name).loop_mode = Animation.LOOP_LINEAR
		anim_player.play("Idle_A")
		
	# Initial camera pitch & yaw
	if spring_arm:
		spring_arm.rotation = Vector3(_camera_pitch, _camera_yaw, 0.0)
		
	if show_hud:
		_setup_hud()
		
	# Look for an overview fly-camera in the scene to allow toggling
	_find_fly_camera()

func _find_fly_camera() -> void:
	var root = get_tree().current_scene if get_tree() else null
	if not root:
		root = get_parent()
	if root:
		for cam in root.find_children("*", "Camera3D", true, false):
			if cam != camera:
				_fly_camera = cam
				break

func _input(event: InputEvent) -> void:
	if not camera.current:
		# If our camera is not active, only listen for camera toggle key
		if event is InputEventKey and event.pressed and (event.keycode == KEY_V or event.keycode == KEY_TAB):
			_toggle_camera_mode()
		return

	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT or event.button_index == MOUSE_BUTTON_RIGHT:
			if event.pressed:
				Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
				_mouse_captured = true
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP:
			if spring_arm:
				spring_arm.spring_length = clampf(spring_arm.spring_length - zoom_speed, min_zoom, max_zoom)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			if spring_arm:
				spring_arm.spring_length = clampf(spring_arm.spring_length + zoom_speed, min_zoom, max_zoom)
				
	elif event is InputEventMouseMotion and _mouse_captured:
		_camera_yaw -= event.relative.x * mouse_sensitivity
		_camera_pitch = clampf(_camera_pitch - event.relative.y * mouse_sensitivity, deg_to_rad(-75.0), deg_to_rad(65.0))
		if spring_arm:
			spring_arm.rotation = Vector3(_camera_pitch, _camera_yaw, 0.0)
			
	elif event is InputEventKey and event.pressed:
		if event.keycode == KEY_ESCAPE:
			if _mouse_captured:
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
				_mouse_captured = false
		elif event.keycode == KEY_H:
			_toggle_hud()
		elif event.keycode == KEY_V or event.keycode == KEY_TAB:
			_toggle_camera_mode()

func _physics_process(delta: float) -> void:
	# 1. Fall safeguard / respawn
	var cur_y = global_position.y if is_inside_tree() else position.y
	if cur_y < fall_respawn_y:
		if is_inside_tree():
			global_position = spawn_position + Vector3(0.0, 1.0, 0.0)
		else:
			position = spawn_position + Vector3(0.0, 1.0, 0.0)
		velocity = Vector3.ZERO
		return

	# 2. Gravity
	if not is_on_floor():
		velocity.y -= gravity * delta

	# 3. Jump (Space or ui_accept)
	var jump_pressed = Input.is_key_pressed(KEY_SPACE) or Input.is_action_just_pressed("ui_accept")
	if is_on_floor() and jump_pressed:
		velocity.y = jump_velocity

	# 4. Movement Input (Arrow keys + WASD)
	var input_vec = Vector2.ZERO
	if Input.is_key_pressed(KEY_UP) or Input.is_key_pressed(KEY_W):
		input_vec.y -= 1.0
	if Input.is_key_pressed(KEY_DOWN) or Input.is_key_pressed(KEY_S):
		input_vec.y += 1.0
	if Input.is_key_pressed(KEY_LEFT) or Input.is_key_pressed(KEY_A):
		input_vec.x -= 1.0
	if Input.is_key_pressed(KEY_RIGHT) or Input.is_key_pressed(KEY_D):
		input_vec.x += 1.0
		
	# Fallback to UI actions if mapped
	if input_vec == Vector2.ZERO:
		input_vec = Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")

	var is_sprinting = Input.is_key_pressed(KEY_SHIFT)
	var speed = sprint_speed if is_sprinting else walk_speed

	var move_dir = Vector3.ZERO
	if input_vec.length_squared() > 0.001:
		input_vec = input_vec.normalized()
		# Transform relative to camera horizontal angle (spring arm yaw)
		var cam_rot_y = 0.0
		if spring_arm:
			cam_rot_y = spring_arm.global_rotation.y if spring_arm.is_inside_tree() else spring_arm.rotation.y
		var forward = -Vector3(sin(cam_rot_y), 0.0, cos(cam_rot_y))
		var right = Vector3(cos(cam_rot_y), 0.0, -sin(cam_rot_y))
		move_dir = (forward * (-input_vec.y) + right * input_vec.x).normalized()

	velocity.x = move_dir.x * speed
	velocity.z = move_dir.z * speed

	# 5. Turn model smoothly to face move direction
	if model and move_dir.length_squared() > 0.001:
		var target_angle = atan2(-move_dir.x, -move_dir.z)
		model.rotation.y = lerp_angle(model.rotation.y, target_angle, rotation_speed * delta)

	if is_inside_tree():
		move_and_slide()
	else:
		position += velocity * delta

	# 6. Update Animations
	_update_animation(move_dir, is_sprinting)

func _update_animation(move_dir: Vector3, is_sprinting: bool) -> void:
	if not anim_player:
		return

	var target_anim = "Idle_A"
	if not is_on_floor():
		target_anim = "Jump_air"
	elif move_dir.length_squared() > 0.001:
		if is_sprinting:
			target_anim = "Sprint" if anim_player.has_animation("Sprint") else "Walk"
		else:
			target_anim = "Walk"
	else:
		target_anim = "Idle_A"

	if anim_player.current_animation != target_anim:
		anim_player.play(target_anim, 0.2)

func _toggle_camera_mode() -> void:
	if not _fly_camera:
		_find_fly_camera()
	if not _fly_camera:
		return

	if camera.current:
		# Switch to Fly Camera
		camera.current = false
		_fly_camera.current = true
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		_mouse_captured = false
		if _hud_layer:
			_hud_layer.visible = false
	else:
		# Switch to Player 3rd-Person Camera
		_fly_camera.current = false
		camera.current = true
		if _hud_layer:
			_hud_layer.visible = true

func _setup_hud() -> void:
	if Engine.is_editor_hint():
		return

	_hud_layer = CanvasLayer.new()
	_hud_layer.name = "PlayerHUD"
	add_child(_hud_layer)

	var margin = MarginContainer.new()
	margin.mouse_filter = Control.MOUSE_FILTER_IGNORE
	margin.add_theme_constant_override("margin_left", 16)
	margin.add_theme_constant_override("margin_top", 16)
	_hud_layer.add_child(margin)

	var panel = PanelContainer.new()
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var style = StyleBoxFlat.new()
	style.bg_color = Color(0.08, 0.10, 0.14, 0.88)
	style.set_corner_radius_all(8)
	style.set_content_margin_all(12.0)
	style.set_border_width_all(1)
	style.border_color = Color(0.25, 0.45, 0.65, 0.6)
	panel.add_theme_stylebox_override("panel", style)
	margin.add_child(panel)

	var vbox = VBoxContainer.new()
	vbox.mouse_filter = Control.MOUSE_FILTER_IGNORE
	vbox.add_theme_constant_override("separation", 5)
	panel.add_child(vbox)

	var title = Label.new()
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	title.text = "🚶 City Explorer"
	title.add_theme_font_size_override("font_size", 16)
	title.add_theme_color_override("font_color", Color(0.9, 0.96, 1.0))
	vbox.add_child(title)

	var sep = HSeparator.new()
	sep.mouse_filter = Control.MOUSE_FILTER_IGNORE
	vbox.add_child(sep)

	var instructions = [
		"⌨️ ⬆️ ⬇️ ⬅️ ➡️ / W A S D : Move",
		"🚀 Shift : Sprint",
		"⬆️ Space : Jump",
		"🖱️ Left / Right Drag : Orbit camera",
		"🔄 Scroll Wheel : Zoom in / out",
		"📷 [V] / [Tab] : Toggle Fly / Player camera",
		"ℹ️ [H] : Toggle this guide"
	]

	for line in instructions:
		var lbl = Label.new()
		lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
		lbl.text = line
		lbl.add_theme_font_size_override("font_size", 12)
		lbl.add_theme_color_override("font_color", Color(0.82, 0.88, 0.94))
		vbox.add_child(lbl)

func _toggle_hud() -> void:
	if _hud_layer:
		_hud_layer.visible = not _hud_layer.visible
