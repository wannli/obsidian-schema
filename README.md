# Obsidian Typer

Local CLI and Obsidian plugin for schema-based typing, autofix, folder routing, and backlink maintenance in an Obsidian vault.

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

CLI command roles:

- `init-schemas` copies starter schemas into the vault.
- `check` validates notes against schemas and reports issues without changing files.
- `fix --dry-run` previews autofix results without writing changes.
- `fix` applies schema fixes, routing, normalization, and config sync.

## Schema Format

Schemas are markdown files in your vault at `Schemas/*.md`, using Obsidian frontmatter properties. The schema type is inferred from the schema filename.

```md
---
extends: [[log]]
folder: /Meetings
purpose: Meeting notes
field.date*:
field.attendees: []
field.status: active,draft,paused,done,superseded,cancelled
default.attendees: []
prependDateToTitle: true
---
```

Rules:

- The schema filename is the schema type source of truth. For example, `Schemas/delegate.md` defines type `delegate`.
- `type` inside schema frontmatter is optional legacy metadata. If present and it disagrees with the filename, the plugin warns and uses the filename-derived type.
- `extends` inherits another schema and uses a simple wikilink (`[[entity]]`).
- `folder` is the canonical folder for that type.
- `field.<name>*` marks required fields (example: `field.date*:`).
- Scalar values with commas define string enums.
- Arrays define array type; multi-value arrays define array enums.
- `default.<field>` defines autofill default values (for missing fields).
- `pair.<field>` defines directional inverse sync as `<targetType>.<targetField>` (example: `pair.employer: entity.employees`).
- `linkPair.<id>` is still accepted as a legacy alias (`left<->right`) for backward compatibility.
- `purpose` is human-readable schema intent.

### Bidirectional Link Pairs

Use `pair.*` to keep related fields in sync across notes and types.

```md
---
type: colleague
extends: [[entity]]
field.employer:
pair.employer: entity.employees
---
```

```md
---
type: entity
field.employees: []
pair.employees: colleague.employer
---
```

Behavior:

- Sync is symmetric: either side can add the missing inverse link.
- Sync is conservative for non-managed values: conflicting scalar values are left untouched and reported.
- Managed inverse links can be reconciled on each run: stale links in the configured inverse field are removed when they are no longer implied by current source links, if backlink pruning is enabled.
- Link resolution uses Obsidian's native link resolution rules rather than basename-only matching.

## What `fix` Does

The CLI `fix` command can:

- Add missing required keys.
- Apply defaults when defined.
- Preserve optional placeholder fields so they can be filled incrementally later.
- Validate enums/types and write issue notes when needed.
- Normalize common fields (`tags`, `aliases`, `parent`, `children`, `attendees`).
- Normalize wikilink-like fields into consistent wikilink form where applicable.
- Infer `type` from folder when possible.
- Resolve schema inheritance chains.
- Move notes to their schema `folder` when applicable.
- Apply override routing: `status in {done,superseded,cancelled} -> /Archive`.
- Prepend `YYYY-MM-DD ` to filename when `prependDateToTitle: true` and `date` exists.
- Sync inverse/backlink pair fields according to `pair.*` and legacy `linkPair.*` rules.
- Sync `.obsidian/plugins/auto-note-mover/data.json` to match schema folder rules.
- Regenerate observability artifacts from current schemas.
- Emit machine-readable reports into `reports/`.

## Scope/Exclusions

Vault scanning excludes:

- `Attachments/`
- `Schemas/`
- `Templates/`
- `.obsidian/`
- `.base` files

## Centralized Runner

For centralized, out-of-Obsidian execution, run the CLI on your Mac (manually or via `launchd`):

```bash
node /Users/wannli/Code/obsidian-typing/src/cli.mjs fix --vault /Users/wannli/notes --report-dir /Users/wannli/Code/obsidian-typing/reports
```

## Auto Note Mover Integration

Auto Note Mover integration is part of the CLI workflow, not the mobile plugin runtime.

What it does:

- derives folder-routing rules from your schemas
- writes or updates `.obsidian/plugins/auto-note-mover/data.json`
- keeps Auto Note Mover aligned with schema folder targets

What it does not do:

- the mobile plugin does not call Auto Note Mover directly
- the mobile plugin moves notes itself using Obsidian file APIs

## Mobile-Compatible Plugin

For Obsidian mobile (no Node subprocess), this repo also includes:

- `/Users/wannli/Code/obsidian-typing/obsidian-plugin/mobile-schema-typer/manifest.json`
- `/Users/wannli/Code/obsidian-typing/obsidian-plugin/mobile-schema-typer/main.js`

Behavior:

- Loads schemas from `Schemas/*.md` in-vault.
- Normalizes schema type lookup to avoid case-sensitivity mismatches.
- Resolves schema inheritance chains.
- Applies schema fixes on markdown changes when `Run on modify` is enabled.
- Also responds to create, rename, and delete events for markdown files.
- Adds missing required fields (blank/default).
- Preserves optional placeholder fields once present.
- Infers `type` from schema folder mappings when missing.
- Checks exact folder matches first, then ancestor folder matches.
- Applies schema after note edits and manual command runs.
- Prepends `YYYY-MM-DD ` to note title when schema has `prependDateToTitle: true` and a usable `date` exists.
- Moves notes to schema `folder`.
- Overrides folder to `Archive` when `status` is `done`, `superseded`, or `cancelled`.
- Uses metadata-cache frontmatter reads for better Obsidian compatibility.
- Refreshes schema cache when schema notes are modified, created, renamed, or deleted.
- Uses targeted runs for changed files and full runs for explicit/manual or schema-wide refresh cases.
- Resolves backlink targets with Obsidian link APIs.
- Writes inverse links using vault-relative wikilinks.
- Avoids duplicate inverse links.
- Leaves conflicting scalar inverse links untouched and records a warning.
- Can reconcile managed inverse backlinks when backlink pruning is enabled.
- Tracks warnings during runs and shows a summary notice for manual commands.
- Supports manual commands for full run, current file, backlink rebuild, and preview.
- Validates and normalizes plugin settings before save/use.

Install:

1. Copy `mobile-schema-typer` into `<vault>/.obsidian/plugins/mobile-schema-typer`.
2. Enable the plugin in Community Plugins.
3. Configure settings as needed:
   - `Enabled`
   - `Run on modify`
   - `Debounce (ms)`
   - `Schemas folder`
   - `Excluded folders`
   - `Archive folder`
   - `Enable date prefix rename`
   - `Verbose logging`
   - `Prune managed backlinks`
4. Use the command palette for:
   - `Run schema fix now`
   - `Run schema fix on current file`
   - `Rebuild backlinks now`
   - `Preview schema fix summary`

Notes:

- changing `type` and then saving should trigger schema application if `Run on modify` is enabled
- schema application is post-modify, not true pre-save interception
- pruning inverse backlinks is opt-in and off by default for safety
- excluded folders and `.obsidian/` are ignored during scans

## Testing

Automated tests:

```bash
cd ~/code/obsidian-typing
npm test
```

Current automated coverage includes helper logic for:

- schema parsing
- link parsing and normalization
- inverse backlink add/prune helpers
- type normalization and inheritance checks
- date prefix extraction
- run statistics helpers

Recommended manual plugin checks in a disposable vault:

- change `type` on a note and save to confirm schema application
- create a note in a schema-mapped folder to confirm type inference
- mark a note `done` to confirm archive routing
- create a backlink pair and run `Rebuild backlinks now`
- enable backlink pruning and verify stale managed inverse links are removed

## Default Starter Schemas

`schema init-schemas` copies a minimal starter set from `schemas/default/`:

- `daily`
- `meeting`
- `project`
- `subject`
- `source`
- `entity`
- `colleague` (includes `pair.employer: entity.employees`)

These are examples only; the source of truth is always your vault `Schemas/` folder.
