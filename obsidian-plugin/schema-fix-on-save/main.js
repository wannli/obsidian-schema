const { Plugin, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("node:child_process");

const DEFAULT_SETTINGS = {
  enabled: true,
  nodePath: "/Users/wannli/.local/share/mise/installs/node/22.22.0/bin/node",
  cliPath: "/Users/wannli/Code/obsidian-typing/src/cli.mjs",
  reportDir: "/Users/wannli/Code/obsidian-typing/reports",
  debounceMs: 2000,
  excludedFolders: ["Attachments", "Schemas", "Templates"]
};

module.exports = class SchemaFixOnSavePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.runTimer = null;
    this.running = false;
    this.rerunRequested = false;
    this.lastReason = "startup";

    this.addSettingTab(new SchemaFixOnSaveSettingsTab(this.app, this));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.enabled) return;
        if (!file || file.extension !== "md") return;
        if (this.isExcludedPath(file.path)) return;
        this.scheduleRun(file.path);
      })
    );
  }

  onunload() {
    this.clearRunTimer();
  }

  scheduleRun(reasonPath) {
    this.lastReason = reasonPath || "unknown";
    this.clearRunTimer();
    this.runTimer = window.setTimeout(() => {
      this.runTimer = null;
      this.runFix();
    }, Math.max(300, Number(this.settings.debounceMs) || 2000));
  }

  clearRunTimer() {
    if (this.runTimer) {
      window.clearTimeout(this.runTimer);
      this.runTimer = null;
    }
  }

  isExcludedPath(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/");
    return this.settings.excludedFolders.some((folder) => {
      const clean = String(folder || "").trim().replace(/^\/+|\/+$/g, "");
      if (!clean) return false;
      return normalized === clean || normalized.startsWith(`${clean}/`);
    });
  }

  async runFix() {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    const vaultPath = this.app.vault.adapter.basePath;
    if (!vaultPath) return;

    this.running = true;
    const args = [
      this.settings.cliPath,
      "fix",
      "--vault",
      vaultPath,
      "--report-dir",
      this.settings.reportDir
    ];

    const child = execFile(this.settings.nodePath, args, { timeout: 180000 }, () => {

      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.scheduleRun("queued");
      }
    });

    child.unref();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class SchemaFixOnSaveSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enable on-save fix")
      .setDesc("Run schema fix after markdown file modifications.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Node binary path")
      .setDesc("Absolute path to node executable.")
      .addText((text) =>
        text.setValue(this.plugin.settings.nodePath).onChange(async (value) => {
          this.plugin.settings.nodePath = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("CLI script path")
      .setDesc("Absolute path to src/cli.mjs.")
      .addText((text) =>
        text.setValue(this.plugin.settings.cliPath).onChange(async (value) => {
          this.plugin.settings.cliPath = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Report directory")
      .setDesc("Where schema reports are written.")
      .addText((text) =>
        text.setValue(this.plugin.settings.reportDir).onChange(async (value) => {
          this.plugin.settings.reportDir = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debounce milliseconds")
      .setDesc("Wait time after save events before running.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.debounceMs = Number.isFinite(parsed) ? parsed : 2000;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder names to ignore.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

  }
}
