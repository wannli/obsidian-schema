# Inline `#type` Expansion Plan

## Goal

Convert shorthand like:

```md
- Jane Doe #delegate
- Security Council #organ
- Informal consultations #meeting
```

into markdown links to notes that are created or reused and then processed through the existing schema pipeline.

Example result:

```md
- [[People/Jane Doe]]
- [[Entities/Security Council]]
- [[Meetings/2026-04-06 Informal consultations]]
```

The created or reused note must be handled by the existing schema logic so it receives:

- the correct `type`
- required/default fields
- schema-defined folder placement
- schema-driven rename behavior
- backlink processing where applicable

---

## Product Decision

### Initial scope

Implement this first as a **manual command** for the **current file only**.

Reason:
- avoids accidental conversion of ordinary hashtags
- keeps rollout safe and testable
- reuses existing schema machinery without changing normal save behavior yet

### Parsing scope

Phase 1 should process **list items only**, including:

- unordered lists: `- Title #type`
- ordered lists: `1. Title #type`
- task lists: `- [ ] Title #type`

Do **not** process arbitrary prose in Phase 1.

---

## Desired Behavior

Given a line like:

```md
- Jane Doe #delegate
```

The command should:

1. detect `Jane Doe` as the title and `delegate` as the schema type
2. confirm `delegate` is a loaded schema
3. find or create a note for that title/type
4. set at least minimal frontmatter with `type: delegate` if creating a new note
5. run the standard schema processing pipeline on that note
6. obtain the note's final path after any schema-driven move/rename
7. replace the original list content with a wikilink

Result:

```md
- [[People/Jane Doe]]
```

---

## Non-Goals for Phase 1

- automatic conversion during ordinary note saves
- arbitrary paragraph/prose hashtag parsing
- fuzzy duplicate matching
- silently retagging existing notes with conflicting types
- batch conversion across the whole vault

---

## Architecture

### Core principle

Reuse the existing schema engine.

Do not build a separate note-generation path beyond the minimum needed to bootstrap a note with a `type`.

### High-level flow

1. Read active note
2. Parse body for inline `#type` list-item candidates
3. For each candidate:
   - resolve schema
   - create or reuse target note
   - run schema application on that note
   - get final file/path
   - generate wikilink
4. Rewrite the active note body with replacements
5. Save the active note
6. Show a summary notice

---

## Proposed Implementation

### 1. Add a new command

In `obsidian-plugin/mobile-schema-typer/main.js`:

- add command: `Expand inline #type entries in current file`

Suggested command id:
- `mobile-schema-typer-expand-inline-types-current-file`

Behavior:
- requires an active markdown file
- ensures schemas are fresh
- expands list-item shorthand in the active file
- shows summary counts for created/reused/skipped/replaced

---

### 2. Candidate parsing

Add helper:

```js
function findInlineTypeCandidates(text, knownTypes)
```

Phase 1 should only match whole list lines. OR also trigger [[Jane Doe #delegate]] in the same way.

Candidate line forms:

```md
- Jane Doe #delegate
- [ ] Jane Doe #delegate
1. Jane Doe #delegate
```

Captured parts:
- line prefix (`- `, `- [ ] `, `1. `)
- title text (`Jane Doe`)
- type token (`delegate`)

Validation:
- normalized type matches a loaded schema id
- title is non-empty
- line does not already contain a wikilink

Return shape could be:

```js
[
  {
    lineStart,
    lineEnd,
    lineText,
    prefix,
    title,
    type,
    normalizedType
  }
]
```

---

### 3. Create or resolve a typed note

Add helper:

```js
async ensureTypedNoteForTitle(title, type)
```

Responsibilities:

1. Look up schema by type
2. Determine preferred folder from schema
3. Search for an existing note with exact basename match
4. If found:
   - inspect frontmatter/type if needed
   - if compatible, reuse it
   - if conflicting, skip with warning
5. If not found:
   - create a new note with minimal frontmatter:

```yaml
---
type: delegate
---
```

6. Run normal schema processing on the note
7. Return the final `TFile`

### Reuse rules

Recommended Phase 1 behavior:
- prefer exact basename match in schema folder
- if exact basename exists with same type, reuse it
- if exact basename exists with different type, skip and warn
- do not attempt fuzzy matching

---

### 4. Make schema application return the final file

The current schema application path may move or rename a file.

For this feature, link insertion must use the **final** path.

Refactor as needed so the note-processing path returns the final file reference.

Suggested shape:

```js
const finalFile = await this.applySchemaToFile(file);
```

If rename/move occurs, `finalFile` should point to the updated file.

This is especially important for schemas such as `meeting` that may prepend a date and move files into schema folders.

---

### 5. Replace source text with links

Add helper:

```js
function applyInlineTypeReplacements(text, replacements)
```

Each replacement should preserve the original list prefix and replace only the `Title #type` segment.

Examples:

```md
- Jane Doe #delegate
=>
- [[People/Jane Doe]]
```

```md
- [ ] Jane Doe #delegate
=>
- [ ] [[People/Jane Doe]]
```

The wikilink should be generated using the existing vault-relative link helper so the final path is correct.

---

## Data / Conflict Rules

### Existing note with same title and same type
- reuse
- process through schema pipeline if needed
- replace shorthand with link

### Existing note with same title and conflicting type
- do not mutate it automatically
- skip replacement for that line
- record a warning

### Schema not found
- skip
- record warning if useful

### Invalid or empty title
- skip

### Already linked line
- skip

---

## Suggested Helpers

In `obsidian-plugin/mobile-schema-typer/main.js`:

- `findInlineTypeCandidates(text, knownTypes)`
- `applyInlineTypeReplacements(text, replacements)`
- `sanitizeNoteTitle(title)`
- `async ensureTypedNoteForTitle(title, type)`
- `async createTypedNote(title, type)`
- optional: `async findExistingTypedNote(title, type)`

---

## Command Flow Pseudocode

```js
async expandInlineTypesInFile(file) {
  await this.ensureSchemasFresh();

  const original = await this.app.vault.cachedRead(file);
  const candidates = findInlineTypeCandidates(original, new Set(this.schemas.keys()));
  if (candidates.length === 0) return summary;

  const replacements = [];
  const cache = new Map();

  for (const candidate of candidates) {
    const key = `${candidate.normalizedType}::${candidate.title}`;
    let target = cache.get(key);
    if (!target) {
      target = await this.ensureTypedNoteForTitle(candidate.title, candidate.normalizedType);
      cache.set(key, target);
    }
    if (!target) continue;

    replacements.push({
      lineStart: candidate.lineStart,
      lineEnd: candidate.lineEnd,
      newLine: `${candidate.prefix}${buildWikiLinkToFile(target)}`
    });
  }

  const next = applyInlineTypeReplacements(original, replacements);
  if (next !== original) await this.app.vault.modify(file, next);

  return summary;
}
```

---

## Testing Plan

Add tests for:

### Parsing
- unordered list candidates
- ordered list candidates
- task list candidates
- skip prose hashtags
- skip unknown schema types
- skip lines already containing wikilinks

### Note creation / reuse
- creates note with minimal type frontmatter
- applies schema after creation
- reuses existing note of same type
- skips conflicting note of different type

### Replacement
- preserves list marker
- preserves checkbox syntax
- inserts wikilink using final file path

### Integration
- command transforms current note body
- created note ends up in schema folder
- created note gets schema-required/default fields
- rename/move after schema application is reflected in inserted link

---

## Edge Cases

- duplicate shorthand entries in one note should resolve to the same created/reused target
- title sanitization must handle illegal path characters
- schema-defined rename may change inserted link target after creation
- links should use final post-processing file path, not initial draft path
- future auto-on-save mode should remain opt-in to avoid surprising users

---

## Future Extensions

### Phase 2
- preview command for current file
- richer conflict reporting
- optional support for plain paragraph lines

### Phase 3
- optional auto-convert on modify
- support aliases or title templates
- batch expansion across selected files or vault

---

## Recommended First Milestone

Implement only this:

1. command for current file
2. list-item parsing only
3. exact title/type matching only
4. create-or-reuse note
5. schema-process created note
6. replace source list items with wikilinks
7. tests for parsing and integration

This gives a safe, useful feature without destabilizing the existing save pipeline.
