extends SceneTree

const RoadBuilderClass = preload("res://addons/osm_importer/road_builder.gd")

func _init() -> void:
	print("--- Test Edge Case 4: Roundabouts (junction=roundabout) ---")
	
	# 1. Test width and lane resolution for roundabout
	var residential_rb_tags = {
		"highway": "residential",
		"junction": "roundabout"
	}
	var res_width = RoadBuilderClass.resolve_road_width(residential_rb_tags)
	print("Roundabout residential width: ", res_width.width, " lane_width: ", res_width.lane_width)
	assert(res_width.lane_width == 4.5, "Roundabout should have minimum 4.5m circulatory lane width")
	
	var primary_2lane_rb_tags = {
		"highway": "primary",
		"junction": "roundabout",
		"lanes": "2"
	}
	var pri_width = RoadBuilderClass.resolve_road_width(primary_2lane_rb_tags)
	print("Roundabout 2-lane width: ", pri_width.width, " lanes: ", pri_width.lanes, " lane_width: ", pri_width.lane_width)
	assert(pri_width.width == 9.0, "2-lane roundabout should have 9.0m width (2 * 4.5m)")
	
	# 2. Test closed loop curvature normal continuity on a circular way
	var num_pts = 16
	var radius = 20.0
	var circle_pts_2d = PackedVector2Array()
	var circle_pts_3d = PackedVector3Array()
	for i in range(num_pts + 1):
		var angle = (float(i) / float(num_pts)) * TAU
		var p2 = Vector2(cos(angle) * radius, sin(angle) * radius)
		circle_pts_2d.append(p2)
		circle_pts_3d.append(Vector3(p2.x, 0.0, p2.y))
		
	var normals = RoadBuilderClass.compute_polyline_normals_2d(circle_pts_2d, 2.0, true)
	print("First vertex normal: ", normals[0], " Last vertex normal: ", normals[num_pts])
	assert(normals[0].distance_to(normals[num_pts]) < 0.001, "Closed loop roundabout start and end normals must match seamlessly")
	
	# Check all normals point outward radially
	for i in range(num_pts):
		var pt_dir = circle_pts_2d[i].normalized()
		var n_dir = normals[i].normalized()
		# In 2D tangent plane, right-hand normal for CCW circle points inward or outward radially
		var dot_prod = abs(pt_dir.dot(n_dir))
		assert(dot_prod > 0.9, "Roundabout normals should align radially with curvature")
		
	# 3. Test generate_road_ribbon with closed loop
	var ribbon = RoadBuilderClass.generate_road_ribbon(circle_pts_3d, 6.0, 0.0, 0.05, 2.0, "flat", "flat", true)
	var v_start_l = ribbon.vertices[0]
	var v_end_l = ribbon.vertices[num_pts * 2]
	assert(v_start_l.distance_to(v_end_l) < 0.01, "Left vertices of start and end must meet seamlessly")
	var v_start_r = ribbon.vertices[1]
	var v_end_r = ribbon.vertices[num_pts * 2 + 1]
	assert(v_start_r.distance_to(v_end_r) < 0.01, "Right vertices of start and end must meet seamlessly")
	
	print("Roundabout curvature and lane width tests PASSED!")
	quit(0)
