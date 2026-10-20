@tool
extends EditorPlugin

func _enter_tree() -> void:
	print("OSM Importer plugin initialized.")

func _exit_tree() -> void:
	print("OSM Importer plugin disabled.")
