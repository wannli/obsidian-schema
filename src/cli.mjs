#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const FOLDER_TYPE_MAP = {
  Dailies: 'daily',
  Meetings: 'meeting',
  Projects: 'project',
  Entities: 'entity',
  Subjects: 'subject',
  Sources: 'source',
  Readwise: 'source',
  Logs: 'log'
};

const LEGACY_TYPE_MAP = {
  'entity-person': 'person',
  'entity-body': 'body',
  'entity-group': 'group',
  'entity-place': 'place',
  'entity-country': 'country',
  'entity-session': 'session',
  'source-article': 'article',
  'source-book': 'book',
  'source-paper': 'paper',
  'source-report': 'report',
  location: 'place',
  note: null,
  none: null
};

const LEGACY_SUBTYPE_MAP = {
  location: 'place'
};
const TERMINAL_STATUSES = new Set(['done', 'superseded', 'cancelled']);

const PREFERRED_KEY_ORDER = [
  'type',
  'schema_notes',
  'tags',
  'status',
  'date',
  'created',
  'modified',
  'aliases',
  'title',
  'parent',
  'children'
];

const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  '.obsidian',
  'Attachments',
  'Archive/.trash',
  'Schemas'
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'check';

  if (!['check', 'fix', 'init-schemas'].includes(command)) {
    usage(1);
    return;
  }

  const vault = expandHome(args.vault || '~/notes');
  const schemasDir = args.schemas ? expandHome(args.schemas) : path.join(vault, 'Schemas');
  const reportDir = args['report-dir'] ? expandHome(args['report-dir']) : path.join(process.cwd(), 'reports');

  if (command === 'init-schemas') {
    await initSchemas(schemasDir, { force: Boolean(args.force) });
    await syncSchemaTypeKeyConvention(schemasDir);
    const schemaResult = await loadSchemas(schemasDir);
    await syncOntologySummary({ vault, schemas: schemaResult.schemas });
    await syncAutoNoteMoverConfig({ vault, schemas: schemaResult.schemas });
    console.log(`Initialized schema notes in ${schemasDir}`);
    return;
  }

  const mode = command === 'fix' ? 'fix' : 'check';
  const write = mode === 'fix' && !args['dry-run'];

  await syncSchemaTypeKeyConvention(schemasDir);
  const schemaResult = await loadSchemas(schemasDir);
  const schemas = schemaResult.schemas;

  if (schemas.length === 0) {
    console.error(`No schema notes found in ${schemasDir}. Run: schema init-schemas --vault ${vault}`);
    process.exit(1);
  }

  await syncObservabilityBase({ vault, schemas });
  await syncOntologySummary({ vault, schemas });
  const autoNoteMoverSync = await syncAutoNoteMoverConfig({ vault, schemas });

  const files = await listMarkdownFiles(vault);
  const report = {
    timestamp: new Date().toISOString(),
    mode,
    write,
    vault,
    schemasDir,
    schemaErrors: schemaResult.errors,
    autoNoteMoverSync,
    filesScanned: files.length,
    fixedCount: 0,
    violationCount: 0,
    skippedAmbiguousCount: 0,
    files: []
  };

  for (const file of files) {
    const result = await processFile({ file, vault, schemas, mode, write });
    report.files.push(result);
  }
  await applyBidirectionalLinkPass({ vault, schemas, report, mode, write });
  recomputeReportCounters(report);

  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `schema-${mode}-report.json`);
  const schemaIssuePagesSync = await syncSchemaIssuePages({ vault, schemas, report });
  report.schemaIssuePagesSync = schemaIssuePagesSync;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  printSummary(report, reportPath, schemaResult.warnings);

  if (mode === 'check' && report.violationCount > 0) {
    process.exit(1);
  }

  if (mode === 'fix' && write && report.violationCount > 0) {
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }

    const key = token.slice(2);
    if (['dry-run'].includes(key)) {
      out[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      out[key] = true;
      continue;
    }

    out[key] = value;
    i += 1;
  }
  return out;
}

function usage(exitCode = 0) {
  console.log(`Usage:
  schema check --vault ~/notes [--schemas ~/notes/Schemas]
  schema fix --vault ~/notes [--dry-run]
  schema init-schemas --vault ~/notes
`);
  process.exit(exitCode);
}

function recomputeReportCounters(report) {
  report.fixedCount = report.files.reduce((count, file) => count + (file.fixes.length > 0 ? 1 : 0), 0);
  report.violationCount = report.files.reduce((count, file) => count + file.violations.length, 0);
  report.skippedAmbiguousCount = report.files.reduce((count, file) => count + file.ambiguous.length, 0);
}

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function initSchemas(schemasDir, options = {}) {
  const sourceDir = path.join(process.cwd(), 'schemas', 'default');
  const files = await fs.readdir(sourceDir);
  await fs.mkdir(schemasDir, { recursive: true });

  for (const file of files) {
    const source = path.join(sourceDir, file);
    const target = path.join(schemasDir, file);

    try {
      await fs.access(target);
      if (options.force) {
        await fs.copyFile(source, target);
      }
    } catch {
      await fs.copyFile(source, target);
    }
  }
}

async function syncSchemaTypeKeyConvention(schemasDir) {
  let files = [];
  try {
    files = await fs.readdir(schemasDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.md') || file.startsWith('_')) continue;
    const fullPath = path.join(schemasDir, file);
    let text = '';
    try {
      text = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    const normalized = text
      .replace(/^(\s*field\.type)\*:/m, '$1:')
      .replace(/^(\s*type)\*:/m, '$1:')
      .replace(/^(\s*)field\.type:/m, '$1type:')
      .replace(/^(\s*extends:\s*)(.+)\s*$/gm, (_full, prefix, raw) => {
        const normalized = normalizeExtendsValue(raw);
        return `${prefix}${normalized}`;
      });
    const parsed = parseMarkdownWithFrontmatter(normalized);
    let next = normalized;
    if (parsed.hasFrontmatter) {
      const ordered = orderSchemaFrontmatter(parsed.frontmatter || {});
      const fmText = serializeFrontmatter(ordered);
      const body = parsed.body.startsWith('\n') ? parsed.body.slice(1) : parsed.body;
      next = `---\n${fmText}\n---\n${body}`;
    }
    if (next !== text) {
      await fs.writeFile(fullPath, next, 'utf8');
    }
  }
}

function orderSchemaFrontmatter(frontmatter) {
  const out = {};
  const topOrder = ['type', 'purpose', 'folder'];
  const schemaMetaKeys = new Set(['id', 'type', 'purpose', 'folder', 'extends', 'appliesTo', 'prependDateToTitle', 'notes']);
  const inputKeys = new Set(Object.keys(frontmatter));
  for (const key of topOrder) {
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      out[key] = frontmatter[key];
    }
  }

  const fieldEntries = [];
  const defaultEntries = [];
  const pairEntries = [];
  const restEntries = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (topOrder.includes(key)) continue;
    if (key.startsWith('field.')) {
      fieldEntries.push({ key, value, name: normalizeSchemaFieldName(key, 'field.') });
      continue;
    }
    if (key.startsWith('default.')) {
      defaultEntries.push({ key, value, name: normalizeSchemaFieldName(key, 'default.') });
      continue;
    }
    if (key.startsWith('pair.')) {
      pairEntries.push({ key, value, name: normalizeSchemaFieldName(key, 'pair.') });
      continue;
    }
    const canonicalFieldKey = canonicalizeImplicitFieldKey(key, schemaMetaKeys);
    if (canonicalFieldKey) {
      if (!inputKeys.has(canonicalFieldKey) || canonicalFieldKey === key) {
        fieldEntries.push({
          key: canonicalFieldKey,
          value,
          name: normalizeSchemaFieldName(canonicalFieldKey, 'field.')
        });
      }
      continue;
    }
    restEntries.push({ key, value });
  }

  const names = new Set([
    ...fieldEntries.map((x) => x.name),
    ...defaultEntries.map((x) => x.name),
    ...pairEntries.map((x) => x.name)
  ]);
  const orderedNames = [...names].sort((a, b) => a.localeCompare(b));

  for (const name of orderedNames) {
    for (const item of fieldEntries.filter((x) => x.name === name).sort((a, b) => a.key.localeCompare(b.key))) {
      out[item.key] = item.value;
    }
    for (const item of defaultEntries.filter((x) => x.name === name).sort((a, b) => a.key.localeCompare(b.key))) {
      out[item.key] = item.value;
    }
    for (const item of pairEntries.filter((x) => x.name === name).sort((a, b) => a.key.localeCompare(b.key))) {
      out[item.key] = item.value;
    }
  }

  for (const item of restEntries.sort((a, b) => a.key.localeCompare(b.key))) {
    out[item.key] = item.value;
  }

  return out;
}

function normalizeSchemaFieldName(key, prefix) {
  let name = key.slice(prefix.length);
  if (name.endsWith('*')) name = name.slice(0, -1);
  return name;
}

function canonicalizeImplicitFieldKey(key, schemaMetaKeys) {
  if (key.includes('.')) return null;
  const required = key.endsWith('*');
  const base = required ? key.slice(0, -1) : key;
  if (!base || schemaMetaKeys.has(base)) return null;
  return `field.${base}${required ? '*' : ''}`;
}

function normalizeExtendsValue(raw) {
  let trimmed = String(raw || '').trim();
  if (!trimmed || /^null$/i.test(trimmed)) return trimmed || 'null';

  // Strip one layer of YAML quotes.
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // Collapse accidental single-item list syntax encoded inline.
  let m = trimmed.match(/^\[\s*\[\[([^\]|#]+)\]\]\s*\]$/);
  if (m) return `[[${m[1].trim()}]]`;

  // Canonical wikilink form.
  m = trimmed.match(/^\[\[([^\]|#]+)\]\]$/);
  if (m) return `[[${m[1].trim()}]]`;

  // Fallback: bare token -> wikilink.
  return `[[${trimmed}]]`;
}

async function syncObservabilityBase({ vault, schemas }) {
  const basePath = path.join(vault, 'Schema.base');
  const legacyBasePath = path.join(vault, 'Schema Observability.base');
  const typeSchemas = schemas
    .filter((s) => s.discriminator === 'type')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const lines = [];
  lines.push('formulas:');
  lines.push('  has_type: type != null');
  lines.push('  has_status: status != null');
  lines.push('  has_date: date != null');
  lines.push('properties:');
  lines.push('  formula.has_type:');
  lines.push('    displayName: Has Type');
  lines.push('  formula.has_status:');
  lines.push('    displayName: Has Status');
  lines.push('  formula.has_date:');
  lines.push('    displayName: Has Date');
  lines.push('views:');
  lines.push('  - type: table');
  lines.push('    name: "Schema Issues"');
  lines.push('    filters:');
  lines.push('      and:');
  pushBasePathExclusions(lines, '        ');
  lines.push('        - or:');
  lines.push('            - type == null');
  lines.push('            - type == ""');
  lines.push('            - and:');
  lines.push('                - schema_notes != null');
  lines.push('                - schema_notes != ""');

  for (const schema of typeSchemas) {
    const req = [...new Set((schema.required || []).filter((k) => k !== 'type'))];
    if (req.length === 0) continue;
    lines.push('            - and:');
    lines.push(`                - type == ${yamlString(String(schema.id))}`);
    lines.push('                - or:');
    for (const field of req) {
      lines.push(`                    - ${field} == null`);
      lines.push(`                    - ${field} == ""`);
    }
  }
  lines.push('    order:');
  lines.push('      - file.name');
  lines.push('      - type');
  lines.push('      - schema_notes');
  lines.push('      - status');
  lines.push('      - date');

  lines.push('  - type: table');
  lines.push('    name: "No Type"');
  lines.push('    filters:');
  lines.push('      and:');
  pushBasePathExclusions(lines, '        ');
  lines.push('        - type == null');
  lines.push('    order:');
  lines.push('      - file.name');
  lines.push('      - type');
  lines.push('      - tags');

  for (const schema of typeSchemas) {
    const req = [...new Set((schema.required || []).filter((k) => k !== 'type'))];
    if (req.length === 0) continue;

    lines.push('  - type: table');
    lines.push(`    name: ${yamlString(`${toTitleCase(String(schema.id))} Missing Required`)}`);
    lines.push('    filters:');
    lines.push('      and:');
    pushBasePathExclusions(lines, '        ');
    lines.push(`        - type == ${yamlString(String(schema.id))}`);
    lines.push('        - or:');
    for (const field of req) {
      lines.push(`            - ${field} == null`);
      lines.push(`            - ${field} == ""`);
    }
    lines.push('    order:');
    lines.push('      - file.name');
    for (const field of req) {
      lines.push(`      - ${field}`);
    }
  }

  await fs.writeFile(basePath, `${lines.join('\n')}\n`, 'utf8');
  try {
    await fs.unlink(legacyBasePath);
  } catch {
    // no-op
  }
}

function pushBasePathExclusions(lines, indent) {
  lines.push(`${indent}- file.path.startsWith("Attachments/") == false`);
  lines.push(`${indent}- file.path.startsWith("Schemas/") == false`);
  lines.push(`${indent}- file.path.startsWith("Templates/") == false`);
  lines.push(`${indent}- file.path.endsWith(".base") == false`);
  lines.push(`${indent}- file.path != "Schema.base"`);
  lines.push(`${indent}- file.name != "Schema"`);
  lines.push(`${indent}- file.name != "Schema.base"`);
}

async function syncOntologySummary({ vault, schemas }) {
  const ontologyPath = path.join(vault, 'ONTOLOGY.md');
  const typeSchemas = schemas
    .filter((s) => s.discriminator === 'type')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const signature = computeSchemaSignature(typeSchemas);
  const existing = await readFileIfExists(ontologyPath);
  if (existing && existing.includes(`schema_signature:${signature}`)) {
    return;
  }

  const lines = [];
  lines.push('---');
  lines.push('type: note');
  lines.push('---');
  lines.push('# Ontology');
  lines.push('');
  lines.push('| Type | Purpose | Inherits From | Required Fields | Typical Folder |');
  lines.push('|---|---|---|---|---|');

  for (const schema of typeSchemas) {
    const typeName = String(schema.id);
    const purpose = schema.purpose ? String(schema.purpose) : derivePurpose(typeName, schema.extends);
    const inherits = schema.extends ? String(schema.extends) : '-';
    const required = [...new Set(['type', ...((schema.required || []).filter((k) => k !== 'type'))])];
    const requiredCell = required.join(', ');
    const folder = typeof schema.folder === 'string' ? schema.folder : null;
    const folderCell = folder === '' ? 'Root (`/`)' : folder ? `\`${folder}/\`` : '-';
    lines.push(
      `| \`${escapePipes(typeName)}\` | ${escapePipes(purpose)} | ${escapePipes(inherits)} | ${escapePipes(requiredCell)} | ${escapePipes(folderCell)} |`
    );
  }

  lines.push('');
  lines.push('Common `status` values (where used): `active`, `draft`, `paused`, `done`, `superseded`, `cancelled`.');
  lines.push('');
  lines.push(`<!-- schema_signature:${signature} -->`);
  lines.push('');

  await fs.writeFile(ontologyPath, `${lines.join('\n')}`, 'utf8');
}

async function syncSchemaIssuePages({ vault, schemas, report }) {
  const status = { updated: 0, schemaCount: 0, issueCount: 0, warning: null };
  const today = formatLocalDate(new Date());
  const dailyLink = `Dailies/${today}`;
  const bySchema = new Map();
  const schemaFiles = new Map();

  for (const schema of schemas || []) {
    if (schema.discriminator !== 'type') continue;
    if (!schema.__file) continue;
    schemaFiles.set(String(schema.id), schema.__file);
  }
  status.schemaCount = schemaFiles.size;

  for (const file of report.files || []) {
    const schemaTag = (file.schema || []).find((x) => String(x).startsWith('type:'));
    if (!schemaTag) continue;
    const typeId = String(schemaTag).slice('type:'.length);
    if (!schemaFiles.has(typeId)) continue;

    const messages = [];
    if ((file.ambiguous || []).length > 0) {
      for (const a of file.ambiguous || []) messages.push(a);
    } else {
      for (const v of file.violations || []) messages.push(v.message);
    }
    if (messages.length === 0) continue;

    const uniq = [...new Set(messages)];
    const rows = bySchema.get(typeId) || [];
    rows.push({ rel: file.relativePath, messages: uniq });
    bySchema.set(typeId, rows);
    status.issueCount += 1;
  }

  try {
    for (const [typeId, schemaPath] of schemaFiles.entries()) {
      const issueRows = bySchema.get(typeId) || [];
      const existingText = (await readFileIfExists(schemaPath)) || '';
      const withBlock = issueRows.length > 0
        ? upsertManagedBlock(existingText, 'schema-issues', buildSchemaIssuesBlock({ issueRows, dailyLink }))
        : removeManagedBlock(existingText, 'schema-issues');
      const nextText = removeSchemaIssueFrontmatterFields(withBlock);
      if (nextText !== existingText) {
        await fs.writeFile(schemaPath, nextText, 'utf8');
        status.updated += 1;
      }
    }
    await clearTodayDailySchemaIssuesBlock(vault);
  } catch (error) {
    status.warning = `Failed to sync schema issue pages: ${error.message}`;
  }

  return status;
}

function buildSchemaIssuesBlock({ issueRows, dailyLink }) {
  const lines = [];
  lines.push('<!-- schema-issues:start -->');
  lines.push('## Schema Issues');
  lines.push(`Updated: [[${dailyLink}]]`);
  lines.push('');

  const grouped = new Map();
  for (const row of issueRows) {
    const relNoExt = row.rel.replace(/\.md$/i, '');
    const fileName = path.basename(relNoExt);
    for (const rawMessage of row.messages) {
      const reason = normalizeIssueReason(rawMessage);
      if (!grouped.has(reason)) grouped.set(reason, []);
      grouped.get(reason).push({ relNoExt, fileName });
    }
  }

  const sortedReasons = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  for (const reason of sortedReasons) {
    lines.push(`### ${reason}`);
    const seen = new Set();
    const files = grouped
      .get(reason)
      .filter((x) => {
        const key = x.relNoExt;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    for (const f of files) {
      lines.push(`- [[${f.relNoExt}|${f.fileName}]]`);
    }
    lines.push('');
  }
  lines.push('<!-- schema-issues:end -->');
  return lines.join('\n');
}

function normalizeIssueReason(message) {
  const m = String(message || '').trim();
  const missing = m.match(/^Missing required field '([^']+)'/);
  if (missing) return `Missing required: ${missing[1]}`;
  if (m.startsWith('Move conflict:')) return 'Move conflict';
  return m;
}

function removeSchemaIssueFrontmatterFields(text) {
  const parsed = parseMarkdownWithFrontmatter(text);
  const fm = structuredClone(parsed.frontmatter || {});
  delete fm.schema_issue_count;
  delete fm.schema_issue_reasons;
  return serializeMarkdown(parsed.body, fm, parsed.hasFrontmatter);
}

function upsertManagedBlock(text, key, block) {
  const start = `<!-- ${key}:start -->`;
  const end = `<!-- ${key}:end -->`;
  const blockRe = new RegExp(`${start}[\\s\\S]*?${end}`, 'm');
  if (blockRe.test(text)) return text.replace(blockRe, block);
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

function removeManagedBlock(text, key) {
  const start = `<!-- ${key}:start -->`;
  const end = `<!-- ${key}:end -->`;
  const blockRe = new RegExp(`\\n?${start}[\\s\\S]*?${end}\\n?`, 'm');
  if (!blockRe.test(text)) return text;
  return text.replace(blockRe, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
}

async function clearTodayDailySchemaIssuesBlock(vault) {
  const today = formatLocalDate(new Date());
  const dailyPath = path.join(vault, 'Dailies', `${today}.md`);
  const text = await readFileIfExists(dailyPath);
  if (!text) return;
  const blockRe = /<!-- schema-issues:start -->[\s\S]*?<!-- schema-issues:end -->\n?/m;
  if (!blockRe.test(text)) return;
  const next = text.replace(blockRe, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  await fs.writeFile(dailyPath, next, 'utf8');
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDesiredDatedBaseName({ schema, frontmatter, currentBaseName, fixes }) {
  if (!schema || !schema.prependDateToTitle) return currentBaseName;
  const rawDate = frontmatter?.date;
  const date = normalizeDateToken(rawDate);
  if (!date) return currentBaseName;

  const stem = path.basename(currentBaseName, '.md');
  if (/^\d{4}-\d{2}-\d{2}(\b|\s)/.test(stem)) {
    return currentBaseName;
  }

  const next = `${date} ${stem}.md`;
  fixes.push(`prepended date to title '${date} '`);
  return next;
}

function normalizeDateToken(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:\b|$)/);
  return m ? m[1] : null;
}

function yamlString(value) {
  const v = String(value);
  return `"${v.replace(/"/g, '\\"')}"`;
}

function toTitleCase(value) {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function derivePurpose(typeName, parentType) {
  const known = {
    note: 'General notes',
    daily: 'Daily journal/log',
    meeting: 'Meeting notes',
    project: 'Projects and initiatives',
    subject: 'Topic/area maps',
    log: 'Operational/event logs',
    entity: 'Core entities',
    source: 'External sources',
    person: 'Individual entity',
    body: 'Institution/body entity',
    group: 'Group/collective entity',
    place: 'Place/location entity',
    country: 'Country entity',
    session: 'Session/event entity',
    article: 'Article source',
    book: 'Book source',
    paper: 'Paper source',
    report: 'Report source'
  };
  if (known[typeName]) return known[typeName];
  if (parentType) return `${typeName} (${parentType})`;
  return typeName;
}

function escapePipes(text) {
  return String(text).replace(/\|/g, '\\|');
}

function computeSchemaSignature(typeSchemas) {
  const normalized = typeSchemas.map((s) => ({
    id: s.id,
    extends: s.extends || null,
    folder: s.folder ?? null,
    purpose: s.purpose || null,
    required: [...(s.required || [])].sort(),
    properties: Object.keys(s.properties || {}).sort()
  }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function syncAutoNoteMoverConfig({ vault, schemas }) {
  const configPath = path.join(vault, '.obsidian', 'plugins', 'auto-note-mover', 'data.json');
  const status = {
    found: false,
    updated: false,
    ruleCount: 0,
    warnings: []
  };

  let raw = '';
  try {
    raw = await fs.readFile(configPath, 'utf8');
    status.found = true;
  } catch {
    status.warnings.push('Auto Note Mover config not found; skipped sync');
    return status;
  }

  let config = {};
  try {
    config = JSON.parse(raw);
  } catch (error) {
    status.warnings.push(`Auto Note Mover config is invalid JSON; skipped sync: ${error.message}`);
    return status;
  }

  const generated = [];
  const archiveRules = [
    {
      folder: 'Archive',
      tag: '',
      frontmatterProperty: 'status: done',
      pattern: ''
    },
    {
      folder: 'Archive',
      tag: '',
      frontmatterProperty: 'status: superseded',
      pattern: ''
    },
    {
      folder: 'Archive',
      tag: '',
      frontmatterProperty: 'status: cancelled',
      pattern: ''
    }
  ];
  for (const schema of schemas) {
    if (schema.discriminator !== 'type') continue;
    const folder = typeof schema.folder === 'string' ? schema.folder : null;
    if (folder === null) continue;
    if (folder === '') {
      if (normalizeString(schema.id) === 'note') {
        status.warnings.push("Schema 'type:note' maps to root '/', which Auto Note Mover cannot target");
      }
      continue;
    }

    const moverFolder = folder.replace(/^\/+/, '');
    if (!moverFolder) continue;

    generated.push({
      folder: moverFolder,
      tag: '',
      frontmatterProperty: `type: ${schema.id}`,
      pattern: ''
    });
  }

  generated.sort((a, b) => a.frontmatterProperty.localeCompare(b.frontmatterProperty));

  const deduped = [];
  const seen = new Set();
  for (const rule of [...archiveRules, ...generated]) {
    const key = `${rule.folder}::${rule.frontmatterProperty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(rule);
  }

  config.folder_tag_pattern = deduped;
  config.excluded_folder = [
    { folder: 'Templates' },
    { folder: 'Schemas' },
    { folder: 'Attachments' }
  ];
  status.ruleCount = deduped.length;

  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (next !== raw) {
    try {
      await fs.writeFile(configPath, next, 'utf8');
      status.updated = true;
    } catch (error) {
      status.warnings.push(`Failed to write Auto Note Mover config: ${error.message}`);
    }
  }

  return status;
}

async function loadSchemas(schemasDir) {
  const schemas = [];
  const seenSchemaIds = new Map();
  const warnings = [];
  const errors = [];

  let files = [];
  try {
    files = await fs.readdir(schemasDir);
  } catch (error) {
    return { schemas: [], warnings, errors: [String(error)] };
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    if (file.startsWith('_')) continue;
    const fullPath = path.join(schemasDir, file);

    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const parsedDoc = parseMarkdownWithFrontmatter(text);
      const codeBlock = extractFirstSchemaCodeBlock(text);
      let schema = null;

      if (codeBlock) {
        if (codeBlock.lang === 'json') {
          schema = JSON.parse(codeBlock.body);
        } else {
          schema = parseSimpleYaml(codeBlock.body);
        }
      } else {
        schema = parseNativeMarkdownSchema(parsedDoc.frontmatter || {}, parsedDoc.body);
      }

      if (!schema || !schema.id || !schema.properties) {
        warnings.push(`Invalid schema shape in ${fullPath} (needs id + properties)`);
        continue;
      }

      schema.__file = fullPath;
      const schemaKey = `${schema.discriminator}:${schema.id}`;
      if (seenSchemaIds.has(schemaKey)) {
        const previous = seenSchemaIds.get(schemaKey);
        warnings.push(`Duplicate schema ${schemaKey} in ${fullPath} (overrides ${previous})`);
        const idx = schemas.findIndex(
          (s) => s.id === schema.id && s.discriminator === schema.discriminator
        );
        if (idx >= 0) schemas.splice(idx, 1);
      }
      seenSchemaIds.set(schemaKey, fullPath);
      schemas.push(schema);
    } catch (error) {
      errors.push(`Failed to parse ${fullPath}: ${error.message}`);
    }
  }

  const resolved = resolveSchemaInheritance(schemas, warnings);
  return { schemas: resolved, warnings, errors };
}

function resolveSchemaInheritance(schemas, warnings) {
  const byKey = new Map();
  for (const schema of schemas) {
    byKey.set(`${schema.discriminator}:${schema.id}`, schema);
  }

  const resolving = new Set();
  const resolved = new Map();

  function visit(schema) {
    const key = `${schema.discriminator}:${schema.id}`;
    if (resolved.has(key)) return resolved.get(key);
    if (resolving.has(key)) {
      warnings.push(`Schema inheritance cycle detected at ${key}`);
      return schema;
    }

    resolving.add(key);
    let out = cloneValue(schema);
    if (schema.extends) {
      const parentKey = `${schema.discriminator}:${schema.extends}`;
      const parent = byKey.get(parentKey);
      if (!parent) {
        warnings.push(`Schema ${key} extends missing parent ${parentKey}`);
      } else {
        const parentResolved = visit(parent);
        out = mergeSchema(parentResolved, out);
      }
    }

    resolving.delete(key);
    resolved.set(key, out);
    return out;
  }

  return schemas.map((s) => {
    const out = visit(s);
    if (out.discriminator === 'type' && (out.folder === null || out.folder === undefined)) {
      out.folder = '';
    }
    out.pairRulesByField = out.pairRulesByField || {};
    out.pairRules = Object.values(out.pairRulesByField);
    return out;
  });
}

function mergeSchema(base, child) {
  const merged = cloneValue(child);
  merged.properties = { ...(base.properties || {}), ...(child.properties || {}) };
  merged.required = [...new Set([...(base.required || []), ...(child.required || [])])];
  merged.pairRulesByField = { ...(base.pairRulesByField || {}), ...(child.pairRulesByField || {}) };
  if (merged.folder === null || merged.folder === undefined) {
    merged.folder = base.folder ?? null;
  }
  if (merged.prependDateToTitle === undefined) {
    merged.prependDateToTitle = Boolean(base.prependDateToTitle);
  }
  if (!merged.purpose && base.purpose) {
    merged.purpose = base.purpose;
  }
  return merged;
}

function extractFirstSchemaCodeBlock(text) {
  const match = text.match(/```(json|yaml|yml)\n([\s\S]*?)\n```/i);
  if (!match) return null;
  return {
    lang: match[1].toLowerCase() === 'yml' ? 'yaml' : match[1].toLowerCase(),
    body: match[2]
  };
}

function parseNativeMarkdownSchema(frontmatter, body) {
  const reserved = new Set([
    'id',
    'folder',
    'appliesTo',
    'extends',
    'purpose',
    'prependDateToTitle',
    'notes'
  ]);
  const schemaFolder = normalizeSchemaFolder(frontmatter.folder ?? frontmatter.appliesTo);
  const prependDateSetting = parseBoolLike(frontmatter.prependDateToTitle);
  const schema = {
    id: null,
    discriminator: null,
    extends: parseSimpleWikiLink(frontmatter.extends),
    purpose: typeof frontmatter.purpose === 'string' ? frontmatter.purpose.trim() : null,
    prependDateToTitle: prependDateSetting === null ? undefined : prependDateSetting,
    folder: schemaFolder,
    required: [],
    properties: {},
    pairRulesByField: {}
  };
  const explicitDefaults = new Map();

  for (const [rawKey, rawValue] of Object.entries(frontmatter)) {
    if (reserved.has(rawKey)) continue;

    const required = rawKey.endsWith('*');
    let key = required ? rawKey.slice(0, -1) : rawKey;

    if (key.startsWith('default.')) {
      const defaultKey = key.slice('default.'.length);
      if (defaultKey && !defaultKey.includes('.')) {
        explicitDefaults.set(defaultKey, cloneValue(rawValue));
      }
      continue;
    }

    if (key.startsWith('pair.')) {
      const sourceField = key.slice('pair.'.length).trim();
      if (!sourceField) continue;
      const parsedPair = parsePairValue(rawValue);
      if (parsedPair) {
        schema.pairRulesByField[sourceField] = {
          sourceField,
          targetType: parsedPair.targetType,
          targetField: parsedPair.targetField,
          descriptor: `pair.${sourceField}`
        };
      }
      continue;
    }

    // Backward-compatible alias: linkPair.<id>: left<->right
    if (key.startsWith('linkPair.')) {
      const pairId = key.slice('linkPair.'.length).trim();
      if (!pairId) continue;
      const legacy = parseLinkPairValue(rawValue);
      if (legacy) {
        if (!schema.pairRulesByField[legacy.left]) {
          schema.pairRulesByField[legacy.left] = {
            sourceField: legacy.left,
            targetType: null,
            targetField: legacy.right,
            descriptor: `linkPair.${pairId}`
          };
        }
        if (!schema.pairRulesByField[legacy.right]) {
          schema.pairRulesByField[legacy.right] = {
            sourceField: legacy.right,
            targetType: null,
            targetField: legacy.left,
            descriptor: `linkPair.${pairId}`
          };
        }
      }
      continue;
    }

    // Prefer namespaced schema keys to avoid polluting normal property values
    // in Obsidian property suggestions.
    if (key.startsWith('field.')) {
      key = key.slice('field.'.length);
    } else if (key.includes('.')) {
      // Ignore unknown namespaced keys.
      continue;
    }
    if (!key) continue;

    const prop = propertyFromSchemaValue(rawValue, { allowImplicitDefault: false });
    schema.properties[key] = prop;
    if (required) schema.required.push(key);

    if (key === 'type') {
      if (!schema.discriminator) schema.discriminator = key;
      if (schema.discriminator === key) {
        if (prop.enum && prop.enum.length > 0) {
          schema.id = String(prop.enum[0]);
        } else if (prop.default !== undefined) {
          schema.id = String(prop.default);
        } else if (typeof rawValue === 'string' && rawValue.trim()) {
          schema.id = rawValue.trim();
        }
      }
    }
  }

  for (const [key, value] of explicitDefaults.entries()) {
    if (!schema.properties[key]) {
      schema.properties[key] = propertyFromDefaultValue(value);
    }
    if (value !== null) {
      schema.properties[key].default = cloneValue(value);
    }
  }

  if (!schema.id) {
    if (typeof frontmatter.id === 'string' && frontmatter.id.trim()) {
      schema.id = frontmatter.id.trim();
    }
  }
  if (!schema.discriminator) {
    schema.discriminator = 'type';
  }

  if (schema.discriminator === 'type' && !schema.required.includes('type')) {
    schema.required.push('type');
  }

  schema.pairRules = Object.values(schema.pairRulesByField);

  return schema.id ? schema : null;
}

function parseLinkPairValue(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const m = rawValue.trim().match(/^([A-Za-z0-9_-]+)\s*<->\s*([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  return {
    left: m[1],
    right: m[2]
  };
}

function parsePairValue(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const m = rawValue.trim().match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  return {
    targetType: m[1],
    targetField: m[2]
  };
}

function isSimpleWikiLink(value) {
  return /^\[\[[^\]|#]+\]\]$/.test(String(value || '').trim());
}

function parseSimpleWikiLink(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const m = trimmed.match(/^\[\[([^\]|#]+)\]\]$/);
  if (!m) return null;
  return m[1].trim() || null;
}

function parseBoolLike(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(v)) return true;
  if (['false', 'no', 'n', '0', ''].includes(v)) return false;
  return null;
}

function propertyFromSchemaValue(rawValue, options = {}) {
  const allowImplicitDefault = Boolean(options.allowImplicitDefault);
  if (Array.isArray(rawValue)) {
    if (rawValue.length === 0) {
      return allowImplicitDefault ? { type: 'array', default: [] } : { type: 'array' };
    }
    if (rawValue.length === 1) {
      return allowImplicitDefault ? { type: 'array', default: [rawValue[0]] } : { type: 'array' };
    }
    return { type: 'array', enum: rawValue };
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed.includes(',')) {
      const parts = trimmed
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => parseScalar(x));
      return { type: 'string', enum: parts };
    }
    const parsed = parseScalar(trimmed);
    return allowImplicitDefault
      ? { type: inferPrimitiveType(parsed), default: parsed }
      : { type: inferPrimitiveType(parsed) };
  }

  if (typeof rawValue === 'boolean' || typeof rawValue === 'number') {
    return allowImplicitDefault
      ? { type: inferPrimitiveType(rawValue), default: rawValue }
      : { type: inferPrimitiveType(rawValue) };
  }

  if (rawValue === null) {
    return { type: 'string' };
  }

  return { type: 'string' };
}

function propertyFromDefaultValue(rawValue) {
  if (Array.isArray(rawValue)) return { type: 'array' };
  if (typeof rawValue === 'boolean') return { type: 'boolean' };
  if (typeof rawValue === 'number') return { type: 'number' };
  if (rawValue === null) return { type: 'string' };
  return { type: 'string' };
}

function inferPrimitiveType(value) {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

function normalizeSchemaFolder(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = normalizeFolderToken(value[0]);
    return first === '' ? '' : first || null;
  }
  if (typeof value === 'string') {
    const one = normalizeFolderToken(value);
    return one === '' ? '' : one || null;
  }
  if (value && typeof value === 'object' && Array.isArray(value.folders)) {
    if (value.folders.length === 0) return null;
    const first = normalizeFolderToken(value.folders[0]);
    return first === '' ? '' : first || null;
  }
  return null;
}

function normalizeFolderToken(value) {
  if (value === null || value === undefined) return '';
  let token = String(value).trim();
  if (!token) return '';
  token = token.replace(/^\/+/, '');
  token = token.split('/')[0];
  return token;
}

function parseSimpleYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.match(/^\s*/)[0].length;
    line = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;

    if (line.startsWith('- ')) {
      if (Array.isArray(parent)) {
        parent.push(parseScalar(line.slice(2).trim()));
      } else {
        if (!Array.isArray(parent.__list)) {
          parent.__list = [];
        }
        parent.__list.push(parseScalar(line.slice(2).trim()));
      }
      continue;
    }

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    if (!rest) {
      const nextInfo = nextMeaningfulLine(lines, i + 1);
      if (!nextInfo || nextInfo.indent <= indent) {
        parent[key] = null;
        continue;
      }

      const nextTrim = nextInfo.line.trim();
      const child = nextTrim.startsWith('- ') ? [] : {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent[key] = parseScalar(rest);
  }

  sanitizeYamlLists(root);
  return root;
}

function nextMeaningfulLine(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return { line: raw, indent: raw.match(/^\s*/)[0].length, index: i };
  }
  return null;
}

function sanitizeYamlLists(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (Array.isArray(value)) {
      continue;
    }
    if (value && typeof value === 'object' && Array.isArray(value.__list)) {
      obj[key] = value.__list;
    } else if (value && typeof value === 'object') {
      sanitizeYamlLists(value);
    }
  }
}

async function listMarkdownFiles(rootDir) {
  const out = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);

      if (entry.isDirectory()) {
        const relTop = rel.split(path.sep).join('/');
        if (DEFAULT_IGNORE_DIRS.has(entry.name) || DEFAULT_IGNORE_DIRS.has(relTop)) {
          continue;
        }
        await walk(full);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function processFile({ file, vault, schemas, mode, write }) {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = parseMarkdownWithFrontmatter(raw);
  const relPath = path.relative(vault, file).split(path.sep).join('/');
  const dir = path.posix.dirname(relPath);
  const currentFolder = dir === '.' ? '' : dir.split('/')[0];
  const hadTypeAtStart = normalizeString(parsed.frontmatter?.type) !== '';

  const working = structuredClone(parsed.frontmatter || {});
  const fixes = [];
  const ambiguous = [];

  if (working.fix_notes !== undefined) {
    if (working.schema_notes === undefined) {
      working.schema_notes = working.fix_notes;
      fixes.push(`migrated 'fix_notes' -> 'schema_notes'`);
    }
    delete working.fix_notes;
  }
  if (working.needs_review !== undefined) {
    delete working.needs_review;
    fixes.push(`removed deprecated 'needs_review'`);
  }

  applyBroadAutofix({ relPath, filePath: file, working, fixes });

  const matchInfo = pickSchemasForFile({ relPath, working, schemas });
  const typeSchema = matchInfo?.typeSchema || null;
  const appliedSchemas = [typeSchema].filter(Boolean);
  const violations = [];

  if (appliedSchemas.length > 0) {
    for (const schema of appliedSchemas) {
      applySchemaAutofix({ schema, working, fixes, ambiguous, relPath });
      validateAgainstSchema({ schema, working, relPath, violations });
    }
  } else {
    violations.push({
      rule: 'schema/not-found',
      message: `No schema matched note ${relPath}`
    });
  }

  if (ambiguous.length > 0) {
    ensureSchemaNotes(working, ambiguous);
  } else if (working.schema_notes !== undefined) {
    delete working.schema_notes;
    fixes.push(`cleared stale 'schema_notes'`);
  }

  const changed = !deepEqual(working, parsed.frontmatter || {});
  let movedTo = null;
  const desiredBaseName = getDesiredDatedBaseName({
    schema: typeSchema,
    frontmatter: working,
    currentBaseName: path.basename(file),
    fixes
  });
  const currentDirRel = dir === '.' ? '' : dir;
  let targetDirRel = currentDirRel;
  const status = normalizeString(working.status);

  if (TERMINAL_STATUSES.has(status)) {
    targetDirRel = 'Archive';
  } else
  if (!hadTypeAtStart && currentFolder !== '') {
    targetDirRel = '';
  } else if (
    typeSchema &&
    matchInfo.typeFolderMismatch &&
    matchInfo.typePreferredFolder !== null &&
    currentFolder !== 'Templates'
  ) {
    targetDirRel = matchInfo.typePreferredFolder || '';
  }

  const targetRelPath = targetDirRel ? `${targetDirRel}/${desiredBaseName}` : desiredBaseName;
  if (targetRelPath !== relPath) {
    const targetPath = path.join(vault, targetRelPath);
    if (mode === 'fix' && write) {
      try {
        await fs.access(targetPath);
        ambiguous.push(`Move conflict: ${targetRelPath}`);
      } catch {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rename(file, targetPath);
        movedTo = targetPath;
        if (!hadTypeAtStart && currentFolder !== '') {
          fixes.push(`moved file without type to root '${targetRelPath}'`);
        } else if (targetDirRel !== currentDirRel) {
          fixes.push(`moved file to '${targetRelPath}' based on schema folder`);
        } else {
          fixes.push(`renamed file to '${targetRelPath}'`);
        }
      }
    } else {
      if (!hadTypeAtStart && currentFolder !== '') {
        fixes.push(`would move file without type to root '${targetRelPath}'`);
      } else if (targetDirRel !== currentDirRel) {
        fixes.push(`would move file to '${targetRelPath}' based on schema folder`);
      } else {
        fixes.push(`would rename file to '${targetRelPath}'`);
      }
    }
  }

  if (mode === 'fix' && changed && write) {
    const updatedText = serializeMarkdown(parsed.body, working, parsed.hasFrontmatter);
    await fs.writeFile(movedTo || file, updatedText, 'utf8');
  }

  return {
    file: movedTo || file,
    relativePath: relPath,
    schema: appliedSchemas.map((s) => `${s.discriminator}:${s.id}`),
    movedTo,
    changed,
    fixes,
    ambiguous,
    violations
  };
}

async function applyBidirectionalLinkPass({ vault, schemas, report, mode, write }) {
  const notes = [];
  const reportsByFile = new Map();
  const schemaIndex = buildTypeSchemaIndex(schemas);
  for (const item of report.files) {
    reportsByFile.set(item.file, item);
  }

  for (const item of report.files) {
    const file = item.file;
    let raw = '';
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      item.violations.push({
        rule: 'backlink/read-failed',
        message: `Failed to read '${path.relative(vault, file)}': ${error.message}`
      });
      continue;
    }
    const parsed = parseMarkdownWithFrontmatter(raw);
    const relPath = path.relative(vault, file).split(path.sep).join('/');
    const matchInfo = pickSchemasForFile({ relPath, working: parsed.frontmatter || {}, schemas });
    const typeSchema = matchInfo?.typeSchema || null;
    const note = {
      file,
      relPath,
      body: parsed.body,
      hasFrontmatter: parsed.hasFrontmatter,
      frontmatter: structuredClone(parsed.frontmatter || {}),
      schema: typeSchema,
      changed: false
    };
    notes.push(note);
  }

  const titleMap = new Map();
  for (const note of notes) {
    const title = path.basename(note.file, '.md').trim();
    const key = normalizeTitleKey(title);
    if (!key) continue;
    if (!titleMap.has(key)) titleMap.set(key, []);
    titleMap.get(key).push(note);
  }

  const linkOpsSeen = new Set();

  for (const source of notes) {
    const pairRules = source.schema?.pairRules || [];
    if (!Array.isArray(pairRules) || pairRules.length === 0) continue;
    for (const rule of pairRules) {
      applyBacklinkDirection({
        source,
        sourceField: rule.sourceField,
        targetType: rule.targetType,
        targetField: rule.targetField,
        descriptor: rule.descriptor || `pair.${rule.sourceField}`,
        schemaIndex,
        titleMap,
        linkOpsSeen,
        reportsByFile
      });
    }
  }

  if (mode === 'fix' && write) {
    for (const note of notes) {
      if (!note.changed) continue;
      const updatedText = serializeMarkdown(note.body, note.frontmatter, note.hasFrontmatter);
      await fs.writeFile(note.file, updatedText, 'utf8');
    }
  }

  for (const note of notes) {
    if (!note.changed) continue;
    const entry = reportsByFile.get(note.file);
    if (entry) entry.changed = true;
  }
}

function applyBacklinkDirection({
  source,
  sourceField,
  targetType,
  targetField,
  descriptor,
  schemaIndex,
  titleMap,
  linkOpsSeen,
  reportsByFile
}) {
  const sourceReport = reportsByFile.get(source.file);
  if (!sourceReport) return;
  const outboundLinks = extractLinkTargets(source.frontmatter[sourceField]);
  for (const outboundLink of outboundLinks) {
    const targetTitle = parseWikiLinkTarget(outboundLink);
    if (!targetTitle) continue;
    const key = normalizeTitleKey(targetTitle);
    const matches = titleMap.get(key) || [];
    if (matches.length === 0) {
      sourceReport.violations.push({
        rule: 'backlink/unresolved',
        field: sourceField,
        message: `Unresolved backlink target '${targetTitle}' from '${sourceField}' (${descriptor})`
      });
      continue;
    }
    if (matches.length > 1) {
      sourceReport.violations.push({
        rule: 'backlink/ambiguous',
        field: sourceField,
        message: `Ambiguous backlink target '${targetTitle}' from '${sourceField}' (${descriptor})`
      });
      continue;
    }

    const target = matches[0];
    if (targetType && !noteMatchesTargetType(target, targetType, schemaIndex)) {
      sourceReport.violations.push({
        rule: 'backlink/type-mismatch',
        field: sourceField,
        message: `Backlink target '${targetTitle}' type '${target.frontmatter.type || ''}' does not match '${targetType}' (${descriptor})`
      });
      continue;
    }
    const sourceTitle = path.basename(source.file, '.md').trim();
    const sourceLink = `[[${sourceTitle}]]`;
    const opKey = `${target.file}::${targetField}::${normalizeTitleKey(sourceTitle)}`;
    if (linkOpsSeen.has(opKey)) continue;
    linkOpsSeen.add(opKey);

    const containerKind = fieldContainerKind(target.schema?.properties?.[targetField], target.frontmatter[targetField]);
    const added = addInverseLink({
      frontmatter: target.frontmatter,
      field: targetField,
      link: sourceLink,
      containerKind
    });
    if (!added.ok) {
      sourceReport.violations.push({
        rule: added.rule,
        field: targetField,
        message: `${added.message} (${descriptor})`
      });
      continue;
    }
    if (added.changed) {
      target.changed = true;
      const targetReport = reportsByFile.get(target.file);
      if (targetReport) {
        targetReport.fixes.push(
          `synced inverse '${targetField}' from [[${path.basename(source.file, '.md')}]] via '${descriptor}'`
        );
      }
    }
  }
}

function fieldContainerKind(prop, currentValue) {
  if (prop && prop.type === 'array') return 'array';
  if (prop && prop.type === 'string') return 'scalar';
  if (Array.isArray(currentValue)) return 'array';
  if (typeof currentValue === 'string' && currentValue.trim()) return 'scalar';
  if (currentValue === null || currentValue === undefined || currentValue === '') return 'unknown';
  return 'unknown';
}

function addInverseLink({ frontmatter, field, link, containerKind }) {
  if (containerKind === 'unknown') {
    return {
      ok: false,
      rule: 'backlink/unknown-field',
      message: `Cannot infer container type for inverse field '${field}'`
    };
  }

  if (containerKind === 'array') {
    const current = Array.isArray(frontmatter[field]) ? frontmatter[field] : extractLinkTargets(frontmatter[field]);
    const links = current.map((item) => normalizeWikiLinkValue(item)).filter(Boolean);
    const existing = new Set(links.map((item) => normalizeTitleKey(parseWikiLinkTarget(item) || item)));
    const key = normalizeTitleKey(parseWikiLinkTarget(link) || link);
    if (!existing.has(key)) {
      links.push(link);
      frontmatter[field] = links;
      return { ok: true, changed: true };
    }
    if (!Array.isArray(frontmatter[field])) {
      frontmatter[field] = links;
      return { ok: true, changed: true };
    }
    return { ok: true, changed: false };
  }

  const existing = normalizeWikiLinkValue(frontmatter[field]);
  if (!existing) {
    frontmatter[field] = link;
    return { ok: true, changed: true };
  }
  const existingTarget = normalizeTitleKey(parseWikiLinkTarget(existing) || existing);
  const wantedTarget = normalizeTitleKey(parseWikiLinkTarget(link) || link);
  if (existingTarget === wantedTarget) {
    if (frontmatter[field] !== existing) {
      frontmatter[field] = existing;
      return { ok: true, changed: true };
    }
    return { ok: true, changed: false };
  }
  return {
    ok: false,
    rule: 'backlink/scalar-conflict',
    message: `Scalar inverse field '${field}' already points to '${existing}'`
  };
}

function extractLinkTargets(fieldValue) {
  if (Array.isArray(fieldValue)) {
    return fieldValue.map((item) => normalizeWikiLinkValue(item)).filter(Boolean);
  }
  const one = normalizeWikiLinkValue(fieldValue);
  return one ? [one] : [];
}

function normalizeWikiLinkValue(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (isWikiLink(raw)) {
    const target = parseWikiLinkTarget(raw);
    return target ? `[[${target}]]` : null;
  }
  const cleaned = raw.replace(/^\[\[|\]\]$/g, '').trim();
  return cleaned ? `[[${cleaned}]]` : null;
}

function parseWikiLinkTarget(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^\[\[([^\]]+)\]\]$/);
  if (!match) return null;
  const base = match[1].split('|')[0].split('#')[0].trim();
  return base || null;
}

function normalizeTitleKey(value) {
  return String(value || '').trim().toLowerCase();
}

function buildTypeSchemaIndex(schemas) {
  const index = new Map();
  for (const schema of schemas || []) {
    if (normalizeString(schema?.discriminator) !== 'type') continue;
    const id = normalizeString(schema?.id);
    if (!id || index.has(id)) continue;
    index.set(id, schema);
  }
  return index;
}

function noteMatchesTargetType(note, targetType, schemaIndex) {
  const wanted = normalizeString(targetType);
  if (!wanted) return true;
  const directType = normalizeString(note?.schema?.id || note?.frontmatter?.type);
  return typeMatchesOrExtends(directType, wanted, schemaIndex);
}

function typeMatchesOrExtends(typeValue, wantedType, schemaIndex) {
  let current = normalizeString(typeValue);
  const wanted = normalizeString(wantedType);
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (current === wanted) return true;
    seen.add(current);
    const schema = schemaIndex.get(current);
    current = normalizeString(schema?.extends);
  }
  return false;
}

function applyBroadAutofix({ relPath, filePath, working, fixes }) {
  const folder = relPath.split('/')[0];
  const filename = path.basename(filePath, '.md');

  normalizeTypeValue(working, fixes);

  const currentType = normalizeString(working.type);
  if (currentType && Object.prototype.hasOwnProperty.call(LEGACY_TYPE_MAP, currentType)) {
    const mapped = LEGACY_TYPE_MAP[currentType];
    if (mapped) {
      working.type = mapped;
      fixes.push(`legacy type '${currentType}' -> type='${mapped}'`);
    }
  }

  // One-time migration: kind -> subtype (intermediate step before flattening to type)
  if (working.kind !== undefined) {
    if (working.subtype === undefined || working.subtype === null || working.subtype === '') {
      working.subtype = working.kind;
      fixes.push(`migrated 'kind' -> 'subtype'`);
    }
    delete working.kind;
  }

  const baseType = normalizeString(working.type);
  if (
    (baseType === 'entity' || baseType === 'source') &&
    working.subtype !== undefined &&
    working.subtype !== null &&
    String(working.subtype).trim() !== ''
  ) {
    const subtypeNorm = normalizeString(working.subtype);
    const canonicalSubtype = LEGACY_SUBTYPE_MAP[subtypeNorm] || subtypeNorm;
    const flattened = canonicalSubtype;
    working.type = flattened;
    delete working.subtype;
    fixes.push(`flattened type/subtype -> type='${flattened}'`);
  } else if (working.subtype !== undefined) {
    delete working.subtype;
    fixes.push(`removed deprecated 'subtype'`);
  }

  if (!working.type || normalizeString(working.type) === 'none') {
    const inferred = FOLDER_TYPE_MAP[folder];
    if (inferred) {
      working.type = inferred;
      fixes.push(`inferred type='${inferred}' from folder '${folder}'`);
    } else if (folder === '') {
      working.type = 'note';
      fixes.push(`inferred type='note' for root note without type`);
    }
  }

  const normalizedType = normalizeString(working.type);
  if (normalizedType) {
    working.type = normalizedType;
  }

  if (folder === 'Dailies') {
    if (!working.date && /^\d{4}-\d{2}-\d{2}$/.test(filename)) {
      working.date = filename;
      fixes.push(`added date from filename '${filename}'`);
    }
  }

  if (folder === 'Meetings') {
    const m = filename.match(/^(\d{4}-\d{2}-\d{2})\b/);
    if (m && !working.date) {
      working.date = m[1];
      fixes.push(`added meeting date '${m[1]}' from filename`);
    }
  }

  for (const key of ['tags', 'aliases', 'children', 'attendees']) {
    if (working[key] !== undefined && working[key] !== null && !Array.isArray(working[key])) {
      working[key] = [String(working[key]).trim()].filter(Boolean);
      fixes.push(`coerced '${key}' to array`);
    }
  }

  if (typeof working.parent === 'string' && working.parent.trim() && !isWikiLink(working.parent)) {
    working.parent = toWikiLink(working.parent);
    fixes.push(`normalized parent to wikilink`);
  }

}

function applySchemaAutofix({ schema, working, fixes, ambiguous, relPath }) {
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      const prop = schema.properties[key];
      if (working[key] === undefined) {
        if (prop && Object.prototype.hasOwnProperty.call(prop, 'default')) {
          working[key] = cloneValue(prop.default);
          fixes.push(`added required '${key}' from schema default`);
        } else {
          working[key] = blankValueForProperty(prop);
          fixes.push(`added required '${key}' (blank)`);
        }
      } else if (typeof working[key] === 'string' && working[key].trim() === '') {
        working[key] = null;
        fixes.push(`normalized required '${key}' empty->null`);
      }
    }
  }

  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const value = working[key];
    if (value === undefined) continue;

    if (prop.type === 'string' && Array.isArray(value) && value.length === 1) {
      working[key] = String(value[0]);
      fixes.push(`coerced '${key}' array->string`);
    }

    if (prop.type === 'array' && !Array.isArray(value)) {
      working[key] = [String(value)];
      fixes.push(`coerced '${key}' string->array`);
    }

    if (prop.type === 'string' && typeof working[key] === 'string') {
      working[key] = working[key].trim();
    }

    if (prop.enum && typeof working[key] === 'string') {
      const lowered = working[key].toLowerCase();
      const matched = prop.enum.find((entry) => String(entry).toLowerCase() === lowered);
      if (matched !== undefined && matched !== working[key]) {
        working[key] = matched;
        fixes.push(`normalized enum case for '${key}'`);
      }
    }

    if (prop.format === 'wikilink' && typeof working[key] === 'string' && working[key].trim()) {
      if (!isWikiLink(working[key])) {
        working[key] = toWikiLink(working[key]);
        fixes.push(`normalized '${key}' to wikilink`);
      }
    }
  }
}

function validateAgainstSchema({ schema, working, violations }) {
  for (const key of schema.required || []) {
    if (!hasMeaningfulRequiredValue(working[key])) {
      violations.push({ rule: 'required', field: key, message: `Missing required field '${key}'` });
    }
  }

  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const value = working[key];
    if (value === undefined || value === null) continue;
    if (value === '') continue;

    if (prop.type === 'string' && typeof value !== 'string') {
      violations.push({ rule: 'type', field: key, message: `'${key}' should be string` });
      continue;
    }

    if (prop.type === 'array' && !Array.isArray(value)) {
      violations.push({ rule: 'type', field: key, message: `'${key}' should be array` });
      continue;
    }

    if (prop.enum && !prop.enum.includes(value)) {
      violations.push({
        rule: 'enum',
        field: key,
        message: `'${key}' should be one of: ${prop.enum.join(', ')}, got '${value}'`
      });
    }

    if (prop.format === 'wikilink' && typeof value === 'string' && !isWikiLink(value)) {
      violations.push({ rule: 'format', field: key, message: `'${key}' should be a wikilink ([[...]])` });
    }
  }
}

function blankValueForProperty(prop) {
  if (!prop || !prop.type) return '';
  if (prop.type === 'array') return [];
  return null;
}

function hasMeaningfulRequiredValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function pickSchemasForFile({ relPath, working, schemas }) {
  const folder = relPath.split('/')[0];
  const noteType = normalizeString(working.type);
  const typeCandidate = pickBestSchemaByDiscriminator({
    schemas,
    discriminator: 'type',
    noteValue: noteType,
    folder,
    working
  });

  return {
    typeSchema: typeCandidate?.schema || null,
    typeFolderMismatch: typeCandidate?.folderMismatch || false,
    typePreferredFolder: typeCandidate ? typeCandidate.preferredFolder : null
  };
}

function pickBestSchemaByDiscriminator({ schemas, discriminator, noteValue, folder, working }) {
  const candidates = [];
  for (const schema of schemas) {
    if (schema.discriminator !== discriminator) continue;

    const schemaFolder = typeof schema.folder === 'string' ? schema.folder : null;
    const schemaId = normalizeString(schema.id);
    const valueMatch = Boolean(noteValue && schemaId && noteValue === schemaId);
    const folderMatch = schemaFolder !== null ? schemaFolder === folder : false;

    // Type schema: either value match or folder match.
    if (!valueMatch && !folderMatch) continue;

    const match = schema.match || {};
    let ok = true;
    for (const [k, v] of Object.entries(match)) {
      const got = normalizeString(working[k]);
      if (got !== normalizeString(v)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    candidates.push({ schema, valueMatch, folderMatch, schemaFolder });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.valueMatch !== b.valueMatch) return a.valueMatch ? -1 : 1;
    if (a.folderMatch !== b.folderMatch) return a.folderMatch ? -1 : 1;
    return 0;
  });

  const best = candidates[0];
  return {
    schema: best.schema,
    matchedByValue: best.valueMatch,
    matchedByFolder: best.folderMatch,
    folderMismatch: best.valueMatch && best.schemaFolder !== null && best.schemaFolder !== folder,
    preferredFolder: best.schemaFolder
  };
}

function normalizeTypeValue(working, fixes) {
  if (working.type === undefined || working.type === null) return;
  if (typeof working.type !== 'string') {
    if (typeof working.type === 'object') {
      delete working.type;
      fixes.push(`cleared invalid non-scalar 'type'`);
      return;
    }
    working.type = String(working.type);
    fixes.push(`coerced type to string`);
  }

  let val = working.type.trim();
  if (val.startsWith('[[') && val.endsWith(']]')) {
    val = val.slice(2, -2);
  }

  if (val.startsWith('"') && val.endsWith('"')) {
    val = val.slice(1, -1);
  }

  if (/^none$/i.test(val)) {
    val = 'none';
  }

  if (val === '[object Object]') {
    delete working.type;
    fixes.push(`cleared invalid 'type' sentinel value`);
    return;
  }

  working.type = val;
}

function parseMarkdownWithFrontmatter(text) {
  if (!text.startsWith('---\n')) {
    return { hasFrontmatter: false, frontmatter: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { hasFrontmatter: false, frontmatter: {}, body: text };
  }

  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  const fm = parseSimpleYaml(fmLines.join('\n'));

  return { hasFrontmatter: true, frontmatter: fm, body };
}

function parseScalar(value) {
  const v = value.trim();
  if (v === '') return '';

  // Preserve Obsidian wikilinks as strings (e.g. [[entity]]).
  if (/^\[\[[^\]]+\]\]$/.test(v)) {
    return v;
  }

  let unquoted = v;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    unquoted = v.slice(1, -1);
  }

  // Preserve quoted wikilinks too (e.g. "[[entity]]").
  if (/^\[\[[^\]]+\]\]$/.test(unquoted)) {
    return unquoted;
  }

  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (unquoted === 'null' || unquoted === '~') return null;

  if (/^-?\d+(\.\d+)?$/.test(unquoted)) {
    return Number(unquoted);
  }

  if (unquoted.startsWith('[') && unquoted.endsWith(']')) {
    const inner = unquoted.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((x) => x.trim())
      .map((x) => parseScalar(x));
  }

  return unquoted;
}

function serializeMarkdown(body, frontmatter) {
  const ordered = orderKeys(frontmatter);
  const fmText = serializeFrontmatter(ordered);
  return `---\n${fmText}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

function orderKeys(obj) {
  const out = {};
  for (const key of PREFERRED_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      out[key] = obj[key];
    }
  }

  for (const key of Object.keys(obj).sort()) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = obj[key];
    }
  }

  return out;
}

function serializeFrontmatter(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${serializeScalar(item)}`);
        }
      }
      continue;
    }

    if (value === null || value === undefined) {
      lines.push(`${key}: null`);
      continue;
    }

    lines.push(`${key}: ${serializeScalar(value)}`);
  }
  return lines.join('\n');
}

function serializeScalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }

  const v = String(value);
  if (v === '') return '""';

  if (needsQuote(v)) {
    return `"${v.replace(/"/g, '\\"')}"`;
  }

  return v;
}

function needsQuote(value) {
  if (/^\d+$/.test(value)) return true;
  if (/^(true|false|null|~)$/i.test(value)) return true;
  if (/[\[\]{}:,#]|^\s|\s$/.test(value)) return true;
  if (value.includes('"')) return true;
  return false;
}

function ensureSchemaNotes(frontmatter, ambiguous) {
  frontmatter.schema_notes = [...new Set(ambiguous)];
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function isWikiLink(value) {
  return /^\[\[[^\]]+\]\]$/.test(value.trim());
}

function toWikiLink(value) {
  const cleaned = String(value).trim().replace(/^\[\[|\]\]$/g, '');
  return `[[${cleaned}]]`;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cloneValue(v) {
  return JSON.parse(JSON.stringify(v));
}

function printSummary(report, reportPath, warnings) {
  console.log(`Scanned ${report.filesScanned} markdown files`);
  if (warnings.length > 0) {
    console.log(`Schema warnings: ${warnings.length}`);
    for (const warning of warnings.slice(0, 10)) {
      console.log(`- ${warning}`);
    }
  }

  if (report.schemaErrors.length > 0) {
    console.log(`Schema errors: ${report.schemaErrors.length}`);
    for (const error of report.schemaErrors.slice(0, 10)) {
      console.log(`- ${error}`);
    }
  }

  if (report.autoNoteMoverSync?.found) {
    const syncState = report.autoNoteMoverSync.updated ? 'updated' : 'already up to date';
    console.log(`Auto Note Mover sync: ${syncState} (${report.autoNoteMoverSync.ruleCount} rules)`);
  }
  if (Array.isArray(report.autoNoteMoverSync?.warnings) && report.autoNoteMoverSync.warnings.length > 0) {
    console.log(`Auto Note Mover warnings: ${report.autoNoteMoverSync.warnings.length}`);
    for (const warning of report.autoNoteMoverSync.warnings.slice(0, 10)) {
      console.log(`- ${warning}`);
    }
  }
  if (report.schemaIssuePagesSync) {
    const s = report.schemaIssuePagesSync;
    console.log(`Schema issue pages: updated ${s.updated}/${s.schemaCount} schema files (${s.issueCount} issue files)`);
    if (s.warning) {
      console.log(`- ${s.warning}`);
    }
  }

  console.log(`Files changed (or would change): ${report.fixedCount}`);
  console.log(`Violations remaining: ${report.violationCount}`);
  console.log(`Ambiguous cases flagged: ${report.skippedAmbiguousCount}`);
  console.log(`Report: ${reportPath}`);

  const withProblems = report.files.filter((f) => f.violations.length > 0 || f.ambiguous.length > 0);
  for (const file of withProblems.slice(0, 20)) {
    console.log(`\n${file.relativePath}`);
    for (const violation of file.violations.slice(0, 3)) {
      console.log(`  [violation] ${violation.message}`);
    }
    for (const item of file.ambiguous.slice(0, 2)) {
      console.log(`  [review] ${item}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
