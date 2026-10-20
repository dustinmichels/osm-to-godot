class_name OSMProjection
extends RefCounted

const EARTH_RADIUS: float = 6378137.0 # WGS84 equatorial radius in meters

var origin_lat_deg: float = 0.0
var origin_lon_deg: float = 0.0
var origin_lat_rad: float = 0.0
var origin_lon_rad: float = 0.0
var cos_lat0: float = 1.0

func _init(lat_deg: float = 0.0, lon_deg: float = 0.0) -> void:
	set_origin(lat_deg, lon_deg)

func set_origin(lat_deg: float, lon_deg: float) -> void:
	origin_lat_deg = lat_deg
	origin_lon_deg = lon_deg
	origin_lat_rad = deg_to_rad(lat_deg)
	origin_lon_rad = deg_to_rad(lon_deg)
	cos_lat0 = cos(origin_lat_rad)

func set_origin_from_bbox(south: float, west: float, north: float, east: float) -> void:
	var center_lat = (south + north) * 0.5
	var center_lon = (west + east) * 0.5
	set_origin(center_lat, center_lon)

## Projects WGS84 (lat, lon) in degrees to Godot 3D space:
## +X = East, +Y = Up (meters), -Z = North
func project(lat: float, lon: float, elevation: float = 0.0) -> Vector3:
	var d_lon_rad = deg_to_rad(lon - origin_lon_deg)
	var d_lat_rad = deg_to_rad(lat - origin_lat_deg)
	var x = EARTH_RADIUS * d_lon_rad * cos_lat0
	var z = -EARTH_RADIUS * d_lat_rad
	return Vector3(x, elevation, z)

## Alias for project()
func project_wgs84_to_local(lat: float, lon: float, elevation: float = 0.0) -> Vector3:
	return project(lat, lon, elevation)

## Projects WGS84 (lat, lon) to 2D local tangent plane:
## x = East (meters), y = North (meters)
func project_2d(lat: float, lon: float) -> Vector2:
	var d_lon_rad = deg_to_rad(lon - origin_lon_deg)
	var d_lat_rad = deg_to_rad(lat - origin_lat_deg)
	var x = EARTH_RADIUS * d_lon_rad * cos_lat0
	var y = EARTH_RADIUS * d_lat_rad
	return Vector2(x, y)

## Unprojects Godot Vector3 back to WGS84 (lat, lon) degrees
func unproject(pos: Vector3) -> Dictionary:
	var d_lat_rad = -pos.z / EARTH_RADIUS
	var d_lon_rad = pos.x / (EARTH_RADIUS * cos_lat0) if abs(cos_lat0) > 1e-12 else 0.0
	var lat = origin_lat_deg + rad_to_deg(d_lat_rad)
	var lon = origin_lon_deg + rad_to_deg(d_lon_rad)
	return { "lat": lat, "lon": lon }
