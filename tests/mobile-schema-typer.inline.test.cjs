const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPluginHelpers } = require('./mobile-schema-typer.helpers.cjs');

function loadPluginModule() {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (id === 'obsidian') return require('./obsidian-stub.cjs');
      return require(id);
    },
    console,
    window: { setTimeout, clearTimeout },
    Date,
    JSON
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../obsidian-plugin/mobile-schema-typer/main.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'mobile-schema-typer.main.js' });
  return sandbox.module.exports;
}

const PluginClass = loadPluginModule();
const { parseSchemaFrontmatter } = loadPluginHelpers();

function makeFile(path, content) {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  const basename = name.replace(/\.md$/i, '');
  const parentPath = parts.slice(0, -1).join('/');
  return {
    path,
    name,
    basename,
    extension: 'md',
    parent: { path: parentPath }
  };
}

function makeApp(initialFiles = {}) {
  const files = new Map();
  const folders = new Set();

  for (const [path, content] of Object.entries(initialFiles)) {
    files.set(path, { file: makeFile(path, content), content });
  }

  const vault = {
    getMarkdownFiles() {
      return [...files.values()].map((entry) => entry.file);
    },
    getAbstractFileByPath(path) {
      return files.get(path)?.file || null;
    },
    async cachedRead(file) {
      return files.get(file.path)?.content || '';
    },
    async modify(file, content) {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing file: ${file.path}`);
      entry.content = content;
    },
    async createFolder(folderPath) {
      folders.add(folderPath);
    },
    async create(filePath, content) {
      const file = makeFile(filePath, content);
      files.set(filePath, { file, content });
      return file;
    }
  };

  const fileManager = {
    async renameFile(file, targetPath) {
      const entry = files.get(file.path);
      if (!entry) throw new Error(`Missing file: ${file.path}`);
      files.delete(file.path);
      const renamed = makeFile(targetPath, entry.content);
      files.set(targetPath, { file: renamed, content: entry.content });
      return renamed;
    }
  };

  return {
    vault,
    fileManager,
    workspace: { getActiveFile() { return null; } },
    _files: files,
    _folders: folders
  };
}

test('expandInlineTypesInFile creates typed notes and replaces shorthand with links', async () => {
  const app = makeApp({
    'Inbox/Test.md': 'Attendees:\n- Jane Doe #delegate\n- Security Council #organ\n'
  });

  const plugin = new PluginClass();
  plugin.app = app;
  plugin.settings = {
    enabled: true,
    runOnModify: false,
    debounceMs: 1200,
    schemasFolder: 'Schemas',
    excludedFolders: ['Attachments', 'Schemas', 'Templates'],
    archiveFolder: 'Archive',
    enableDatePrefixRename: false,
    verboseLogging: false,
    pruneManagedBacklinks: false
  };
  plugin.schemas = new Map([
    ['delegate', parseSchemaFrontmatter({ extends: '[[person]]', 'field.entity*': null, folder: '/People' }, { type: 'delegate' })],
    ['person', parseSchemaFrontmatter({ 'field.title': null, folder: '/People' }, { type: 'person' })],
    ['organ', parseSchemaFrontmatter({ extends: '[[entity]]', folder: '/Entities' }, { type: 'organ' })],
    ['entity', parseSchemaFrontmatter({ 'field.members': [], folder: '/Entities' }, { type: 'entity' })]
  ]);
  plugin.schemasDirty = false;
  plugin.schemasReady = true;
  plugin.runStats = { updated: 0, renamed: 0, moved: 0 };
  plugin.selfTouchedUntil = new Map();

  const file = app.vault.getAbstractFileByPath('Inbox/Test.md');
  const summary = await plugin.expandInlineTypesInFile(file);

  assert.equal(summary.replaced, 2);
  assert.equal(summary.created, 2);
  assert.equal(summary.reused, 0);

  const updated = app._files.get('Inbox/Test.md').content;
  assert.equal(updated, 'Attendees:\n- [[Jane Doe]]\n- [[Security Council]]\n');

  assert.equal(app._files.has('People/Jane Doe.md'), true);
  assert.equal(app._files.has('Entities/Security Council.md'), true);
  assert.match(app._files.get('People/Jane Doe.md').content, /type: delegate/);
  assert.match(app._files.get('Entities/Security Council.md').content, /type: organ/);
});

test('expandInlineTypesInFile reuses existing compatible notes and skips conflicting ones', async () => {
  const app = makeApp({
    'Inbox/Test.md': '- Jane Doe #delegate\n- Jane Doe #organ\n',
    'People/Jane Doe.md': '---\ntype: delegate\n---\n'
  });

  const plugin = new PluginClass();
  plugin.app = app;
  plugin.settings = {
    enabled: true,
    runOnModify: false,
    debounceMs: 1200,
    schemasFolder: 'Schemas',
    excludedFolders: ['Attachments', 'Schemas', 'Templates'],
    archiveFolder: 'Archive',
    enableDatePrefixRename: false,
    verboseLogging: false,
    pruneManagedBacklinks: false
  };
  plugin.schemas = new Map([
    ['delegate', parseSchemaFrontmatter({ folder: '/People' }, { type: 'delegate' })],
    ['organ', parseSchemaFrontmatter({ folder: '/Entities' }, { type: 'organ' })]
  ]);
  plugin.schemasDirty = false;
  plugin.schemasReady = true;
  plugin.runStats = { updated: 0, renamed: 0, moved: 0 };
  plugin.selfTouchedUntil = new Map();

  const file = app.vault.getAbstractFileByPath('Inbox/Test.md');
  const summary = await plugin.expandInlineTypesInFile(file);

  assert.equal(summary.replaced, 1);
  assert.equal(summary.created, 0);
  assert.equal(summary.reused, 1);
  assert.equal(summary.skipped, 1);

  const updated = app._files.get('Inbox/Test.md').content;
  assert.equal(updated, '- [[Jane Doe]]\n- Jane Doe #organ\n');
});
