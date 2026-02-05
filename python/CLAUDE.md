# Python Development Standards

Shared Python development standards and conventions for all @saga-ed/soa projects.

## Package Management

**CRITICAL**: All Python projects MUST use `uv` for package management.

**See**: [claude/uv.md](claude/uv.md) for complete uv conventions and workflows.

## Quick Reference

```bash
# Initialize new project
uv init

# Add dependency
uv add package-name

# Add dev dependency
uv add --dev pytest

# Sync environment
uv sync

# Run code
uv run python script.py

# Run tests
uv run pytest
```

## Required Files

Every Python project must have:

- `pyproject.toml` - Project metadata and dependencies
- `uv.lock` - Locked dependencies (committed to git)
- `.python-version` - Python version specification (optional but recommended)

## Python Version

- **Minimum**: Python 3.11
- **Recommended**: Python 3.12+
- Specify in `pyproject.toml`:

```toml
[project]
requires-python = ">=3.11"
```

## Project Structure

```
project/
├── pyproject.toml       # Project config and dependencies
├── uv.lock              # Dependency lockfile
├── .python-version      # Python version (e.g., "3.12")
├── README.md
├── src/
│   └── package/
│       ├── __init__.py
│       └── module.py
├── tests/
│   └── test_module.py
└── .gitignore
```

## Development Dependencies

Standard dev dependencies for all projects:

```bash
uv add --dev pytest pytest-cov ruff mypy
```

## Context Loading Instructions

**When starting ANY Python task**, Claude MUST:
1. Read this file for Python-specific conventions
2. Read [claude/uv.md](claude/uv.md) for package management details
3. Follow uv-based workflows for all dependency operations

## Additional Standards

Additional Python conventions (testing, linting, type checking, etc.) may be documented in sibling files within this directory as the ecosystem matures.
