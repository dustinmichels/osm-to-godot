# OSM-to-Godot

## Goal

Create a tool where user can select an area on the map, using a bounding box. I'm thinking of web-based: maplibre, OSM, search for area, draw bounding box...

Then when box is drawn user can press "download streets and buildings" and download the OSM for that cropepd region.

Then, I want a script that deterministically imports the streets and buildings into Godot for visualization. This includes the positions of the streets of buildings, also width of street, surface type, if there is a bike lane, height of buildings.

I think the bounding box part may require web technologies but the rest could be a native app. Go, Rust, Python?
