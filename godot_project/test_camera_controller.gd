extends SceneTree

const CameraControllerScript = preload("res://addons/osm_importer/camera_controller.gd")

func _init() -> void:
	print("========================================")
	print("Running Camera Controller Test Suite")
	print("========================================")

	var cam: Camera3D = Camera3D.new()
	cam.set_script(CameraControllerScript)
	root.add_child(cam)
	await process_frame

	assert(cam != null, "Camera node should exist")
	var initial_pos = cam.global_position
	var initial_rot = cam.rotation

	# 1. Test HUD creation
	var hud = cam.get_node_or_null("ViewerHUD")
	assert(hud != null, "ViewerHUD CanvasLayer should be created")
	assert(hud.visible == true, "HUD should be visible initially")
	print("HUD setup verified: present and visible.")

	# 2. Test HUD toggle via 'H'
	var key_h = InputEventKey.new()
	key_h.keycode = KEY_H
	key_h.pressed = true
	cam._input(key_h)
	assert(hud.visible == false, "HUD should hide when H is pressed")
	cam._input(key_h)
	assert(hud.visible == true, "HUD should show when H is pressed again")
	print("HUD toggle verified.")

	# 3. Test Left Mouse Drag look
	var lmb_press = InputEventMouseButton.new()
	lmb_press.button_index = MOUSE_BUTTON_LEFT
	lmb_press.pressed = true
	cam._input(lmb_press)
	assert(cam._mouse_captured == true, "Mouse should be captured on LMB press")

	var mouse_motion = InputEventMouseMotion.new()
	mouse_motion.relative = Vector2(100.0, 50.0)
	cam._input(mouse_motion)
	assert(cam.rotation != initial_rot, "Camera rotation should change on mouse drag")
	print("Left Mouse Button look drag verified: rotation updated.")

	var lmb_release = InputEventMouseButton.new()
	lmb_release.button_index = MOUSE_BUTTON_LEFT
	lmb_release.pressed = false
	cam._input(lmb_release)
	assert(cam._mouse_captured == false, "Mouse should be released on LMB release")

	# 4. Test Scroll Wheel Zoom
	var pre_zoom_pos = cam.global_position
	var wheel_up = InputEventMouseButton.new()
	wheel_up.button_index = MOUSE_BUTTON_WHEEL_UP
	wheel_up.pressed = true
	cam._input(wheel_up)
	assert((cam.global_position - pre_zoom_pos).length() > 1.0, "Camera should move along view direction on wheel up")
	print("Mouse wheel zoom verified: moved ", (cam.global_position - pre_zoom_pos).length(), "m.")

	# 5. Test Middle Mouse Pan
	var pre_pan_pos = cam.global_position
	var mmb_press = InputEventMouseButton.new()
	mmb_press.button_index = MOUSE_BUTTON_MIDDLE
	mmb_press.pressed = true
	cam._input(mmb_press)
	assert(cam._is_panning == true, "Camera should enter panning mode on MMB press")

	var pan_motion = InputEventMouseMotion.new()
	pan_motion.relative = Vector2(50.0, -30.0)
	cam._input(pan_motion)
	assert((cam.global_position - pre_pan_pos).length() > 0.5, "Camera should shift position when panning")
	print("Middle mouse pan verified.")

	var mmb_release = InputEventMouseButton.new()
	mmb_release.button_index = MOUSE_BUTTON_MIDDLE
	mmb_release.pressed = false
	cam._input(mmb_release)
	assert(cam._is_panning == false, "Camera should exit panning mode on MMB release")

	# 6. Test ESC to release capture
	cam._input(lmb_press)
	assert(cam._mouse_captured == true, "Captured before ESC")
	var esc_key = InputEventKey.new()
	esc_key.keycode = KEY_ESCAPE
	esc_key.pressed = true
	cam._input(esc_key)
	assert(cam._mouse_captured == false, "Mouse should be released on ESC")
	print("Escape release verified.")

	cam.free()
	print("========================================")
	print("ALL CAMERA CONTROLLER TESTS PASSED!")
	print("========================================")
	quit(0)
