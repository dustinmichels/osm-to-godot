#!/usr/bin/env python3
"""
Fetch Overture Maps data (buildings, transportation/roads) for a bounding box
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


def fetch_type(bbox: list[float], feature_type: str, temp_dir: Path) -> dict:
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
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Warning: overturemaps download failed for {feature_type}: {result.stderr}", file=sys.stderr)
        return {"type": "FeatureCollection", "features": []}

    if not out_file.exists():
        return {"type": "FeatureCollection", "features": []}

    try:
        with open(out_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading {out_file}: {e}", file=sys.stderr)
        return {"type": "FeatureCollection", "features": []}


def main():
    parser = argparse.ArgumentParser(description="Fetch Overture Maps buildings and roads as GeoJSON.")
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
        default="building,segment",
        help="Comma-separated feature types to fetch (default: building,segment)",
    )

    args = parser.parse_args()

    try:
        bbox = parse_bbox(args.bbox)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    types = [t.strip() for t in args.types.split(",") if t.strip()]
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        all_features = []
        counts = {}

        for ftype in types:
            data = fetch_type(bbox, ftype, tmp_dir)
            feats = data.get("features", [])
            counts[ftype] = len(feats)
            for feat in feats:
                if "overture_type" not in feat:
                    feat["overture_type"] = ftype
                all_features.append(feat)

        centroid_lon = (bbox[0] + bbox[2]) * 0.5
        centroid_lat = (bbox[1] + bbox[3]) * 0.5

        combined_geojson = {
            "type": "FeatureCollection",
            "metadata": {
                "source": "Overture Maps Foundation",
                "bbox": bbox,
                "centroid": {"lon": centroid_lon, "lat": centroid_lat},
                "counts": counts,
                "total_features": len(all_features),
            },
            "features": all_features,
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(combined_geojson, f, indent=2)

    print(f"\nSuccessfully generated GeoJSON export: {output_path}")
    print(f"Features: {counts} (Total: {len(all_features)})")

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
