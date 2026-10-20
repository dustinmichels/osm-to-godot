@tool
class_name OSMHttpServer
extends RefCounted

const OSMParserClass = preload("osm_parser.gd")
const GeoJSONParserClass = preload("geojson_parser.gd")

signal server_started(port: int, url: String)
signal server_stopped
signal import_received(parsed_data: Dictionary, raw_payload: Dictionary)
signal import_failed(error_message: String)

const SUPPORTED_EDITOR_PAYLOAD_VERSIONS: Array[String] = ["1.0.0"]

const DEFAULT_PORT: int = 8080
const MAX_PORT_ATTEMPTS: int = 10
const CONNECTION_TIMEOUT_MS: int = 20000

const MIME_TYPES: Dictionary = {
	"html": "text/html; charset=utf-8",
	"js": "application/javascript; charset=utf-8",
	"mjs": "application/javascript; charset=utf-8",
	"css": "text/css; charset=utf-8",
	"json": "application/json; charset=utf-8",
	"svg": "image/svg+xml",
	"png": "image/png",
	"jpg": "image/jpeg",
	"jpeg": "image/jpeg",
	"ico": "image/x-icon",
	"woff": "font/woff",
	"woff2": "font/woff2",
	"ttf": "font/ttf",
	"txt": "text/plain; charset=utf-8"
}

var server: TCPServer
var is_running: bool = false
var active_port: int = 0
var bind_host: String = "127.0.0.1"
var web_dist_path: String = "res://addons/osm_importer/web_dist"
var save_file_path: String = "res://data/osm_export.json"

# Active HTTP connections: StreamPeerTCP -> Dictionary
var _connections: Array[Dictionary] = []


func _init(port: int = DEFAULT_PORT, host: String = "127.0.0.1") -> void:
	active_port = port
	bind_host = host
	server = TCPServer.new()


func start(desired_port: int = DEFAULT_PORT) -> Error:
	if is_running:
		stop()

	var err: Error = FAILED
	var target_port = desired_port

	for i in range(MAX_PORT_ATTEMPTS):
		err = server.listen(target_port, bind_host)
		if err == OK:
			active_port = target_port
			is_running = true
			var url = get_url()
			print("[OSM Importer] Server listening on ", url)
			server_started.emit(active_port, url)
			return OK
		target_port += 1

	push_error(
		(
			"[OSM Importer] Failed to bind HTTP server to ports "
			+ str(desired_port)
			+ ".."
			+ str(target_port - 1)
		)
	)
	return err


func stop() -> void:
	if not is_running:
		return

	for conn in _connections:
		var peer: StreamPeerTCP = conn["peer"]
		if peer:
			peer.disconnect_from_host()
	_connections.clear()

	if server:
		server.stop()

	is_running = false
	print("[OSM Importer] Server stopped.")
	server_stopped.emit()


func get_url() -> String:
	return "http://" + bind_host + ":" + str(active_port)


## Call this in _process(delta) from the EditorPlugin or Node
func poll() -> void:
	if not is_running or server == null:
		return

	# 1. Accept new incoming connections
	while server.is_connection_available():
		var peer: StreamPeerTCP = server.take_connection()
		if peer != null:
			_connections.append(
				{
					"peer": peer,
					"buffer": PackedByteArray(),
					"header_length": -1,
					"content_length": -1,
					"start_time": Time.get_ticks_msec(),
					"method": "",
					"path": ""
				}
			)

	# 2. Service active connections
	var now = Time.get_ticks_msec()
	var remaining: Array[Dictionary] = []

	for conn in _connections:
		var peer: StreamPeerTCP = conn["peer"]
		peer.poll()
		var status = peer.get_status()

		if status != StreamPeerTCP.STATUS_CONNECTED:
			continue

		if now - conn["start_time"] > CONNECTION_TIMEOUT_MS:
			_send_error(peer, 408, "Request Timeout")
			continue

		var avail = peer.get_available_bytes()
		if avail > 0:
			var chunk = peer.get_data(avail)
			if chunk[0] == OK:
				conn["buffer"].append_array(chunk[1])

		# Parse header if not yet known
		if conn["header_length"] == -1:
			var header_end = _find_header_end(conn["buffer"])
			if header_end != -1:
				conn["header_length"] = header_end + 4
				var header_str = conn["buffer"].slice(0, header_end).get_string_from_utf8()
				_parse_headers(conn, header_str)

		# If header parsed, check if we can service the request
		if conn["header_length"] != -1:
			var method: String = conn["method"]
			var path: String = conn["path"]

			if method == "OPTIONS":
				_send_cors_preflight(peer)
				continue

			if method == "GET":
				_handle_get(peer, path)
				continue

			if method == "POST":
				var req_bytes = conn["header_length"] + conn["content_length"]
				if conn["buffer"].size() >= req_bytes:
					var body_bytes = conn["buffer"].slice(conn["header_length"], req_bytes)
					_handle_post(peer, path, body_bytes)
					continue
				else:
					# Still waiting for remaining body bytes
					remaining.append(conn)
					continue

			# Unknown method
			_send_error(peer, 405, "Method Not Allowed")
			continue

		remaining.append(conn)

	_connections = remaining


func _find_header_end(buf: PackedByteArray) -> int:
	var sz = buf.size()
	if sz < 4:
		return -1
	for i in range(sz - 3):
		if buf[i] == 13 and buf[i + 1] == 10 and buf[i + 2] == 13 and buf[i + 3] == 10:
			return i
	return -1


func _parse_headers(conn: Dictionary, header_str: String) -> void:
	var lines = header_str.split("\r\n")
	if lines.size() > 0:
		var req_line = lines[0].split(" ")
		conn["method"] = req_line[0].to_upper()
		conn["path"] = req_line[1] if req_line.size() > 1 else "/"

	var content_len = 0
	for i in range(1, lines.size()):
		var line = lines[i]
		if line.to_lower().begins_with("content-length:"):
			content_len = int(line.substr(15).strip_edges())
	conn["content_length"] = content_len


func _send_cors_preflight(peer: StreamPeerTCP) -> void:
	var resp = "HTTP/1.1 204 No Content\r\n"
	resp += "Access-Control-Allow-Origin: *\r\n"
	resp += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
	resp += "Access-Control-Allow-Headers: Content-Type, Accept\r\n"
	resp += "Access-Control-Max-Age: 86400\r\n"
	resp += "Content-Length: 0\r\n"
	resp += "Connection: close\r\n\r\n"
	peer.put_data(resp.to_utf8_buffer())


func _send_json_response(
	peer: StreamPeerTCP, status_code: int, status_text: String, data: Dictionary
) -> void:
	var json_str = JSON.stringify(data)
	var body_bytes = json_str.to_utf8_buffer()

	var resp = "HTTP/1.1 " + str(status_code) + " " + status_text + "\r\n"
	resp += "Content-Type: application/json; charset=utf-8\r\n"
	resp += "Content-Length: " + str(body_bytes.size()) + "\r\n"
	resp += "Access-Control-Allow-Origin: *\r\n"
	resp += "Connection: close\r\n\r\n"

	var out = resp.to_utf8_buffer()
	out.append_array(body_bytes)
	peer.put_data(out)


func _send_error(peer: StreamPeerTCP, status_code: int, status_text: String) -> void:
	var body = "<h1>" + str(status_code) + " " + status_text + "</h1>"
	var resp = "HTTP/1.1 " + str(status_code) + " " + status_text + "\r\n"
	resp += "Content-Type: text/html; charset=utf-8\r\n"
	resp += "Content-Length: " + str(body.length()) + "\r\n"
	resp += "Access-Control-Allow-Origin: *\r\n"
	resp += "Connection: close\r\n\r\n" + body
	peer.put_data(resp.to_utf8_buffer())


func _handle_get(peer: StreamPeerTCP, raw_path: String) -> void:
	# Strip query string or hash
	var path = raw_path.split("?")[0].split("#")[0]

	# API Endpoints
	if path == "/api/status" or path == "/api/health":
		_send_json_response(
			peer,
			200,
			"OK",
			{
				"status": "ok",
				"app": "osm-to-godot",
				"port": active_port,
				"version": "1.0.0",
				"supported_editor_payload_versions": SUPPORTED_EDITOR_PAYLOAD_VERSIONS
			}
		)
		return

	# Static File Serving
	var rel_path = path
	if rel_path == "/" or rel_path == "":
		rel_path = "/index.html"

	var full_res_path = web_dist_path.path_join(rel_path.trim_prefix("/"))

	if not FileAccess.file_exists(full_res_path):
		# Fallback: if requesting index.html or root and missing, serve fallback instructions
		if rel_path == "/index.html":
			_send_fallback_index(peer)
			return
		_send_error(peer, 404, "Not Found")
		return

	var file_bytes = FileAccess.get_file_as_bytes(full_res_path)
	var ext = rel_path.get_extension().to_lower()
	var content_type = MIME_TYPES.get(ext, "application/octet-stream")

	var resp = "HTTP/1.1 200 OK\r\n"
	resp += "Content-Type: " + content_type + "\r\n"
	resp += "Content-Length: " + str(file_bytes.size()) + "\r\n"
	resp += "Access-Control-Allow-Origin: *\r\n"
	resp += "Cache-Control: no-cache\r\n"
	resp += "Connection: close\r\n\r\n"

	var out = resp.to_utf8_buffer()
	out.append_array(file_bytes)
	peer.put_data(out)


func _send_fallback_index(peer: StreamPeerTCP) -> void:
	var html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OSM Importer - Web UI</title></head>
<body style="font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; text-align: center;">
  <h2 style="color: #60a5fa;">OSM Web Selector</h2>
  <p>The production web build was not found in <code>addons/osm_importer/web_dist/</code>.</p>
  <p>To compile and embed the web app:</p>
  <pre style="background: #1e293b; padding: 14px; border-radius: 8px; display: inline-block; text-align: left;">cd web && bun run build</pre>
  <p>Or run the local Vite development server:</p>
  <pre style="background: #1e293b; padding: 14px; border-radius: 8px; display: inline-block; text-align: left;">cd web && bun run dev</pre>
  <p><a href="http://localhost:5173" style="color: #38bdf8; font-weight: 600;">Open Dev Server (http://localhost:5173)</a></p>
</body>
</html>"""
	var body_bytes = html.to_utf8_buffer()
	var resp = "HTTP/1.1 200 OK\r\n"
	resp += "Content-Type: text/html; charset=utf-8\r\n"
	resp += "Content-Length: " + str(body_bytes.size()) + "\r\n"
	resp += "Access-Control-Allow-Origin: *\r\n"
	resp += "Connection: close\r\n\r\n"
	var out = resp.to_utf8_buffer()
	out.append_array(body_bytes)
	peer.put_data(out)


static func check_editor_payload_version(payload: Dictionary) -> Dictionary:
	var has_explicit_editor_version = (
		payload.has("editorPayloadVersion")
		or payload.has("editor_payload_version")
		or (
			payload.has("metadata")
			and typeof(payload["metadata"]) == TYPE_DICTIONARY
			and (
				payload["metadata"].has("editorPayloadVersion")
				or payload["metadata"].has("editor_payload_version")
			)
		)
	)
	var is_editor_generator = (
		str(payload.get("generator", "")).begins_with("osm-to-godot-editor")
		or (
			payload.has("metadata")
			and typeof(payload["metadata"]) == TYPE_DICTIONARY
			and str(payload["metadata"].get("generator", "")).begins_with("osm-to-godot-editor")
		)
	)
	var is_editor = has_explicit_editor_version or is_editor_generator
	if not is_editor:
		return {"is_editor": false, "valid": true}

	var version_val = payload.get(
		"editorPayloadVersion", payload.get("editor_payload_version", null)
	)
	if (
		version_val == null
		and payload.has("metadata")
		and typeof(payload["metadata"]) == TYPE_DICTIONARY
	):
		version_val = payload["metadata"].get(
			"editorPayloadVersion", payload["metadata"].get("editor_payload_version", null)
		)
	if (
		version_val == null
		and payload.has("metadata")
		and typeof(payload["metadata"]) == TYPE_DICTIONARY
	):
		version_val = payload["metadata"].get("version", null)

	var version_str = "" if version_val == null else str(version_val).strip_edges()
	if version_str.is_empty():
		var err_msg = (
			"Missing editor payload version. Supported versions: "
			+ ", ".join(SUPPORTED_EDITOR_PAYLOAD_VERSIONS)
			+ "."
		)
		return {"is_editor": true, "valid": false, "error": err_msg}
	elif not (version_str in SUPPORTED_EDITOR_PAYLOAD_VERSIONS):
		var err_msg = (
			'Unsupported editor payload version: "'
			+ version_str
			+ '". Supported versions: '
			+ ", ".join(SUPPORTED_EDITOR_PAYLOAD_VERSIONS)
			+ "."
		)
		return {"is_editor": true, "valid": false, "error": err_msg}

	return {"is_editor": true, "valid": true, "version": version_str}


func _handle_post(peer: StreamPeerTCP, path: String, body_bytes: PackedByteArray) -> void:
	if path != "/api/import":
		_send_error(peer, 404, "Not Found")
		return
	var body_str = body_bytes.get_string_from_utf8()
	var json = JSON.new()
	var err = json.parse(body_str)
	if err != OK:
		var err_msg = "Invalid JSON: " + json.get_error_message()
		push_error("[OSM Importer] " + err_msg)
		_send_json_response(peer, 400, "Bad Request", {"error": err_msg})
		import_failed.emit(err_msg)
		return

	var payload = json.data
	if typeof(payload) != TYPE_DICTIONARY:
		var err_msg = "Root JSON payload must be an object."
		_send_json_response(peer, 400, "Bad Request", {"error": err_msg})
		import_failed.emit(err_msg)
		return

	# Ensure target directory exists
	var dir_path = save_file_path.get_base_dir()
	var dir = DirAccess.open("res://")
	if dir and not dir.dir_exists(dir_path.trim_prefix("res://")):
		dir.make_dir_recursive(dir_path.trim_prefix("res://"))
	var is_geojson = payload.get("type") in ["FeatureCollection", "Feature"]
	var editor_check = check_editor_payload_version(payload)
	if editor_check["is_editor"] and not editor_check["valid"]:
		var err_msg = str(editor_check["error"])
		push_error("[OSM Importer] " + err_msg)
		_send_json_response(peer, 400, "Bad Request", {"success": false, "error": err_msg})
		import_failed.emit(err_msg)
		return
	var is_editor = editor_check["is_editor"]
	var effective_save_path = save_file_path
	var detected_format = "osm"
	if is_editor:
		effective_save_path = "res://data/editor_export.geojson"
		detected_format = "editor"
	elif is_geojson:
		var meta = payload.get("metadata", {})
		if (
			typeof(meta) == TYPE_DICTIONARY
			and (
				meta.get("source") == "Overture Maps Foundation"
				or str(meta.get("source", "")).to_lower().contains("overture")
				or meta.has("counts")
			)
		):
			effective_save_path = "res://data/overture_export.geojson"
			detected_format = "overture"
		else:
			effective_save_path = "res://data/source_export.geojson"
			detected_format = "geojson"

	# Save raw file to project
	var f = FileAccess.open(effective_save_path, FileAccess.WRITE)
	if f != null:
		f.store_string(body_str)
		f.close()
		print("[OSM Importer] Saved export file to ", effective_save_path)
	else:
		push_warning(
			(
				"[OSM Importer] Could not save export to "
				+ effective_save_path
				+ ", parsing in-memory."
			)
		)

	var parsed: Dictionary
	if is_geojson:
		var parser = GeoJSONParserClass.new()
		parsed = parser.parse_data(payload)
	else:
		var parser = OSMParserClass.new()
		parsed = parser.parse_data(payload)
	if parsed.has("error"):
		var err_msg = "Parse error: " + str(parsed["error"])
		push_error("[OSM Importer] " + err_msg)
		_send_json_response(peer, 400, "Bad Request", {"success": false, "error": err_msg})
		import_failed.emit(err_msg)
		return

	var roads_count = parsed.get("roads", []).size()
	var buildings_count = parsed.get("buildings", []).size()
	var elements_count = (
		payload.get("features", []).size() if is_geojson else payload.get("elements", []).size()
	)
	var actual_source_type = str(parsed.get("source_type", detected_format))

	print(
		"[OSM Importer] Direct import successful: ",
		roads_count,
		" roads, ",
		buildings_count,
		" buildings parsed. (Source path: ",
		actual_source_type,
		")"
	)
	_send_json_response(
		peer,
		200,
		"OK",
		{
			"success": true,
			"saved_path": effective_save_path,
			"format": actual_source_type,
			"source_type": actual_source_type,
			"stats":
			{"roads": roads_count, "buildings": buildings_count, "elements": elements_count}
		}
	)

	import_received.emit(parsed, payload)
