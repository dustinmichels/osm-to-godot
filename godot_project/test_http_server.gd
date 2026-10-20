extends SceneTree

const OSMServer = preload("res://addons/osm_importer/http_server.gd")

func _init() -> void:
	print("========================================")
	print("Running OSMHttpServer Test Suite")
	print("========================================")

	var server = OSMServer.new(8085)
	var err = server.start(8085)
	if err != OK:
		printerr("Server failed to start: ", err)
		quit(1)
		return

	var test_state = { "received": false, "roads": 0, "buildings": 0 }
	server.import_received.connect(func(parsed, raw):
		test_state["received"] = true
		test_state["roads"] = parsed.get("roads", []).size()
		test_state["buildings"] = parsed.get("buildings", []).size()
	)

	# 1. Test GET /api/status
	print("\n--- Test 1: GET /api/status ---")
	var client = StreamPeerTCP.new()
	client.connect_to_host("127.0.0.1", 8085)
	_wait_connected(client)
	client.put_data("GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".to_utf8_buffer())

	_poll_until_response(server, client)
	var resp = client.get_utf8_string(client.get_available_bytes())
	print("Response status: ", resp.split("\r\n")[0])
	assert(resp.begins_with("HTTP/1.1 200 OK"), "Expected 200 OK")
	assert(resp.contains('"status":"ok"'), "Expected ok status")
	assert(resp.contains('"port":8085'), "Expected port 8085")
	client.disconnect_from_host()
	print("GET /api/status passed!")

	# 2. Test OPTIONS /api/import (CORS preflight)
	print("\n--- Test 2: OPTIONS /api/import ---")
	client = StreamPeerTCP.new()
	client.connect_to_host("127.0.0.1", 8085)
	_wait_connected(client)
	client.put_data("OPTIONS /api/import HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".to_utf8_buffer())
	_poll_until_response(server, client)
	resp = client.get_utf8_string(client.get_available_bytes())
	print("OPTIONS Response: ", resp.split("\r\n")[0])
	assert(resp.begins_with("HTTP/1.1 204 No Content"), "Expected 204 No Content")
	assert(resp.contains("Access-Control-Allow-Origin: *"), "Expected CORS allow origin")
	client.disconnect_from_host()
	print("OPTIONS CORS passed!")

	# 3. Test POST /api/import
	print("\n--- Test 3: POST /api/import ---")
	client = StreamPeerTCP.new()
	client.connect_to_host("127.0.0.1", 8085)
	_wait_connected(client)

	var fixture_path = "../tests/fixtures/sample_city_export.json"
	var file = FileAccess.open(fixture_path, FileAccess.READ)
	var fixture_json = file.get_as_text()
	file.close()

	var body_bytes = fixture_json.to_utf8_buffer()
	var headers = "POST /api/import HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: " + str(body_bytes.size()) + "\r\n\r\n"
	client.put_data(headers.to_utf8_buffer())
	client.put_data(body_bytes)

	_poll_until_response(server, client)
	resp = client.get_utf8_string(client.get_available_bytes())
	print("POST Response: ", resp.split("\r\n")[0])
	assert(resp.begins_with("HTTP/1.1 200 OK"), "Expected 200 OK")
	assert(resp.contains('"success":true'), "Expected success")
	assert(test_state["received"] == true, "Expected import_received signal to fire")
	assert(test_state["roads"] == 1, "Expected 1 road")
	assert(test_state["buildings"] == 2, "Expected 2 buildings")
	client.disconnect_from_host()
	print("POST /api/import passed! Parsed roads: ", test_state["roads"], " buildings: ", test_state["buildings"])

	# 4. Test GET / (Serving static web app index.html)
	print("\n--- Test 4: GET / (Web App Static Index) ---")
	client = StreamPeerTCP.new()
	client.connect_to_host("127.0.0.1", 8085)
	_wait_connected(client)
	client.put_data("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".to_utf8_buffer())
	_poll_until_response(server, client)
	var avail = client.get_available_bytes()
	var resp_chunk = client.get_utf8_string(mini(avail, 200))
	print("Static index response preview: ", resp_chunk.split("\r\n")[0])
	assert(resp_chunk.begins_with("HTTP/1.1 200 OK"), "Expected 200 OK for index.html")
	client.disconnect_from_host()
	print("GET / static serving passed!")

	server.stop()
	print("\n========================================")
	print("ALL HTTP SERVER TESTS PASSED!")
	print("========================================")
	quit(0)

func _wait_connected(client: StreamPeerTCP) -> void:
	var start = Time.get_ticks_msec()
	while client.get_status() == StreamPeerTCP.STATUS_CONNECTING:
		client.poll()
		OS.delay_msec(2)
		if Time.get_ticks_msec() - start > 2000:
			push_error("Client connect timeout")
			return

func _poll_until_response(server: OSMServer, client: StreamPeerTCP) -> void:
	var start = Time.get_ticks_msec()
	while client.get_available_bytes() == 0:
		server.poll()
		client.poll()
		OS.delay_msec(5)
		if Time.get_ticks_msec() - start > 3000:
			push_error("Response wait timeout")
			return
