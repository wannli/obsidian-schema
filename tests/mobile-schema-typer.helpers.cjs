const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPluginHelpers() {
  const pluginPath = path.resolve(__dirname, '../obsidian-plugin/mobile-schema-typer/main.js');
  const source = fs.readFileSync(pluginPath, 'utf8');
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (id === 'obsidian') return require('./obsidian-stub.cjs');
      return require(id);
    },
    console,
    window: {
      setTimeout,
      clearTimeout
    },
    Date,
    JSON
  };
  vm.runInNewContext(source, sandbox, { filename: pluginPath });
  return sandbox.module.exports._test;
}

module.exports = { loadPluginHelpers };
