class_name OSMCameraController
extends Camera3D

## 3D Fly-through and Inspection Camera
## Controls:
## - Right Mouse Button + Drag: Look around
## - W / S / A / D: Move Forward / Backward / Left / Right
## - E / Space: Move Up
## - Q / Ctrl: Move Down
## - Shift: Fast move multiplier

@export var move_speed: float = 60.0
@export var fast_speed_multiplier: float = 3.0
@export var look_sensitivity: float = 0.003

var _mouse_captured: bool = false
var _yaw: float = 0.0
var _pitch: float = 0.0

func _ready() -> void:
	_yaw = rotation.y
	_pitch = rotation.x

func _input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT:
			if event.pressed:
				Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
				_mouse_captured = true
			else:
				Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
				_mouse_captured = false
	elif event is InputEventMouseMotion and _mouse_captured:
		_yaw -= event.relative.x * look_sensitivity
		_pitch = clampf(_pitch - event.relative.y * look_sensitivity, -deg_to_rad(89.0), deg_to_rad(89.0))
		rotation = Vector3(_pitch, _yaw, 0.0)

func _process(delta: float) -> void:
	var speed = move_speed
	if Input.is_key_pressed(KEY_SHIFT):
		speed *= fast_speed_multiplier

	var dir = Vector3.ZERO
	if Input.is_key_pressed(KEY_W):
		dir -= transform.basis.z
	if Input.is_key_pressed(KEY_S):
		dir += transform.basis.z
	if Input.is_key_pressed(KEY_A):
		dir -= transform.basis.x
	if Input.is_key_pressed(KEY_D):
		dir += transform.basis.x
	if Input.is_key_pressed(KEY_E) or Input.is_key_pressed(KEY_SPACE):
		dir += Vector3.UP
	if Input.is_key_pressed(KEY_Q) or Input.is_key_pressed(KEY_CTRL):
		dir += Vector3.DOWN

	if dir.length_squared() > 0.001:
		dir = dir.normalized()
		global_position += dir * speed * delta
