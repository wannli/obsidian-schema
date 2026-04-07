const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPluginHelpers } = require('./mobile-schema-typer.helpers.cjs');

const {
  parseFrontmatter,
  parseScalar,
  parsePairValue,
  parseLinkPairValue,
  parseOptionalBool,
  parseFieldDefinition,
  fieldDefinitionFromDefault,
  defaultValueForMissing,
  normalizeWikiLinkValue,
  parseWikiLinkTarget,
  extractLinkTargets,
  normalizeTitleKey,
  cloneValue
} = loadPluginHelpers();

test('parseFrontmatter reads simple YAML-like frontmatter', () => {
  const fm = parseFrontmatter(`---
type: meeting
tags: []
- alpha
- beta
count: 3
active: true
---
body`);

  assert.equal(fm.type, 'meeting');
  assert.equal(JSON.stringify(fm.tags), JSON.stringify(['alpha', 'beta']));
  assert.equal(fm.count, 3);
  assert.equal(fm.active, true);
});

test('parseScalar handles quotes, booleans, nulls, and numbers', () => {
  assert.equal(parseScalar('"hello"'), 'hello');
  assert.equal(parseScalar("'hello'"), 'hello');
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('false'), false);
  assert.equal(parseScalar('null'), null);
  assert.equal(parseScalar('42'), 42);
  assert.equal(parseScalar('3.14'), 3.14);
  assert.equal(parseScalar('plain'), 'plain');
});

test('pair parsers support directional and legacy formats', () => {
  assert.equal(JSON.stringify(parsePairValue('project.meetings')), JSON.stringify({ targetType: 'project', targetField: 'meetings' }));
  assert.equal(JSON.stringify(parseLinkPairValue('employer <-> employees')), JSON.stringify({ left: 'employer', right: 'employees' }));
  assert.equal(parsePairValue('invalid'), null);
});

test('parseOptionalBool supports friendly truthy and falsy values', () => {
  assert.equal(parseOptionalBool(true), true);
  assert.equal(parseOptionalBool('yes'), true);
  assert.equal(parseOptionalBool('0'), false);
  assert.equal(parseOptionalBool('maybe'), undefined);
});

test('field definition helpers infer kinds and defaults', () => {
  assert.equal(parseFieldDefinition([]).kind, 'array');
  assert.equal(parseFieldDefinition(['a', 'b']).kind, 'array-enum');
  assert.equal(parseFieldDefinition('draft,done').kind, 'string-enum');
  assert.equal(parseFieldDefinition('').kind, 'string');
  assert.equal(fieldDefinitionFromDefault(['x']).kind, 'array');
  assert.equal(JSON.stringify(defaultValueForMissing({ kind: 'array', defaultDefined: false })), JSON.stringify([]));
  assert.equal(defaultValueForMissing({ kind: 'string', defaultDefined: false }), '');
});

test('wikilink helpers normalize and extract targets', () => {
  assert.equal(normalizeWikiLinkValue('Note'), '[[Note]]');
  assert.equal(normalizeWikiLinkValue('[[Note|Alias]]'), '[[Note]]');
  assert.equal(parseWikiLinkTarget('[[Folder/Note#Heading|Alias]]'), 'Folder/Note');
  assert.equal(JSON.stringify(extractLinkTargets(['Note', '[[Other]]'])), JSON.stringify(['[[Note]]', '[[Other]]']));
  assert.equal(normalizeTitleKey('  Mixed Case  '), 'mixed case');
});

test('cloneValue clones arrays and objects without retaining identity', () => {
  const arr = ['a'];
  const arrClone = cloneValue(arr);
  arrClone.push('b');
  assert.equal(JSON.stringify(arr), JSON.stringify(['a']));

  const obj = { a: 1, nested: { b: 2 } };
  const objClone = cloneValue(obj);
  objClone.nested.b = 3;
  assert.equal(obj.nested.b, 2);
});
