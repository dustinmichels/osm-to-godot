extends SceneTree

## Headless Verification Suite for 3D Player Character & Scene Exploration

const OSMParserClass = preload("res://addons/osm_importer/osm_parser.gd")
const OSMSceneBuilderClass = preload("res://addons/osm_importer/scene_builder.gd")
const PlayerScriptClass = preload("res://character/character.gd")


func _init() -> void:
	print("==================================================")
	print("Running 3D Player Character Verification Suite")
	print("==================================================")

	var all_ok = true

	# Test 1: Character Scene & Structure Verification
	print("\n--- Test 1: Character Scene Structure ---")
	if not _verify_character_scene():
		printerr("FAIL: Character scene structure verification failed")
		all_ok = false
	else:
		print("PASS: Character scene structure verified")

	# Test 2: Character Animations & Skeleton
	print("\n--- Test 2: Character Skeleton & Animations ---")
	if not _verify_character_animations():
		printerr("FAIL: Character animations verification failed")
		all_ok = false
	else:
		print("PASS: Character animations & skeleton verified")

	# Test 3: Scene Builder Integration & Spawning
	print("\n--- Test 3: Scene Builder Integration & Plop Location ---")
	if not _verify_scene_builder_integration():
		printerr("FAIL: Scene builder player integration failed")
		all_ok = false
	else:
		print("PASS: Scene builder integration verified")

	# Test 4: Scene Serialization & Reloading
	print("\n--- Test 4: City Scene Serialization with Player ---")
	if not _verify_scene_serialization():
		printerr("FAIL: Scene serialization verification failed")
		all_ok = false
	else:
		print("PASS: Scene serialization & reloading verified")

	# Test 5: Character Movement & Physics Logic
	print("\n--- Test 5: Movement & Physics Simulation ---")
	if not _verify_movement_physics():
		printerr("FAIL: Movement & physics verification failed")
		all_ok = false
	else:
		print("PASS: Movement & physics simulation verified")

	print("\n==================================================")
	if all_ok:
		print("ALL PLAYER CHARACTER TESTS PASSED SUCCESSFULLY! (100% PASS)")
		print("==================================================")
		quit(0)
	else:
		printerr("PLAYER CHARACTER VERIFICATION FAILED!")
		print("==================================================")
		quit(1)


func _verify_character_scene() -> bool:
	var scene_path = "res://character/character.tscn"
	if not ResourceLoader.exists(scene_path):
		printerr("Character scene missing at: ", scene_path)
		return false

	var packed = load(scene_path) as PackedScene
	if not packed:
		printerr("Could not load character scene")
		return false

	var player = packed.instantiate() as CharacterBody3D
	if not player:
		printerr("Player instance is not a CharacterBody3D")
		return false

	if player.name != "Player":
		printerr("Expected Player root name, got: ", player.name)
		player.free()
		return false

	# Collision Shape Check
	var col = player.get_node_or_null("CollisionShape3D") as CollisionShape3D
	if not col or not (col.shape is CapsuleShape3D):
		printerr("Player missing CapsuleShape3D collision")
		player.free()
		return false
	var capsule = col.shape as CapsuleShape3D
	if capsule.radius <= 0.1 or capsule.height < 1.0:
		printerr("Capsule dimensions invalid: radius=", capsule.radius, " height=", capsule.height)
		player.free()
		return false
	print("  Capsule shape valid: radius = ", capsule.radius, ", height = ", capsule.height)

	# SpringArm3D & Camera3D Check
	var spring_arm = player.get_node_or_null("SpringArm3D") as SpringArm3D
	if not spring_arm:
		printerr("Player missing SpringArm3D")
		player.free()
		return false
	var cam = spring_arm.get_node_or_null("Camera3D") as Camera3D
	if not cam:
		printerr("SpringArm3D missing Camera3D")
		player.free()
		return false
	print("  Third-person camera rig valid: spring_length = ", spring_arm.spring_length)

	player.free()
	return true


func _verify_character_animations() -> bool:
	var glb_path = "res://character/human_character.glb"
	if not ResourceLoader.exists(glb_path):
		printerr("GLB character model missing at: ", glb_path)
		return false

	var glb_scene = load(glb_path) as PackedScene
	var model_inst = glb_scene.instantiate()
	if not model_inst:
		printerr("Failed to instantiate GLB character")
		return false

	# Check Skeleton3D
	var skeleton = model_inst.find_child("Skeleton3D", true, false) as Skeleton3D
	if not skeleton or skeleton.get_bone_count() < 10:
		printerr(
			"Skeleton3D missing or insufficient bones: ",
			skeleton.get_bone_count() if skeleton else 0
		)
		model_inst.free()
		return false
	print("  Skeleton3D found with ", skeleton.get_bone_count(), " bones")

	# Check AnimationPlayer
	var anim_player = model_inst.find_child("AnimationPlayer", true, false) as AnimationPlayer
	if not anim_player:
		printerr("AnimationPlayer missing on human character")
		model_inst.free()
		return false

	var required_anims = ["Idle_A", "Walk", "Sprint", "Jump_air"]
	for a in required_anims:
		if not anim_player.has_animation(a):
			printerr("Missing required animation: ", a)
			model_inst.free()
			return false
		print("  Animation '", a, "' present, length = ", anim_player.get_animation(a).length, "s")

	model_inst.free()
	return true


func _verify_scene_builder_integration() -> bool:
	var parser = OSMParserClass.new()
	var parse_res = parser.parse_file("../tests/fixtures/sample_city_export.json")
	var roads = parse_res.get("roads", [])
	var buildings = parse_res.get("buildings", [])

	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, roads, true, false, false, 500.0, 1500.0, false, [], true
	)
	if not city_root:
		printerr("City scene build returned null")
		return false

	# Check Ground
	var ground = city_root.find_child("Ground", true, false)
	if not ground:
		printerr("Walkable Ground node missing from city scene")
		city_root.free()
		return false
	var ground_col = ground.find_child("GroundCollision", true, false)
	if not ground_col:
		printerr("Ground collision missing")
		city_root.free()
		return false
	print("  Walkable ground and collision detected")

	# Check Player
	var player = city_root.find_child("Player", true, false) as CharacterBody3D
	if not player:
		printerr("Player node missing from generated city scene")
		city_root.free()
		return false
	print("  Player plopped in scene at position: ", player.position)

	# Verify player position is reasonable (near ground Y ≈ 0.2)
	if player.position.y < 0.0 or player.position.y > 5.0:
		printerr("Player spawn Y elevation unexpected: ", player.position.y)
		city_root.free()
		return false

	# Check cameras
	var player_cam = player.find_child("Camera3D", true, false) as Camera3D
	var fly_cam = city_root.get_node_or_null("Camera3D") as Camera3D
	if not player_cam or not fly_cam:
		printerr("Expected both Player camera and Overview camera")
		city_root.free()
		return false

	if not player_cam.current:
		printerr("Player camera should be current by default")
		city_root.free()
		return false
	print("  Player camera is active (current = true), fly camera is standby")

	city_root.free()
	return true


func _verify_scene_serialization() -> bool:
	var parser = OSMParserClass.new()
	var parse_res = parser.parse_file("../tests/fixtures/simple_grid.json")
	var roads = parse_res.get("roads", [])
	var buildings = parse_res.get("buildings", [])

	var city_root = OSMSceneBuilderClass.build_city_scene(
		buildings, roads, true, false, false, 500.0, 1500.0, false, [], true
	)
	var test_path = "res://test_player_serialization.tscn"
	var err = OSMSceneBuilderClass.save_city_scene(city_root, test_path)
	city_root.free()

	if err != OK:
		printerr("Failed to save city scene: ", err)
		return false

	var reloaded = load(test_path) as PackedScene
	if not reloaded:
		printerr("Failed to reload scene from: ", test_path)
		return false

	var inst = reloaded.instantiate()
	var player = inst.find_child("Player", true, false) as CharacterBody3D
	if not player:
		printerr("Player not found in reloaded scene")
		inst.free()
		DirAccess.remove_absolute(test_path)
		return false

	var script_attached = player.get_script() != null
	if not script_attached:
		printerr("Player lost script upon scene reload")
		inst.free()
		DirAccess.remove_absolute(test_path)
		return false

	var cam = player.find_child("Camera3D", true, false) as Camera3D
	if not cam or not cam.current:
		printerr("Player camera missing or not current upon reload")
		inst.free()
		DirAccess.remove_absolute(test_path)
		return false

	print("  Reloaded scene verified: Player intact with script and active camera")
	inst.free()
	DirAccess.remove_absolute(test_path)
	return true


func _verify_movement_physics() -> bool:
	var char_scene = load("res://character/character.tscn") as PackedScene
	var player = char_scene.instantiate() as CharacterBody3D
	player.position = Vector3(0.0, 1.0, 0.0)
	root.add_child(player)
	# Verify script methods & properties
	if not ("walk_speed" in player and "sprint_speed" in player and "jump_velocity" in player):
		printerr("Player missing speed/jump exported properties")
		root.remove_child(player)
		player.free()
		return false

	# Test gravity application
	var orig_y_vel = player.velocity.y
	player._physics_process(0.1)  # 0.1s delta
	# In air (not on floor), gravity pulls down
	if player.velocity.y >= orig_y_vel:
		printerr("Gravity did not pull player downward in air: vel.y = ", player.velocity.y)
		root.remove_child(player)
		player.free()
		return false
	print("  Gravity correctly applied: velocity.y = ", player.velocity.y)

	root.remove_child(player)
	player.free()
	return true
