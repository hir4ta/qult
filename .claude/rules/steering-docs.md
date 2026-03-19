# Steering Docs

- Steering docs: `.alfred/steering/` (3 files: product.md, structure.md, tech.md)
- Pure filesystem (no DB storage, read on demand)
- `/alfred:init`: multi-agent project exploration → steering docs + templates + knowledge sync (preferred entry point)
- `alfred steering-init`: legacy CLI (redirects to /alfred:init), still functional with `--force`
- Dossier init: injects `steering_context` (summary) or `steering_hint` (suggestion) in response JSON
- Dossier update: accepts `file=steering/{filename}` for steering doc updates
- ValidateSteering: checks tech.md vs package.json drift, structure.md vs filesystem directory existence
- Templates: steering doc templates are currently not implemented (planned: file-based templates under `src/spec/templates/`)
