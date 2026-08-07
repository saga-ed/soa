# Python Development Standards

Shared Python development standards and conventions for all @saga-ed/soa projects.
No projects exist under `python/` yet — this is the convention to apply when one is added.

- Use `uv` for package management, not pip. See [claude/uv.md](claude/uv.md) for conventions and workflows.
- Minimum Python 3.11, recommended 3.12+.
- Standard dev dependencies: `uv add --dev pytest pytest-cov ruff mypy`.
