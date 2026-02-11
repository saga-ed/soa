# Documentation Validation Scripts

This directory contains scripts for validating the hierarchical CLAUDE.md documentation system.

## Available Scripts

### validate_tokens.sh

Validates token budgets for all CLAUDE.md files in the repository.

**Usage:**
```bash
# Validate all CLAUDE.md files
./validate_tokens.sh

# Validate specific file
./validate_tokens.sh path/to/CLAUDE.md

# CI mode (no colors)
./validate_tokens.sh --ci
```

**Token Budget:**
- **Target:** ~500 tokens (375 words)
- **Strict Budget:** ≤800 tokens
- **Maximum:** ≤1000 tokens (hard limit)

**Exit Codes:**
- `0` - All files within budget
- `1` - One or more files exceed maximum budget

### validate_links.sh

Validates all internal markdown links in CLAUDE.md and SKILL.md files.

**Usage:**
```bash
./validate_links.sh
```

**Checks:**
- Relative file paths are correct
- Linked files exist
- Parent context links are valid
- Documentation links are not broken

**Exit Codes:**
- `0` - All links valid
- `1` - Broken links found

### validate_structure.sh

Validates adherence to hierarchical documentation standards.

**Usage:**
```bash
./validate_structure.sh
```

**Checks for CLAUDE.md:**
- Parent Context section (in non-root files)
- Required sections (Responsibilities, Tech Stack, Command Discovery)
- Documentation Directive
- Last Updated date
- Convention Deviations use warning markers

**Checks for SKILL.md:**
- YAML frontmatter with `name:` and `description:`
- No README.md alongside SKILL.md (progressive disclosure)

**Exit Codes:**
- `0` - All structure requirements met (warnings don't cause failure)
- `1` - Critical structure violations found

## Local Development

Run all validations before committing:

```bash
# Quick validation
.claude/skills/documentation-system/scripts/validate_tokens.sh
.claude/skills/documentation-system/scripts/validate_links.sh
.claude/skills/documentation-system/scripts/validate_structure.sh
```

## CI/CD Integration

For CI environments, use the `--ci` flag for cleaner output:

```bash
./validate_tokens.sh --ci
```

This disables color codes and provides output suitable for CI logs.

## Troubleshooting

### Token Budget Violations

If a file exceeds the token budget:

1. Extract detailed content to `docs/` directory
2. Use bullet points instead of paragraphs
3. Link to full documentation instead of duplicating
4. Show only 3-5 key commands, not all commands
5. Keep code examples concise

See: `guides/token-validation.md` for detailed refactoring guidance.

### Broken Links

Common issues:

- **Relative paths:** Ensure paths are relative to the current file
- **Parent context:** Should link to `../../CLAUDE.md` or similar
- **Case sensitivity:** File paths are case-sensitive on Linux
- **File existence:** Verify the file exists in git

### Structure Issues

Common fixes:

- Add Parent Context: `**Parent Context:** Part of [...](...)`
- Add Documentation Directive at end of file
- Add Last Updated: `*Target: ~500 tokens | Last updated: YYYY-MM-DD*`
- Use warning markers for Convention Deviations subsections
- Add YAML frontmatter to SKILL.md files

---

*See parent documentation: [documentation-system SKILL.md](../SKILL.md)*
