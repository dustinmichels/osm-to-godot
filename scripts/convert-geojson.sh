#!/usr/bin/env bash
set -euo pipefail

# Determine repository root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${REPO_ROOT}/data"
OUTPUT_FILE="${2:-${OUTPUT_DIR}/map.geojson}"

normalize_path() {
  local p="$1"

  # Strip leading and trailing whitespace
  p="$(echo "$p" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  # Strip file:// prefix if present
  if [[ "$p" =~ ^file:// ]]; then
    p="${p#file://}"
    p="${p//%20/ }"
  fi

  # Strip surrounding single quotes
  if [[ "$p" =~ ^\'(.*)\'$ ]]; then
    p="${BASH_REMATCH[1]}"
  # Strip surrounding double quotes
  elif [[ "$p" =~ ^\"(.*)\"$ ]]; then
    p="${BASH_REMATCH[1]}"
  fi

  # Trim whitespace again
  p="$(echo "$p" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  # Expand tilde ~ to $HOME
  if [[ "$p" == "~"* ]]; then
    p="${HOME}${p#\~}"
  fi

  # If file exists as-is, return it
  if [[ -e "$p" ]]; then
    echo "$p"
    return 0
  fi

  # If not found, try unescaping backslashes (macOS unquoted drag-and-drop: osm_export\(1\).json or spaces)
  local unescaped="${p//\\/}"
  if [[ -e "$unescaped" ]]; then
    echo "$unescaped"
    return 0
  fi

  # Return path for error reporting
  echo "$p"
}

# 1. Get raw input path (either from argument or interactive drag-and-drop prompt)
if [[ $# -ge 1 && -n "$1" ]]; then
  raw_input="$1"
else
  printf "Drag and drop OSM JSON file here: "
  read -r raw_input
fi

if [[ -z "$raw_input" ]]; then
  echo "Error: No input file provided." >&2
  exit 1
fi

# 2. Normalize path
input_file="$(normalize_path "$raw_input")"

if [[ ! -f "$input_file" ]]; then
  echo "Error: File not found: $input_file" >&2
  exit 1
fi

# 3. Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "Converting: $input_file"
echo "Exporting to: $OUTPUT_FILE"

# 4. Run bunx osmtogeojson
if bunx osmtogeojson "$input_file" > "$OUTPUT_FILE"; then
  echo "Done! GeoJSON saved to $OUTPUT_FILE"
else
  rm -f "$OUTPUT_FILE"
  echo "Error: Conversion failed." >&2
  exit 1
fi
