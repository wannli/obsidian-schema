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
- Arrays define array type; multi-value arrays define array enums.
- `default.<field>` defines autofill default values (for missing fields).
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

## Run On Save In Obsidian

Yes, Obsidian can run JS on save via a plugin. This repo includes a minimal desktop plugin scaffold:

- `/Users/wannli/Code/obsidian-typing/obsidian-plugin/schema-fix-on-save/manifest.json`
- `/Users/wannli/Code/obsidian-typing/obsidian-plugin/schema-fix-on-save/main.js`

Install it in your vault:

1. Copy `obsidian-plugin/schema-fix-on-save` to `~/notes/.obsidian/plugins/schema-fix-on-save`.
2. Enable the plugin in Obsidian community plugins.
3. In plugin settings, confirm paths for `node`, `cli.mjs`, and report dir.

Behavior:

- Watches markdown file `modify` events.
- Debounces runs to avoid repeated invocations while typing.
- Skips excluded folders (`Attachments`, `Schemas`, `Templates` by default).
- Runs `schema fix` in the background.

## Mobile-Compatible Plugin

For Obsidian mobile (no Node subprocess), this repo also includes:

- `/Users/wannli/Code/obsidian-typing/obsidian-plugin/mobile-schema-typer/manifest.json`
- `/Users/wannli/Code/obsidian-typing/obsidian-plugin/mobile-schema-typer/main.js`

Behavior:

- Loads schemas from `Schemas/*.md` in-vault.
- Applies schema fixes on markdown changes.
- Adds missing required fields (blank/default).
- Infers `type` from schema folder mappings when missing.
- Prepends `YYYY-MM-DD ` to note title when schema has `prependDateToTitle: true`.
- Moves notes to schema `folder`.
- Overrides folder to `Archive` when `status` is `done`, `superseded`, or `cancelled`.

Install:

1. Copy `mobile-schema-typer` into `<vault>/.obsidian/plugins/mobile-schema-typer`.
2. Enable the plugin in Community Plugins.
3. Optionally configure debounce/exclusions/folders in plugin settings.

## Default Starter Schemas

`schema init-schemas` copies a minimal starter set from `schemas/default/`:

- `daily`
- `meeting`
- `project`
- `subject`
- `source`
- `entity`

These are examples only; the source of truth is always your vault `Schemas/` folder.
