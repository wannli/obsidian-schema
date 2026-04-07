const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPluginHelpers } = require('./mobile-schema-typer.helpers.cjs');

const {
  parseSchemaFrontmatter,
  normalizeTypeKey,
  typeMatchesOrExtends,
  fieldContainerKind,
  addInverseLink,
  pruneManagedInverseLinks,
  buildWikiLinkToFile,
  buildWikiLinkToBasename,
  findInlineTypeCandidates,
  applyInlineTypeReplacements,
  sanitizeNoteTitle,
  extractDatePrefix,
  createRunStats
} = loadPluginHelpers();

test('normalizeTypeKey lowercases and trims', () => {
  assert.equal(normalizeTypeKey('  Task  '), 'task');
});

test('parseSchemaFrontmatter supports required fields, defaults, and pairs', () => {
  const schema = parseSchemaFrontmatter({
    type: 'Meeting',
    extends: '[[log]]',
    folder: '/Meetings/',
    'field.date*': '',
    'field.attendees': [],
    'default.attendees': ['Alice'],
    'pair.project': 'project.meetings',
    prependDateToTitle: true
  }, { type: 'meeting' });

  assert.equal(schema.type, 'meeting');
  assert.equal(schema.extends, 'log');
  assert.equal(schema.folder, 'Meetings');
  assert.equal(schema.prependDateToTitle, true);
  assert.equal(schema.required.has('date'), true);
  assert.equal(schema.fields.get('attendees').kind, 'array');
  assert.equal(JSON.stringify(schema.fields.get('attendees').defaultValue), JSON.stringify(['Alice']));
  assert.equal(schema.pairRulesByField.project.targetType, 'project');
  assert.equal(schema.pairRulesByField.project.targetField, 'meetings');
});

test('typeMatchesOrExtends follows schema inheritance chain', () => {
  const schemas = new Map([
    ['meeting', { type: 'meeting', extends: 'log' }],
    ['log', { type: 'log', extends: 'item' }],
    ['item', { type: 'item', extends: null }]
  ]);

  assert.equal(typeMatchesOrExtends('meeting', 'log', schemas), true);
  assert.equal(typeMatchesOrExtends('meeting', 'item', schemas), true);
  assert.equal(typeMatchesOrExtends('meeting', 'project', schemas), false);
});

test('fieldContainerKind infers array and scalar fields', () => {
  assert.equal(fieldContainerKind({ kind: 'array' }, null), 'array');
  assert.equal(fieldContainerKind({ kind: 'string' }, null), 'scalar');
  assert.equal(fieldContainerKind(null, ['a']), 'array');
  assert.equal(fieldContainerKind(null, '[[Note]]'), 'scalar');
});

test('addInverseLink appends missing array backlink without duplication', () => {
  const fm = { employees: ['[[People/Alice]]'] };
  const first = addInverseLink({
    frontmatter: fm,
    field: 'employees',
    link: '[[People/Bob]]',
    containerKind: 'array'
  });
  const second = addInverseLink({
    frontmatter: fm,
    field: 'employees',
    link: '[[People/Bob]]',
    containerKind: 'array'
  });

  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(fm.employees, ['[[People/Alice]]', '[[People/Bob]]']);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
});

test('pruneManagedInverseLinks removes stale array backlinks when enabled by caller', () => {
  const fm = { employees: ['[[People/Alice]]', '[[People/Bob]]'] };
  const res = pruneManagedInverseLinks({
    frontmatter: fm,
    field: 'employees',
    desiredLinks: ['[[People/Bob]]'],
    containerKind: 'array'
  });

  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.equal(res.removedCount, 1);
  assert.equal(JSON.stringify(fm.employees), JSON.stringify(['[[People/Bob]]']));
});

test('buildWikiLinkToFile uses vault-relative path without extension', () => {
  assert.equal(buildWikiLinkToFile({ path: 'Projects/Test Note.md', basename: 'Test Note' }), '[[Projects/Test Note]]');
  assert.equal(buildWikiLinkToFile({ path: '', basename: 'Loose' }), '[[Loose]]');
});

test('buildWikiLinkToBasename uses title-only wikilinks', () => {
  assert.equal(buildWikiLinkToBasename({ path: 'Projects/Test Note.md', basename: 'Test Note' }), '[[Test Note]]');
  assert.equal(buildWikiLinkToBasename({ basename: 'Loose' }), '[[Loose]]');
});

test('findInlineTypeCandidates matches supported list-item shorthand', () => {
  const text = [
    '- Jane Doe #delegate',
    '- [ ] Security Council #organ',
    '1. Informal consultations #meeting',
    'Paragraph mention #delegate',
    '- Already linked [[Jane Doe]] #delegate'
  ].join('\n');
  const matches = findInlineTypeCandidates(text, new Set(['delegate', 'organ', 'meeting']));

  assert.equal(matches.length, 3);
  assert.equal(matches[0].prefix, '- ');
  assert.equal(matches[0].title, 'Jane Doe');
  assert.equal(matches[0].normalizedType, 'delegate');
  assert.equal(matches[1].prefix, '- [ ] ');
  assert.equal(matches[1].title, 'Security Council');
  assert.equal(matches[2].prefix, '1. ');
  assert.equal(matches[2].title, 'Informal consultations');
});

test('applyInlineTypeReplacements swaps matched list lines', () => {
  const text = '- Jane Doe #delegate\n- [ ] Security Council #organ\n';
  const matches = findInlineTypeCandidates(text, new Set(['delegate', 'organ']));
  const replaced = applyInlineTypeReplacements(text, [
    { lineStart: matches[0].lineStart, lineEnd: matches[0].lineEnd, newLine: '- [[People/Jane Doe]]' },
    { lineStart: matches[1].lineStart, lineEnd: matches[1].lineEnd, newLine: '- [ ] [[Entities/Security Council]]' }
  ]);

  assert.equal(replaced, '- [[People/Jane Doe]]\n- [ ] [[Entities/Security Council]]\n');
});

test('sanitizeNoteTitle removes invalid path characters', () => {
  assert.equal(sanitizeNoteTitle('Jane / Doe: delegate?'), 'Jane Doe delegate');
});

test('extractDatePrefix normalizes date-like inputs', () => {
  assert.equal(extractDatePrefix('2026-04-06T10:00:00Z'), '2026-04-06');
  assert.equal(extractDatePrefix('2026/04/06'), '2026-04-06');
  assert.equal(extractDatePrefix('not a date'), null);
});

test('createRunStats initializes counters', () => {
  assert.equal(JSON.stringify(createRunStats()), JSON.stringify({
    scanned: 0,
    updated: 0,
    renamed: 0,
    moved: 0,
    backlinksAdded: 0,
    backlinksRemoved: 0,
    warnings: []
  }));
});
