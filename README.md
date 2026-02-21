# Obsidian Typer

Local CLI for schema-based typing, autofix, and folder routing in an Obsidian vault.

## Install

```bash
npm install
npm link
```

This exposes the `schema` command.

## Commands

```bash
schema init-schemas --vault ~/notes
schema check --vault ~/notes
schema fix --vault ~/notes --dry-run
schema fix --vault ~/notes
```

Reports are written to `./reports/schema-<mode>-report.json`.

## Schema Format

Schemas are markdown files in your vault at `Schemas/*.md`, using Obsidian frontmatter properties.

```md
---
type: meeting
extends: log
folder: /Meetings
purpose: Meeting notes
date*:
attendees: []
status: active,draft,paused,done,superseded,cancelled
prependDateToTitle: true
---
```

Rules:

- `type` identifies the schema.
- `extends` inherits another schema.
- `folder` is the canonical folder for that type.
- `field*` syntax marks required fields (example: `date*:`).
- Scalar values with commas define string enums.
- Arrays define defaults; multi-value arrays define array enums.
- `purpose` is human-readable schema intent.

## What `fix` Does

- Adds missing required keys (blank if no default).
- Applies defaults when defined.
- Validates enums/types and writes issue notes when needed.
- Normalizes common fields (`tags`, `aliases`, `parent`, `children`, `attendees`).
- Infers `type` from folder when possible.
- Moves notes to their schema `folder` when applicable.
- Applies override routing: `status in {done,superseded,cancelled} -> /Archive`.
- Prepends `YYYY-MM-DD ` to filename when `prependDateToTitle: true` and `date` exists.
- Syncs `.obsidian/plugins/auto-note-mover/data.json` to match schema folder rules.
- Regenerates observability artifacts from current schemas.

## Scope/Exclusions

Vault scanning excludes:

- `Attachments/`
- `Schemas/`
- `Templates/`
- `.obsidian/`
- `.base` files

## Default Starter Schemas

`schema init-schemas` copies a minimal starter set from `schemas/default/`:

- `daily`
- `meeting`
- `project`
- `subject`
- `source`
- `entity`

These are examples only; the source of truth is always your vault `Schemas/` folder.
