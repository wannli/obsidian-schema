const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPluginHelpers } = require('./mobile-schema-typer.helpers.cjs');

const { parseSchemaFrontmatter } = loadPluginHelpers();

test('parseSchemaFrontmatter can use filename-derived type override', () => {
  const schema = parseSchemaFrontmatter(
    {
      type: 'colleague',
      extends: '[[person]]',
      'field.entity*': null,
      'pair.entity': 'entity.members'
    },
    { type: 'delegate' }
  );

  assert.equal(schema.type, 'delegate');
  assert.equal(schema.extends, 'person');
  assert.equal(schema.required.has('entity'), true);
  assert.equal(schema.pairRulesByField.entity.targetType, 'entity');
  assert.equal(schema.pairRulesByField.entity.targetField, 'members');
});
