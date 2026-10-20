# Testing Rules

Do not write milestone, synthetic, or trivial tests.

- **No phase/milestone scripts**: Never add one-off `test_phase*.gd` files to `godot_project/`.
- **No synthetic/tautological tests**: No headless mock input injection, no render image dumps, no dummy local socket servers.
- **No mutating assets**: Tests must never overwrite repo files (e.g. `city_viewer.tscn`).
- **Engine testing via fixtures**: Add realistic OSM JSON to `tests/fixtures/` and register in `FIXTURES` in `godot_project/test_importer_headless.gd`.
- **Web tests**: Pure-logic unit tests only (`web/src/composables/*.test.ts`).

## Commands
- **Godot**: `mise run test` (`godot --headless --path godot_project -s res://test_importer_headless.gd`)
- **Web**: `mise run test-web` (`cd web && bun test`)
