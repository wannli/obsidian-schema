class Plugin {}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}
class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  addToggle(cb) { if (cb) cb({ setValue() { return { onChange() {} }; } }); return this; }
  addText(cb) { if (cb) cb({ setValue() { return { onChange() {} }; } }); return this; }
}
class Notice {
  constructor(message) {
    this.message = message;
  }
}
function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

module.exports = { Plugin, PluginSettingTab, Setting, Notice, normalizePath };
