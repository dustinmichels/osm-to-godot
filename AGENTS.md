## Testing Rules

Do not write milestone, synthetic, or trivial tests.

- **No phase/milestone scripts**: Never add one-off `test_phase*.gd` files to `godot_project/`.
- **No synthetic/tautological tests**: No headless mock input injection, no render image dumps, no dummy local socket servers.
- **No mutating assets**: Tests must never overwrite repo files (e.g. `city_viewer.tscn`).
- **Engine testing via fixtures**: Add realistic OSM JSON or GeoJSON to `tests/fixtures/` and register in `FIXTURES` in `godot_project/test_importer_headless.gd`.
- **Web tests**: Pure-logic unit tests only (`web/src/**/*.test.ts`).

## Commands

- **Godot**: `mise run test` (runs `test_importer_headless.gd` and `test_player_character.gd`)
- **Web**: `mise run test-web` (`cd web && bun test`)

## Conventions

- Run `mise run fmt` periodically
