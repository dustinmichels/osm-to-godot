# Character Model Attribution & License

The human character model, skeleton rig, and locomotion animations included in this directory are based on the work of **Quaternius** (https://quaternius.com / https://patreon.com/quaternius).

## License: CC0 1.0 Universal (Public Domain Dedication)

- Free for personal, educational, and commercial use.
- No attribution strictly required, but warmly credited here.
- Sourced via Mesh2Motion open asset archive.

## Included Files:

- `human_character.blend`: Blender 3D source file containing the humanoid armature (66 bones), mannequin mesh, and rigged locomotion actions.
- `human_character.glb`: glTF 2.0 binary asset with packed materials, skeleton, and animations (Idle_A, Walk, Jog, Sprint, Jump_Start, Jump_air, Jump_Land, Crouch, Dance, etc.).
- `character.gd`: CharacterBody3D player exploration controller for Godot 4.
- `character.tscn`: Reusable player scene with collision capsule, SpringArm3D third-person camera rig, and exploration HUD.
- `textures/color-palette.png`: Texture atlas for character materials.
