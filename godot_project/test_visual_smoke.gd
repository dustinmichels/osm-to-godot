extends SceneTree

## Visual Smoke Test in Godot 3D Viewport
## Builds a 3D city scene with buildings, roads, lighting, camera and captures/verifies viewport rendering frames.

const OSMParserClass = preload("res://addons/osm_importer/osm_parser.gd")
const OSMSceneBuilderClass = preload("res://addons/osm_importer/scene_builder.gd")

func _init() -> void:
	print("--- Running Visual Smoke Test in Godot 3D Viewport ---")
	
	var parser = OSMParserClass.new()
	var parse_res = parser.parse_file("../tests/fixtures/sample_city_export.json")
	if parse_res.has("error"):
		printerr("FAIL: Could not parse sample_city_export.json")
		quit(1)
		return
		
	var buildings: Array = parse_res.get("buildings", [])
	var roads: Array = parse_res.get("roads", [])
	
	var city_root = OSMSceneBuilderClass.build_city_scene(buildings, roads, true)
	if city_root == null:
		printerr("FAIL: Failed to build CityRoot node")
		quit(1)
		return
		
	# Add city scene to tree
	root.add_child(city_root)
	
	# Verify camera and viewport
	var camera: Camera3D = city_root.get_node_or_null("Camera3D") as Camera3D
	if camera == null:
		camera = city_root.get_node_or_null("InspectionCamera") as Camera3D
	if camera == null:
		printerr("FAIL: Camera3D/InspectionCamera not found in scene")
		quit(1)
		return
		
	camera.current = true
	await process_frame
	print("  InspectionCamera positioned at: ", camera.global_position, " looking at origin")
	# Wait for 3 render frames to ensure materials, shaders, and geometry render into the viewport buffer
	for i in range(3):
		await process_frame
		RenderingServer.force_draw(true)
		
	var viewport = root.get_viewport()
	assert(viewport != null, "Viewport should not be null")
	var tex = viewport.get_texture()
	assert(tex != null, "Viewport texture should not be null")
	
	var img = tex.get_image()
	assert(img != null, "Viewport texture image should be readable")
	assert(img.get_width() > 0 and img.get_height() > 0, "Viewport image dimensions must be > 0")
	
	# Save smoke test render capture to disk for inspection
	var save_err = img.save_png("res://smoke_test_render.png")
	print("  Rendered viewport capture (", img.get_width(), "x", img.get_height(), ") saved to res://smoke_test_render.png (error: ", save_err, ")")
	
	print("Visual smoke test in Godot 3D viewport PASSED!")
	quit(0)
