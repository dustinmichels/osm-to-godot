#!/usr/bin/env python3
"""
Fetch Overture Maps data (buildings, transportation/roads, places/POIs) for a bounding box
and export a clean GeoJSON FeatureCollection for Godot ingestion.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def parse_bbox(bbox_str: str) -> list[float]:
    parts = [float(p.strip()) for p in bbox_str.split(",")]
    if len(parts) != 4:
        raise ValueError("Bounding box must have 4 coordinates: min_lon,min_lat,max_lon,max_lat")
    min_lon, min_lat, max_lon, max_lat = parts
    if min_lon > max_lon:
        min_lon, max_lon = max_lon, min_lon
    if min_lat > max_lat:
        min_lat, max_lat = max_lat, min_lat
    return [min_lon, min_lat, max_lon, max_lat]


def fetch_type(bbox: list[float], feature_type: str, temp_dir: Path) -> tuple[dict, str | None]:
    bbox_str = f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}"
    out_file = temp_dir / f"{feature_type}.geojson"

    cmd = [
        "uvx",
        "overturemaps",
        "download",
        f"--bbox={bbox_str}",
        "-f",
        "geojson",
        "-t",
        feature_type,
        "-o",
        str(out_file),
    ]

    print(f"Fetching Overture '{feature_type}' features for bbox [{bbox_str}]...")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            err_msg = result.stderr.strip() or f"Download failed with exit code {result.returncode}"
            print(f"Warning: overturemaps download failed for {feature_type}: {err_msg}", file=sys.stderr)
            return {"type": "FeatureCollection", "features": []}, err_msg
    except Exception as e:
        err_msg = str(e)
        print(f"Warning: overturemaps execution failed for {feature_type}: {err_msg}", file=sys.stderr)
        return {"type": "FeatureCollection", "features": []}, err_msg

    if not out_file.exists():
        err_msg = f"Output file not generated for {feature_type}"
        return {"type": "FeatureCollection", "features": []}, err_msg

    try:
        with open(out_file, "r", encoding="utf-8") as f:
            return json.load(f), None
    except Exception as e:
        err_msg = f"Error loading {out_file}: {e}"
        print(err_msg, file=sys.stderr)
        return {"type": "FeatureCollection", "features": []}, err_msg

def point_in_polygon(x: float, y: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    if n < 3:
        return False
    p1x, p1y = ring[0]
    for i in range(1, n + 1):
        p2x, p2y = ring[i % n]
        if y > min(p1y, p2y):
            if y <= max(p1y, p2y):
                if x <= max(p1x, p2x):
                    if p1y != p2y:
                        xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or x <= xinters:
                        inside = not inside
        p1x, p1y = p2x, p2y
    return inside


def point_in_feature_geom(x: float, y: float, geom: dict) -> bool:
    gtype = geom.get("type")
    coords = geom.get("coordinates", [])
    if gtype == "Polygon" and coords:
        if not point_in_polygon(x, y, coords[0]):
            return False
        for hole in coords[1:]:
            if point_in_polygon(x, y, hole):
                return False
        return True
    elif gtype == "MultiPolygon" and coords:
        for poly_coords in coords:
            if poly_coords and point_in_polygon(x, y, poly_coords[0]):
                in_hole = any(point_in_polygon(x, y, hole) for hole in poly_coords[1:])
                if not in_hole:
                    return True
        return False
    return False


def extract_poi_name(props: dict) -> str:
    names = props.get("names")
    if isinstance(names, dict):
        prim = names.get("primary")
        if prim and str(prim).strip() and str(prim).strip() != "<null>":
            return str(prim).strip()
        comm = names.get("common")
        if comm and str(comm).strip() and str(comm).strip() != "<null>":
            return str(comm).strip()
    if props.get("name") and str(props["name"]).strip() and str(props["name"]).strip() != "<null>":
        return str(props["name"]).strip()
    if props.get("name:en") and str(props["name:en"]).strip() and str(props["name:en"]).strip() != "<null>":
        return str(props["name:en"]).strip()
    brand = props.get("brand")
    if isinstance(brand, dict):
        bnames = brand.get("names")
        if isinstance(bnames, dict):
            bprim = bnames.get("primary") or bnames.get("common")
            if bprim and str(bprim).strip() and str(bprim).strip() != "<null>":
                return str(bprim).strip()
    elif brand and isinstance(brand, str) and brand.strip() and brand.strip() != "<null>":
        return brand.strip()
    return ""

def extract_address_str(props: dict) -> str:
    num = str(props.get("number", "")).strip()
    st = str(props.get("street", "")).strip().title()
    if num and st:
        return f"{num} {st}"
    elif st:
        return st
    return ""


def main():
    parser = argparse.ArgumentParser(description="Fetch Overture Maps buildings, roads, and POIs as GeoJSON.")
    parser.add_argument(
        "--bbox",
        "-b",
        required=True,
        help="Bounding box in 'min_lon,min_lat,max_lon,max_lat' (WGS84 degrees)",
    )
    parser.add_argument(
        "--output",
        "-o",
        default="godot_project/data/overture_export.geojson",
        help="Path to write the combined GeoJSON file (default: godot_project/data/overture_export.geojson)",
    )
    parser.add_argument(
        "--types",
        "-t",
        default="building,segment,place,address",
        help="Comma-separated feature types to fetch (default: building,segment,place,address)",
    )
    parser.add_argument(
        "--include-pois",
        "--include-poi",
        dest="include_pois",
        action="store_true",
        default=True,
        help="Try to fetch POI data (place) for building labeling (default: True)",
    )
    parser.add_argument(
        "--no-pois",
        "--no-poi",
        dest="include_pois",
        action="store_false",
        help="Skip fetching POI data",
    )
    parser.add_argument(
        "--include-addresses",
        "--include-address",
        dest="include_addresses",
        action="store_true",
        default=True,
        help="Try to fetch address data for building address labeling (default: True)",
    )
    parser.add_argument(
        "--no-addresses",
        "--no-address",
        dest="include_addresses",
        action="store_false",
        help="Skip fetching address data",
    )

    args = parser.parse_args()

    try:
        bbox = parse_bbox(args.bbox)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    if args.include_pois and "place" not in types:
        types.append("place")
    elif not args.include_pois and "place" in types:
        types.remove("place")
    if args.include_addresses and "address" not in types:
        types.append("address")
    elif not args.include_addresses and "address" in types:
        types.remove("address")
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        all_features = []
        counts = {}
        theme_status = {}
        failed_themes = []
        errors = {}

        for ftype in types:
            data, err = fetch_type(bbox, ftype, tmp_dir)
            if err is not None:
                counts[ftype] = 0
                theme_status[ftype] = {
                    "status": "failed",
                    "error": err,
                    "count": 0,
                }
                failed_themes.append(ftype)
                errors[ftype] = err
            else:
                feats = data.get("features", [])
                cnt = len(feats)
                counts[ftype] = cnt
                theme_status[ftype] = {
                    "status": "empty" if cnt == 0 else "success",
                    "count": cnt,
                }
                for feat in feats:
                    if "overture_type" not in feat:
                        feat["overture_type"] = ftype
                    all_features.append(feat)

        standard_themes = ["building", "segment", "place", "address"]
        missing_themes = [st for st in standard_themes if st not in types]
        for st in missing_themes:
            theme_status[st] = {
                "status": "missing",
                "count": 0,
                "note": f"Theme '{st}' was not requested",
            }
        # Correlate POI (place) and address data with buildings so buildings are labeled correctly
        places = [
            f for f in all_features
            if f.get("overture_type") == "place" and f.get("geometry", {}).get("type") == "Point"
        ]
        addresses = [
            f for f in all_features
            if f.get("overture_type") == "address" and f.get("geometry", {}).get("type") == "Point"
        ]
        buildings = [
            f for f in all_features
            if f.get("overture_type") == "building"
            and f.get("geometry", {}).get("type") in ["Polygon", "MultiPolygon"]
        ]

        labeled_buildings_count = 0
        if buildings and (places or addresses):
            for b in buildings:
                b_props = b.setdefault("properties", {})
                b_geom = b.get("geometry", {})
                b_pois = []
                b_poi_names = []
                for p in places:
                    p_coords = p.get("geometry", {}).get("coordinates", [])
                    if len(p_coords) >= 2 and point_in_feature_geom(p_coords[0], p_coords[1], b_geom):
                        p_name = extract_poi_name(p.get("properties", {}))
                        if p_name:
                            b_poi_names.append(p_name)
                        b_pois.append({
                            "id": p.get("id"),
                            "name": p_name,
                            "properties": p.get("properties"),
                        })

                b_addresses = []
                for a in addresses:
                    a_coords = a.get("geometry", {}).get("coordinates", [])
                    if len(a_coords) >= 2 and point_in_feature_geom(a_coords[0], a_coords[1], b_geom):
                        a_props = a.get("properties", {})
                        a_str = extract_address_str(a_props)
                        if a_str:
                            b_addresses.append({
                                "id": a.get("id"),
                                "number": a_props.get("number"),
                                "street": a_props.get("street"),
                                "full": a_str,
                            })

                if b_poi_names:
                    b_props["pois"] = b_pois
                    b_props["poi_names"] = b_poi_names

                if b_addresses:
                    b_props["matched_addresses"] = b_addresses
                    if "addresses" not in b_props or not b_props["addresses"]:
                        b_props["addresses"] = [{
                            "freeform": b_addresses[0]["full"],
                            "locality": "Medford",
                        }]

                curr_name = extract_poi_name(b_props)
                if not curr_name:
                    chosen_name = ""
                    if b_poi_names:
                        chosen_name = b_poi_names[0]
                    elif b_addresses:
                        chosen_name = b_addresses[0]["full"]

                    if chosen_name:
                        b_props["name"] = chosen_name
                        if "names" not in b_props or not isinstance(b_props["names"], dict):
                            b_props["names"] = {}
                        b_props["names"]["primary"] = chosen_name
                        labeled_buildings_count += 1
        centroid_lon = (bbox[0] + bbox[2]) * 0.5
        centroid_lat = (bbox[1] + bbox[3]) * 0.5

        combined_geojson = {
            "type": "FeatureCollection",
            "metadata": {
                "source": "Overture Maps Foundation",
                "bbox": bbox,
                "centroid": {"lon": centroid_lon, "lat": centroid_lat},
                "counts": counts,
                "theme_status": theme_status,
                "failed_themes": failed_themes,
                "missing_themes": missing_themes,
                "errors": errors,
                "total_features": len(all_features),
                "labeled_buildings": labeled_buildings_count,
            },
            "features": all_features,
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(combined_geojson, f, indent=2)

    print(f"\nSuccessfully generated GeoJSON export: {output_path}")
    print(f"Features: {counts} (Total: {len(all_features)})")
    if labeled_buildings_count > 0:
        print(f"Buildings labeled from POIs: {labeled_buildings_count}/{len(buildings)}")
    if failed_themes:
        print(
            f"\nWarning: Partial download failure occurred for themes: {', '.join(failed_themes)}",
            file=sys.stderr,
        )
        for ft in failed_themes:
            print(f"  - {ft}: {errors.get(ft)}", file=sys.stderr)
        if len(all_features) == 0:
            print(
                "Error: All requested Overture themes failed to download and no features were acquired.",
                file=sys.stderr,
            )
            sys.exit(1)
    # Optional DuckDB summary if installed
    duckdb_bin = shutil.which("duckdb")
    if duckdb_bin and output_path.exists():
        try:
            summary_query = f"""
            INSTALL spatial; LOAD spatial;
            SELECT 
                ST_GeometryType(geom) AS geometry_type,
                count(*) AS count
            FROM ST_Read('{output_path}')
            GROUP BY 1
            ORDER BY 2 DESC;
            """
            print("\nDuckDB Spatial Verification:")
            res = subprocess.run([duckdb_bin, "-c", summary_query], capture_output=True, text=True)
            if res.returncode == 0:
                print(res.stdout.strip())
        except Exception:
            pass


if __name__ == "__main__":
    main()
