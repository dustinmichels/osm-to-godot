extends SceneTree

const OSMSceneBuilderClass = preload("res://addons/osm_importer/scene_builder.gd")


func _init() -> void:
	var err = OSMSceneBuilderClass.clear_city_scene("res://city_viewer.tscn")
	if err != OK:
		push_error("[OSM Importer] Failed to clear city_viewer scene: " + str(err))
		quit(1)
	else:
		print("[OSM Importer] Successfully cleared res://city_viewer.tscn")
		quit(0)
