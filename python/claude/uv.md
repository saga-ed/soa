# Python Package Management with uv

This document defines the standard Python package management approach for all projects using [uv](https://github.com/astral-sh/uv).

## Why uv?

- **Fast**: 10-100x faster than pip and pip-tools
- **Reliable**: Proper dependency resolution with lockfiles
- **Modern**: Built in Rust, designed for production use
- **Compatible**: Drop-in replacement for pip, pip-tools, and virtualenv
- **Unified**: Single tool for all Python package management needs

## Installation

```bash
# Install uv globally (one-time setup)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or via pip (if needed)
pip install uv
```

## Project Structure

Every Python project must have:

```
project/
├── pyproject.toml       # Project metadata and dependencies
├── uv.lock              # Locked dependency versions (committed to git)
├── .python-version      # Python version specification (optional)
└── src/                 # Source code
```

## Core Commands

### Project Initialization

```bash
# Create new project
uv init

# Or initialize in existing directory
uv init --name myproject

# Specify Python version
uv init --python 3.12
```

### Dependency Management

```bash
# Add a dependency
uv add requests

# Add development dependency
uv add --dev pytest

# Add optional dependency group
uv add --group docs sphinx

# Remove dependency
uv remove requests

# Update dependencies
uv lock --upgrade

# Update specific package
uv lock --upgrade-package requests
```

### Virtual Environments

```bash
# Create virtual environment (automatic with uv run/sync)
uv venv

# Activate manually if needed
source .venv/bin/activate  # Unix
.venv\Scripts\activate     # Windows

# Sync environment with lockfile
uv sync

# Sync including dev dependencies
uv sync --all-extras
```

### Running Code

```bash
# Run Python script (auto-creates/syncs venv)
uv run python script.py

# Run module
uv run -m pytest

# Run with specific Python version
uv run --python 3.12 python script.py
```

## pyproject.toml Structure

```toml
[project]
name = "myproject"
version = "0.1.0"
description = "Project description"
requires-python = ">=3.11"
dependencies = [
    "requests>=2.31.0",
    "pydantic>=2.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "ruff>=0.1.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.uv]
dev-dependencies = [
    "pytest>=8.0.0",
    "ruff>=0.1.0",
]
```

## Best Practices

### 1. Always Use Lockfiles

- Commit `uv.lock` to version control
- Lock files ensure reproducible installations
- Run `uv lock` after changing dependencies

### 2. Specify Version Constraints

```toml
# Good: Allows compatible updates
dependencies = ["requests>=2.31.0,<3"]

# Better: Use uv add which handles this
# uv add "requests>=2.31.0,<3"

# Best: Let uv manage it
# uv add requests  # Adds latest with compatible range
```

### 3. Use uv run Instead of Manual Activation

```bash
# Old way (avoid)
source .venv/bin/activate
python script.py

# New way (preferred)
uv run python script.py
```

### 4. Separate Dev Dependencies

```toml
[tool.uv]
dev-dependencies = [
    "pytest>=8.0.0",
    "ruff>=0.1.0",
    "mypy>=1.8.0",
]
```

### 5. Python Version Management

```bash
# Install Python version via uv
uv python install 3.12

# Pin project Python version
echo "3.12" > .python-version

# Use in pyproject.toml
[project]
requires-python = ">=3.11,<4"
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: Set up Python
  uses: actions/setup-python@v5
  with:
    python-version: '3.12'

- name: Install uv
  run: curl -LsSf https://astral.sh/uv/install.sh | sh

- name: Install dependencies
  run: uv sync

- name: Run tests
  run: uv run pytest
```

### Docker

```dockerfile
FROM python:3.12-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN uv sync --frozen --no-dev

# Copy source code
COPY src/ src/

# Run application
CMD ["uv", "run", "python", "-m", "myproject"]
```

## Migration from Other Tools

### From pip + requirements.txt

```bash
# Import requirements.txt
uv add -r requirements.txt

# Or manually migrate
uv add package1 package2 package3
```

### From Poetry

```bash
# Convert poetry dependencies to pyproject.toml
# Then run:
uv lock
uv sync
```

### From pip-tools

```bash
# Similar to requirements.txt migration
uv add -r requirements.in
uv lock
```

## Common Workflows

### Starting a New Project

```bash
uv init myproject
cd myproject
uv add pydantic fastapi
uv add --dev pytest ruff mypy
uv run python -m pytest
```

### Working on Existing Project

```bash
git clone <repo>
cd <repo>
uv sync  # Installs from lockfile
uv run pytest
```

### Updating Dependencies

```bash
# Update all dependencies
uv lock --upgrade

# Update specific package
uv lock --upgrade-package requests

# Review changes
git diff uv.lock

# Test and commit
uv run pytest
git add pyproject.toml uv.lock
git commit -m "chore: update dependencies"
```

## Troubleshooting

### Cache Issues

```bash
# Clear uv cache
uv cache clean
```

### Lockfile Out of Sync

```bash
# Regenerate lockfile
uv lock

# Force sync environment
uv sync --reinstall
```

### Python Version Issues

```bash
# List available Python versions
uv python list

# Install specific version
uv python install 3.12

# Use specific version
uv run --python 3.12 python script.py
```

## Additional Resources

- [uv Documentation](https://docs.astral.sh/uv/)
- [uv GitHub](https://github.com/astral-sh/uv)
- [PEP 621](https://peps.python.org/pep-0621/) - Project metadata standard
