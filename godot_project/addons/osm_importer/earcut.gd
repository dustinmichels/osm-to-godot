class_name Earcut
extends RefCounted

## 2D Polygon Triangulation using the Earcut algorithm with hole support.

class ENode:
	var i: int
	var x: float
	var y: float
	var prev: ENode = null
	var next: ENode = null
	var z: int = 0
	var prevZ: ENode = null
	var nextZ: ENode = null
	var steiner: bool = false
	
	func _init(idx: int, px: float, py: float) -> void:
		i = idx
		x = px
		y = py

## Triangulate flat array of coordinates with optional hole starting indices.
## Coordinates format: [x0, y0, x1, y1, ...]
## hole_indices format: [vertex_index_of_hole1, vertex_index_of_hole2, ...]
static func triangulate_flat(data: PackedFloat32Array, hole_indices: PackedInt32Array = PackedInt32Array(), dim: int = 2) -> PackedInt32Array:
	var nodes: Array[ENode] = []
	var has_holes = hole_indices.size() > 0
	var outer_len = hole_indices[0] * dim if has_holes else data.size()
	var outer_node = _linked_list(data, 0, outer_len, dim, true, nodes)
	var triangles = PackedInt32Array()
	
	if outer_node == null or outer_node.next == outer_node.prev:
		_cleanup_nodes(nodes)
		return triangles
		
	var min_x: float = 0.0
	var min_y: float = 0.0
	var max_x: float = 0.0
	var max_y: float = 0.0
	var inv_size: float = 0.0
	
	if has_holes:
		outer_node = _eliminate_holes(data, hole_indices, outer_node, dim, nodes)
		
	# If polygon is large (>80 vertices), use z-order curve indexing for performance
	if data.size() > 80 * dim:
		min_x = data[0]
		min_y = data[1]
		max_x = min_x
		max_y = min_y
		for i in range(dim, data.size(), dim):
			var x = data[i]
			var y = data[i + 1]
			if x < min_x: min_x = x
			if y < min_y: min_y = y
			if x > max_x: max_x = x
			if y > max_y: max_y = y
		inv_size = max(max_x - min_x, max_y - min_y)
		inv_size = 32767.0 / inv_size if inv_size != 0.0 else 0.0
		
	_earcut_linked(outer_node, triangles, dim, min_x, min_y, inv_size, 0, nodes)
	_cleanup_nodes(nodes)
	return triangles

## Triangulate 2D polygon with optional inner hole rings.
## Returns triangle indices referring to the points in (outer_points + hole_0_points + ...).
static func triangulate_polygon_2d(outer_ring: PackedVector2Array, inner_rings: Array = []) -> Dictionary:
	var points = PackedVector2Array()
	var flat_data = PackedFloat32Array()
	var hole_indices = PackedInt32Array()
	
	var outer_clean = _strip_closing_vertex_2d(outer_ring)
	for pt in outer_clean:
		points.append(pt)
		flat_data.append(pt.x)
		flat_data.append(pt.y)
		
	for inner in inner_rings:
		if inner is PackedVector2Array and inner.size() >= 3:
			var inner_clean = _strip_closing_vertex_2d(inner)
			if inner_clean.size() >= 3:
				hole_indices.append(points.size())
				for pt in inner_clean:
					points.append(pt)
					flat_data.append(pt.x)
					flat_data.append(pt.y)
					
	var indices = triangulate_flat(flat_data, hole_indices, 2)
	return {
		"points": points,
		"indices": indices
	}

## Triangulate 3D horizontal polygon (on XZ plane) with optional inner hole rings.
## Projects to 2D using (X, -Z).
## Returns Dictionary with combined "points" (PackedVector3Array) and "indices" (PackedInt32Array).
## Triangles are wound counter-clockwise so that their 3D surface normal faces strictly Up (0, 1, 0).
static func triangulate_polygon_3d(outer_ring: PackedVector3Array, inner_rings: Array = [], height_y: float = 0.0) -> Dictionary:
	var points_3d = PackedVector3Array()
	var flat_data = PackedFloat32Array()
	var hole_indices = PackedInt32Array()
	
	var outer_clean = _strip_closing_vertex_3d(outer_ring)
	for pt in outer_clean:
		points_3d.append(Vector3(pt.x, height_y, pt.z))
		flat_data.append(pt.x)
		flat_data.append(-pt.z) # -Z is North, corresponds to +Y in 2D
		
	for inner in inner_rings:
		if inner is PackedVector3Array and inner.size() >= 3:
			var inner_clean = _strip_closing_vertex_3d(inner)
			if inner_clean.size() >= 3:
				hole_indices.append(points_3d.size())
				for pt in inner_clean:
					points_3d.append(Vector3(pt.x, height_y, pt.z))
					flat_data.append(pt.x)
					flat_data.append(-pt.z)
					
	var indices = triangulate_flat(flat_data, hole_indices, 2)
	
	# Verify winding: ensure normal faces +Y
	# In Earcut, clockwise=true in linked_list produces CCW in Cartesian if sum>0 condition matches.
	# Let's check first triangle to confirm upward normal; if inverted, swap index 1 and 2.
	if indices.size() >= 3:
		var v0 = points_3d[indices[0]]
		var v1 = points_3d[indices[1]]
		var v2 = points_3d[indices[2]]
		var normal = (v1 - v0).cross(v2 - v0)
		if normal.y < 0.0:
			for t in range(0, indices.size(), 3):
				var tmp = indices[t + 1]
				indices[t + 1] = indices[t + 2]
				indices[t + 2] = tmp

	return {
		"points": points_3d,
		"indices": indices
	}

# --- Internal Earcut Algorithm ---

static func _strip_closing_vertex_2d(pts: PackedVector2Array) -> PackedVector2Array:
	var n = pts.size()
	if n >= 4 and pts[0].distance_squared_to(pts[n - 1]) < 0.0001:
		return pts.slice(0, n - 1)
	return pts

static func _strip_closing_vertex_3d(pts: PackedVector3Array) -> PackedVector3Array:
	var n = pts.size()
	if n >= 4 and pts[0].distance_squared_to(pts[n - 1]) < 0.0001:
		return pts.slice(0, n - 1)
	return pts

static func _cleanup_nodes(nodes: Array[ENode]) -> void:
	for n in nodes:
		n.prev = null
		n.next = null
		n.prevZ = null
		n.nextZ = null
	nodes.clear()

static func _linked_list(data: PackedFloat32Array, start: int, end: int, dim: int, clockwise: bool, nodes: Array[ENode]) -> ENode:
	var sum: float = 0.0
	var j: int = end - dim
	for i in range(start, end, dim):
		sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1])
		j = i
		
	var last: ENode = null
	if (sum > 0.0) == clockwise:
		for i in range(start, end, dim):
			last = _insert_node(i / dim, data[i], data[i + 1], last, nodes)
	else:
		for i in range(end - dim, start - dim, -dim):
			last = _insert_node(i / dim, data[i], data[i + 1], last, nodes)
			
	if last != null and _equals(last, last.next):
		_remove_node(last)
		last = last.next
		
	return last

static func _filter_points(start: ENode, end: ENode = null) -> ENode:
	if start == null:
		return start
	if end == null:
		end = start
		
	var p = start
	var again = true
	while again or p != end:
		again = false
		if not p.steiner and (_equals(p, p.next) or _area(p.prev, p, p.next) == 0.0):
			_remove_node(p)
			p = p.prev
			end = p
			if p == p.next:
				break
			again = true
		else:
			p = p.next
	return end

static func _earcut_linked(ear: ENode, triangles: PackedInt32Array, dim: int, min_x: float, min_y: float, inv_size: float, pass_num: int, nodes: Array[ENode]) -> void:
	if ear == null:
		return
		
	if pass_num == 0 and inv_size != 0.0:
		_index_curve(ear, min_x, min_y, inv_size)
		
	var stop = ear
	var prev: ENode
	var next: ENode
	
	while ear.prev != ear.next:
		prev = ear.prev
		next = ear.next
		
		var is_ear_valid = _is_ear_hashed(ear, min_x, min_y, inv_size) if inv_size != 0.0 else _is_ear(ear)
		if is_ear_valid:
			triangles.append(prev.i)
			triangles.append(ear.i)
			triangles.append(next.i)
			
			_remove_node(ear)
			ear = next.next
			stop = next.next
			continue
			
		ear = next
		if ear == stop:
			if pass_num == 0:
				_earcut_linked(_filter_points(ear), triangles, dim, min_x, min_y, inv_size, 1, nodes)
			elif pass_num == 1:
				ear = _cure_local_intersections(_filter_points(ear), triangles, dim)
				_earcut_linked(ear, triangles, dim, min_x, min_y, inv_size, 2, nodes)
			elif pass_num == 2:
				_split_earcut(ear, triangles, dim, min_x, min_y, inv_size, nodes)
			break

static func _is_ear(ear: ENode) -> bool:
	var a = ear.prev
	var b = ear
	var c = ear.next
	
	if _area(a, b, c) >= 0.0:
		return false
		
	var p = ear.next.next
	while p != ear.prev:
		if _point_in_triangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) and _area(p.prev, p, p.next) >= 0.0:
			return false
		p = p.next
	return true

static func _is_ear_hashed(ear: ENode, min_x: float, min_y: float, inv_size: float) -> bool:
	var a = ear.prev
	var b = ear
	var c = ear.next
	
	if _area(a, b, c) >= 0.0:
		return false
		
	var min_tx = min(a.x, min(b.x, c.x))
	var min_ty = min(a.y, min(b.y, c.y))
	var max_tx = max(a.x, max(b.x, c.x))
	var max_ty = max(a.y, max(b.y, c.y))
	
	var min_z = _z_order(min_tx, min_ty, min_x, min_y, inv_size)
	var max_z = _z_order(max_tx, max_ty, min_x, min_y, inv_size)
	
	var p = ear.prevZ
	var q = ear.nextZ
	
	while p != null and p.z >= min_z and q != null and q.z <= max_z:
		if p != ear.prev and p != ear.next and _point_in_triangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) and _area(p.prev, p, p.next) >= 0.0:
			return false
		p = p.prevZ
		
		if q != ear.prev and q != ear.next and _point_in_triangle(a.x, a.y, b.x, b.y, c.x, c.y, q.x, q.y) and _area(q.prev, q, q.next) >= 0.0:
			return false
		q = q.nextZ
		
	while p != null and p.z >= min_z:
		if p != ear.prev and p != ear.next and _point_in_triangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) and _area(p.prev, p, p.next) >= 0.0:
			return false
		p = p.prevZ
		
	while q != null and q.z <= max_z:
		if q != ear.prev and q != ear.next and _point_in_triangle(a.x, a.y, b.x, b.y, c.x, c.y, q.x, q.y) and _area(q.prev, q, q.next) >= 0.0:
			return false
		q = q.nextZ
		
	return true

static func _cure_local_intersections(start: ENode, triangles: PackedInt32Array, dim: int) -> ENode:
	var p = start
	var again = true
	while again or p != start:
		again = false
		var a = p.prev
		var b = p.next.next
		if not _equals(a, b) and _intersects(a, p, p.next, b) and _locally_inside(a, b) and _locally_inside(b, a):
			triangles.append(a.i)
			triangles.append(p.i)
			triangles.append(b.i)
			_remove_node(p)
			_remove_node(p.next)
			p = b
			start = b
			again = true
		else:
			p = p.next
	return _filter_points(p)

static func _split_earcut(start: ENode, triangles: PackedInt32Array, dim: int, min_x: float, min_y: float, inv_size: float, nodes: Array[ENode]) -> void:
	var a = start
	while true:
		var b = a.next.next
		while b != a.prev:
			if a.i != b.i and _is_valid_diagonal(a, b):
				var c = _split_polygon(a, b, nodes)
				a = _filter_points(a, a.next)
				c = _filter_points(c, c.next)
				_earcut_linked(a, triangles, dim, min_x, min_y, inv_size, 0, nodes)
				_earcut_linked(c, triangles, dim, min_x, min_y, inv_size, 0, nodes)
				return
			b = b.next
		a = a.next
		if a == start:
			break

static func _eliminate_holes(data: PackedFloat32Array, hole_indices: PackedInt32Array, outer_node: ENode, dim: int, nodes: Array[ENode]) -> ENode:
	var queue: Array[ENode] = []
	for i in range(hole_indices.size()):
		var start = hole_indices[i] * dim
		var end = hole_indices[i + 1] * dim if i < hole_indices.size() - 1 else data.size()
		var list = _linked_list(data, start, end, dim, false, nodes)
		if list != null:
			if list == list.next:
				list.steiner = true
			queue.append(_get_leftmost(list))
			
	queue.sort_custom(func(a: ENode, b: ENode) -> bool: return a.x < b.x)
	
	for hole in queue:
		outer_node = _eliminate_hole(hole, outer_node, nodes)
	return outer_node

static func _eliminate_hole(hole: ENode, outer_node: ENode, nodes: Array[ENode]) -> ENode:
	var bridge = _find_hole_bridge(hole, outer_node)
	if bridge == null:
		return outer_node
		
	var bridge_reverse = _split_polygon(bridge, hole, nodes)
	_filter_points(bridge_reverse, bridge_reverse.next)
	return _filter_points(bridge, bridge.next)

static func _find_hole_bridge(hole: ENode, outer_node: ENode) -> ENode:
	var p = outer_node
	var hx = hole.x
	var hy = hole.y
	var qx = -INF
	var m: ENode = null
	
	while true:
		if hy <= p.y and hy >= p.next.y and p.next.y != p.y:
			var x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y)
			if x <= hx and x > qx:
				qx = x
				m = p if p.x < p.next.x else p.next
				if x == hx:
					return m
		p = p.next
		if p == outer_node:
			break
			
	if m == null:
		return null
		
	var stop = m
	var mx = m.x
	var my = m.y
	var tan_min = INF
	
	p = m
	while true:
		if hx >= p.x and p.x >= mx and hx != p.x and \
		   _point_in_triangle(hx if hy < my else qx, hy, mx, my, qx if hy < my else hx, hy, p.x, p.y):
			var tan = abs(hy - p.y) / (hx - p.x)
			if _locally_inside(p, hole) and \
			   (tan < tan_min or (tan == tan_min and (p.x > m.x or (p.x == m.x and _sector_contains_sector(m, p))))):
				m = p
				tan_min = tan
		p = p.next
		if p == stop:
			break
			
	return m

static func _sector_contains_sector(m: ENode, p: ENode) -> bool:
	return _area(m.prev, m, p.prev) < 0.0 and _area(p.next, m, m.next) < 0.0

static func _index_curve(start: ENode, min_x: float, min_y: float, inv_size: float) -> void:
	var p = start
	while true:
		if p.z == 0:
			p.z = _z_order(p.x, p.y, min_x, min_y, inv_size)
		p.prevZ = p.prev
		p.nextZ = p.next
		p = p.next
		if p == start:
			break
			
	p.prevZ.nextZ = null
	p.prevZ = null
	_sort_linked(p)

static func _sort_linked(list: ENode) -> ENode:
	var in_size = 1
	var num_merges = 0
	var p: ENode
	var q: ENode
	var e: ENode
	var tail: ENode
	
	while true:
		p = list
		list = null
		tail = null
		num_merges = 0
		
		while p != null:
			num_merges += 1
			q = p
			var p_size = 0
			for i in range(in_size):
				p_size += 1
				q = q.nextZ
				if q == null:
					break
			var q_size = in_size
			
			while p_size > 0 or (q_size > 0 and q != null):
				if p_size == 0:
					e = q
					q = q.nextZ
					q_size -= 1
				elif q_size == 0 or q == null:
					e = p
					p = p.nextZ
					p_size -= 1
				elif p.z <= q.z:
					e = p
					p = p.nextZ
					p_size -= 1
				else:
					e = q
					q = q.nextZ
					q_size -= 1
					
				if tail != null:
					tail.nextZ = e
				else:
					list = e
				e.prevZ = tail
				tail = e
				
			p = q
			
		tail.nextZ = null
		in_size *= 2
		if num_merges <= 1:
			break
			
	return list

static func _z_order(x: float, y: float, min_x: float, min_y: float, inv_size: float) -> int:
	var lx = int((x - min_x) * inv_size)
	var ly = int((y - min_y) * inv_size)
	lx = (lx | (lx << 8)) & 0x00FF00FF
	lx = (lx | (lx << 4)) & 0x0F0F0F0F
	lx = (lx | (lx << 2)) & 0x33333333
	lx = (lx | (lx << 1)) & 0x55555555
	
	ly = (ly | (ly << 8)) & 0x00FF00FF
	ly = (ly | (ly << 4)) & 0x0F0F0F0F
	ly = (ly | (ly << 2)) & 0x33333333
	ly = (ly | (ly << 1)) & 0x55555555
	return lx | (ly << 1)

static func _get_leftmost(start: ENode) -> ENode:
	var p = start
	var leftmost = start
	while true:
		if p.x < leftmost.x or (p.x == leftmost.x and p.y < leftmost.y):
			leftmost = p
		p = p.next
		if p == start:
			break
	return leftmost

static func _point_in_triangle(ax: float, ay: float, bx: float, by: float, cx: float, cy: float, px: float, py: float) -> bool:
	return (cx - px) * (ay - py) >= (ax - px) * (cy - py) and \
		   (ax - px) * (by - py) >= (bx - px) * (ay - py) and \
		   (bx - px) * (cy - py) >= (cx - px) * (by - py)

static func _is_valid_diagonal(a: ENode, b: ENode) -> bool:
	return a.next.i != b.i and a.prev.i != b.i and not _intersects_polygon(a, b) and \
		   ((_locally_inside(a, b) and _locally_inside(b, a) and _middle_inside(a, b) and \
			(_area(a.prev, a, b.prev) != 0.0 or _area(a, b.prev, b) != 0.0)) or \
			(_equals(a, b) and _area(a.prev, a, a.next) > 0.0 and _area(b.prev, b, b.next) > 0.0))

static func _area(p: ENode, q: ENode, r: ENode) -> float:
	return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)

static func _equals(p1: ENode, p2: ENode) -> bool:
	return p1.x == p2.x and p1.y == p2.y

static func _intersects(p1: ENode, q1: ENode, p2: ENode, q2: ENode) -> bool:
	var o1 = sign(_area(p1, q1, p2))
	var o2 = sign(_area(p1, q1, q2))
	var o3 = sign(_area(p2, q2, p1))
	var o4 = sign(_area(p2, q2, q1))
	
	if o1 != o2 and o3 != o4:
		return true
	if o1 == 0 and _on_segment(p1, p2, q1): return true
	if o2 == 0 and _on_segment(p1, q2, q1): return true
	if o3 == 0 and _on_segment(p2, p1, q2): return true
	if o4 == 0 and _on_segment(p2, q1, q2): return true
	return false

static func _on_segment(p: ENode, q: ENode, r: ENode) -> bool:
	return q.x <= max(p.x, r.x) and q.x >= min(p.x, r.x) and q.y <= max(p.y, r.y) and q.y >= min(p.y, r.y)

static func _intersects_polygon(a: ENode, b: ENode) -> bool:
	var p = a
	while true:
		if p.i != a.i and p.next.i != a.i and p.i != b.i and p.next.i != b.i and _intersects(p, p.next, a, b):
			return true
		p = p.next
		if p == a:
			break
	return false

static func _locally_inside(a: ENode, b: ENode) -> bool:
	return _area(b, a, a.next) >= 0.0 and _area(a, b, a.prev) >= 0.0 if _area(a.prev, a, a.next) < 0.0 else \
		   _area(a, b, a.prev) < 0.0 or _area(b, a, a.next) < 0.0

static func _middle_inside(a: ENode, b: ENode) -> bool:
	var p = a
	var inside = false
	var px = (a.x + b.x) * 0.5
	var py = (a.y + b.y) * 0.5
	while true:
		if ((p.y > py) != (p.next.y > py)) and p.next.y != p.y and \
		   (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x):
			inside = not inside
		p = p.next
		if p == a:
			break
	return inside

static func _split_polygon(a: ENode, b: ENode, nodes: Array[ENode]) -> ENode:
	var a2 = ENode.new(a.i, a.x, a.y)
	var b2 = ENode.new(b.i, b.x, b.y)
	nodes.append(a2)
	nodes.append(b2)
	var an = a.next
	var bp = b.prev
	
	a.next = b
	b.prev = a
	
	a2.next = an
	an.prev = a2
	
	b2.next = a2
	a2.prev = b2
	
	bp.next = b2
	b2.prev = bp
	
	return b2

static func _insert_node(i: int, x: float, y: float, last: ENode, nodes: Array[ENode]) -> ENode:
	var p = ENode.new(i, x, y)
	nodes.append(p)
	if last == null:
		p.prev = p
		p.next = p
	else:
		p.next = last.next
		p.prev = last
		last.next.prev = p
		last.next = p
	return p

static func _remove_node(p: ENode) -> void:
	p.next.prev = p.prev
	p.prev.next = p.next
	if p.prevZ != null:
		p.prevZ.nextZ = p.nextZ
	if p.nextZ != null:
		p.nextZ.prevZ = p.prevZ
