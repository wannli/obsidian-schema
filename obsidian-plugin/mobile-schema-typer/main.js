const { Plugin, PluginSettingTab, Setting, normalizePath } = require("obsidian");

const TERMINAL_STATUSES = new Set(["done", "superseded", "cancelled"]);

const DEFAULT_SETTINGS = {
  enabled: true,
  runOnModify: false,
  debounceMs: 1200,
  schemasFolder: "Schemas",
  excludedFolders: ["Attachments", "Schemas", "Templates"],
  archiveFolder: "Archive",
  enableDatePrefixRename: false
};

module.exports = class MobileSchemaTyperPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.schemas = new Map();
    this.folderTypeMap = new Map();
    this.runTimer = null;
    this.running = false;
    this.pendingRun = false;
    this.pendingPaths = new Set();
    this.selfTouchedUntil = new Map();

    this.addSettingTab(new MobileSchemaTyperSettingTab(this.app, this));
    this.addCommand({
      id: "mobile-schema-typer-run-now",
      name: "Run schema fix now",
      callback: () => this.scheduleRun(null)
    });

    await this.refreshSchemas();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.enabled || !this.settings.runOnModify || !file || file.extension !== "md") return;
        if (this.isExcludedPath(file.path)) return;
        if (this.isSelfTouch(file.path)) return;

        if (this.isSchemaFile(file.path)) {
          this.scheduleSchemaRefresh();
          return;
        }
        this.scheduleRun(file.path);
      })
    );
  }

  onunload() {
    this.clearRunTimer();
  }

  scheduleSchemaRefresh() {
    window.setTimeout(() => this.refreshSchemas(), 300);
  }

  scheduleRun(filePath) {
    if (filePath) this.pendingPaths.add(filePath);
    this.clearRunTimer();
    const debounceMs = Math.max(250, Number(this.settings.debounceMs) || 1200);
    this.runTimer = window.setTimeout(() => {
      this.runTimer = null;
      this.runOnce();
    }, debounceMs);
  }

  clearRunTimer() {
    if (this.runTimer) {
      window.clearTimeout(this.runTimer);
      this.runTimer = null;
    }
  }

  isSchemaFile(filePath) {
    const root = this.cleanFolder(this.settings.schemasFolder);
    const p = this.normalizeVaultPath(filePath);
    return p === root || p.startsWith(`${root}/`);
  }

  isExcludedPath(filePath) {
    const p = this.normalizeVaultPath(filePath);
    if (p.endsWith(".base")) return true;
    if (p.startsWith(".obsidian/")) return true;
    return this.settings.excludedFolders.some((folder) => {
      const clean = this.cleanFolder(folder);
      if (!clean) return false;
      return p === clean || p.startsWith(`${clean}/`);
    });
  }

  cleanFolder(folder) {
    return String(folder || "").trim().replace(/^\/+|\/+$/g, "");
  }

  normalizeVaultPath(filePath) {
    return String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  }

  markSelfTouch(filePath) {
    this.selfTouchedUntil.set(filePath, Date.now() + 3000);
  }

  isSelfTouch(filePath) {
    const until = this.selfTouchedUntil.get(filePath);
    if (!until) return false;
    if (Date.now() > until) {
      this.selfTouchedUntil.delete(filePath);
      return false;
    }
    return true;
  }

  async refreshSchemas() {
    const schemaRoot = this.cleanFolder(this.settings.schemasFolder);
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.normalizeVaultPath(f.path).startsWith(`${schemaRoot}/`));

    const nextSchemas = new Map();
    const nextFolderTypeMap = new Map();

    for (const file of files) {
      const text = await this.app.vault.cachedRead(file);
      const fm = parseFrontmatter(text);
      if (!fm || typeof fm.type !== "string" || !fm.type.trim()) continue;
      const schema = parseSchemaFrontmatter(fm);
      nextSchemas.set(schema.type, schema);
      if (schema.folder) {
        const folderKey = this.cleanFolder(schema.folder);
        if (folderKey) nextFolderTypeMap.set(folderKey, schema.type);
      }
    }

    this.schemas = nextSchemas;
    this.folderTypeMap = nextFolderTypeMap;
  }

  async runOnce() {
    if (this.running) {
      this.pendingRun = true;
      return;
    }
    this.running = true;
    try {
      await this.refreshSchemas();
      const files = this.pendingPaths.size > 0
        ? [...this.pendingPaths]
            .map((p) => this.app.vault.getAbstractFileByPath(p))
            .filter((f) => f && f.extension === "md" && !this.isExcludedPath(f.path))
        : this.app.vault.getMarkdownFiles().filter((f) => !this.isExcludedPath(f.path));
      this.pendingPaths.clear();
      for (const file of files) {
        await this.applySchemaToFile(file);
      }
    } finally {
      this.running = false;
      if (this.pendingRun) {
        this.pendingRun = false;
        this.scheduleRun(null);
      }
    }
  }

  inferType(file) {
    const folder = this.cleanFolder(file.parent?.path || "");
    if (folder && this.folderTypeMap.has(folder)) return this.folderTypeMap.get(folder);
    const firstSegment = folder.split("/")[0] || "";
    if (this.folderTypeMap.has(firstSegment)) return this.folderTypeMap.get(firstSegment);
    return null;
  }

  resolveSchema(type) {
    if (!type || !this.schemas.has(type)) return null;
    const chain = [];
    const seen = new Set();
    let current = this.schemas.get(type);
    while (current && !seen.has(current.type)) {
      seen.add(current.type);
      chain.push(current);
      current = current.extends ? this.schemas.get(current.extends) : null;
    }
    chain.reverse();
    const merged = { type, fields: new Map(), required: new Set(), folder: null, prependDateToTitle: false };
    for (const schema of chain) {
      if (schema.folder) merged.folder = schema.folder;
      if (schema.prependDateToTitle) merged.prependDateToTitle = true;
      for (const [k, v] of schema.fields.entries()) merged.fields.set(k, v);
      for (const req of schema.required.values()) merged.required.add(req);
    }
    return merged;
  }

  async applySchemaToFile(file) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      let type = typeof fm.type === "string" ? fm.type.trim() : "";
      if (!type) {
        const inferred = this.inferType(file);
        if (inferred) {
          fm.type = inferred;
          type = inferred;
        }
      }

      const resolved = this.resolveSchema(type);
      if (!resolved) return;

      for (const [field, def] of resolved.fields.entries()) {
        const hasField = Object.prototype.hasOwnProperty.call(fm, field);
        if (!hasField && resolved.required.has(field)) {
          fm[field] = defaultValueForMissing(def);
        } else if (!hasField && def.defaultDefined) {
          fm[field] = cloneValue(def.defaultValue);
        }
      }

      if (resolved.required.has("type") && !fm.type) {
        fm.type = type || "";
      }
    });

    const latest = this.app.vault.getAbstractFileByPath(file.path) || file;
    if (!latest || !latest.path) return;
    let currentFile = latest;
    const text = await this.app.vault.cachedRead(currentFile);
    const fm = parseFrontmatter(text) || {};
    const type = typeof fm.type === "string" ? fm.type.trim() : "";
    const resolved = this.resolveSchema(type);
    if (!resolved) return;

    if (this.settings.enableDatePrefixRename && resolved.prependDateToTitle) {
      const datePrefix = extractDatePrefix(fm.date);
      if (datePrefix) {
        const baseName = currentFile.basename;
        const alreadyPrefixed = baseName === datePrefix || baseName.startsWith(`${datePrefix} `);
        if (!alreadyPrefixed) {
          const targetPath = normalizePath(`${currentFile.parent.path}/${datePrefix} ${baseName}.md`);
          if (!(await this.exists(targetPath))) {
            await this.app.fileManager.renameFile(currentFile, targetPath);
            this.markSelfTouch(targetPath);
            currentFile = this.app.vault.getAbstractFileByPath(targetPath);
          }
        }
      }
    }

    const targetFolder = this.targetFolderForNote(fm, resolved);
    if (targetFolder) {
      const normalizedTarget = this.cleanFolder(targetFolder);
      const parentPath = this.cleanFolder(currentFile.parent?.path || "");
      if (normalizedTarget && normalizedTarget !== parentPath) {
        const targetPath = normalizePath(`${normalizedTarget}/${currentFile.name}`);
        if (!(await this.exists(targetPath))) {
          await this.app.vault.createFolder(normalizedTarget).catch(() => {});
          await this.app.fileManager.renameFile(currentFile, targetPath);
          this.markSelfTouch(targetPath);
        }
      }
    }
  }

  targetFolderForNote(frontmatter, resolvedSchema) {
    const status = String(frontmatter?.status || "").trim().toLowerCase();
    if (TERMINAL_STATUSES.has(status)) return this.settings.archiveFolder;
    return resolvedSchema.folder || null;
  }

  async exists(filePath) {
    const found = this.app.vault.getAbstractFileByPath(filePath);
    return Boolean(found);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class MobileSchemaTyperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enabled")
      .setDesc("Run schema autofix on markdown file changes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Run on modify")
      .setDesc("Automatically run on file save/modify. Turn off to run only via command.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.runOnModify).onChange(async (value) => {
          this.plugin.settings.runOnModify = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Wait after edits before running.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
          const parsed = Number(value);
          this.plugin.settings.debounceMs = Number.isFinite(parsed) ? parsed : 1200;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Schemas folder")
      .setDesc("Folder containing schema markdown files.")
      .addText((text) =>
        text.setValue(this.plugin.settings.schemasFolder).onChange(async (value) => {
          this.plugin.settings.schemasFolder = value.trim() || "Schemas";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folders to ignore.")
      .addText((text) =>
        text.setValue(this.plugin.settings.excludedFolders.join(", ")).onChange(async (value) => {
          this.plugin.settings.excludedFolders = value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Archive folder")
      .setDesc("Target folder when status is done/superseded/cancelled.")
      .addText((text) =>
        text.setValue(this.plugin.settings.archiveFolder).onChange(async (value) => {
          this.plugin.settings.archiveFolder = value.trim() || "Archive";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Enable date prefix rename")
      .setDesc("If enabled, prepend YYYY-MM-DD to title when schema requests it.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableDatePrefixRename).onChange(async (value) => {
          this.plugin.settings.enableDatePrefixRename = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

function parseFrontmatter(text) {
  if (!text || !text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const lines = block.split("\n");
  const out = {};
  let currentArrayKey = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (currentArrayKey && /^\s*-\s*/.test(line)) {
      out[currentArrayKey].push(parseScalar(line.replace(/^\s*-\s*/, "")));
      continue;
    }
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) {
      currentArrayKey = null;
      continue;
    }
    const key = String(match[1]).trim();
    const raw = String(match[2]).trim();
    if (raw === "") {
      out[key] = "";
      currentArrayKey = null;
      continue;
    }
    if (raw === "[]") {
      out[key] = [];
      currentArrayKey = key;
      continue;
    }
    out[key] = parseScalar(raw);
    currentArrayKey = null;
  }
  return out;
}

function parseScalar(value) {
  const v = String(value || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseSchemaFrontmatter(fm) {
  const reserved = new Set(["type", "extends", "folder", "purpose", "prependDateToTitle"]);
  const required = new Set(["type"]);
  const fields = new Map();
  const explicitDefaults = new Map();

  for (const [rawKey, rawValue] of Object.entries(fm)) {
    const key = String(rawKey).trim();
    if (!key) continue;
    const baseKey = key.endsWith("*") ? key.slice(0, -1) : key;
    if (baseKey.startsWith("default.")) {
      const defaultKey = baseKey.slice("default.".length);
      if (defaultKey && !defaultKey.includes(".")) {
        explicitDefaults.set(defaultKey, cloneValue(rawValue));
      }
      continue;
    }
    const normalized = normalizeSchemaKey(key);
    if (!normalized) continue;
    if (normalized.required) required.add(normalized.name);
    if (reserved.has(normalized.name)) continue;
    fields.set(normalized.name, parseFieldDefinition(rawValue));
  }

  for (const [key, value] of explicitDefaults.entries()) {
    if (!fields.has(key)) {
      fields.set(key, fieldDefinitionFromDefault(value));
    }
    if (value !== null) {
      const next = fields.get(key);
      next.defaultDefined = true;
      next.defaultValue = cloneValue(value);
      fields.set(key, next);
    }
  }

  return {
    type: String(fm.type || "").trim(),
    extends: parseSimpleWikiLinkRef(fm.extends),
    folder: String(fm.folder || "").trim().replace(/^\/+|\/+$/g, "") || null,
    prependDateToTitle: parseOptionalBool(fm.prependDateToTitle),
    required,
    fields
  };
}

function normalizeSchemaKey(key) {
  let k = String(key || "").trim();
  if (!k) return null;
  let required = false;
  if (k.endsWith("*")) {
    required = true;
    k = k.slice(0, -1);
  }
  if (k.startsWith("field.")) {
    k = k.slice("field.".length);
  }
  if (!k) return null;
  return { name: k, required };
}

function parseSimpleWikiLinkRef(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const m = trimmed.match(/^\[\[([^\]|#]+)\]\]$/);
  if (!m) return null;
  return m[1].trim() || null;
}

function parseOptionalBool(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return undefined;
}

function parseFieldDefinition(value) {
  if (value === null) {
    return { kind: "value", defaultDefined: false, defaultValue: "" };
  }
  if (Array.isArray(value)) {
    const clean = value.map((v) => String(v).trim()).filter(Boolean);
    if (clean.length > 1) {
      return { kind: "array-enum", enumValues: clean, defaultDefined: false, defaultValue: [] };
    }
    return { kind: "array", defaultDefined: false, defaultValue: [] };
  }
  if (typeof value === "string" && value.includes(",")) {
    const clean = value.split(",").map((v) => v.trim()).filter(Boolean);
    return { kind: "string-enum", enumValues: clean, defaultDefined: false, defaultValue: "" };
  }
  if (value === "") {
    return { kind: "string", defaultDefined: false, defaultValue: "" };
  }
  return { kind: "value", defaultDefined: false, defaultValue: "" };
}

function fieldDefinitionFromDefault(value) {
  if (Array.isArray(value)) return { kind: "array", defaultDefined: true, defaultValue: cloneValue(value) };
  if (typeof value === "string") return { kind: "string", defaultDefined: true, defaultValue: value };
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "value", defaultDefined: true, defaultValue: value };
  }
  if (value === null) return { kind: "value", defaultDefined: false, defaultValue: "" };
  return { kind: "value", defaultDefined: true, defaultValue: cloneValue(value) };
}

function defaultValueForMissing(def) {
  if (!def) return "";
  if (def.defaultDefined) return cloneValue(def.defaultValue);
  if (def.kind === "array" || def.kind === "array-enum") return [];
  return "";
}

function cloneValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

function extractDatePrefix(dateValue) {
  if (!dateValue) return null;
  if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
    return dateValue.toISOString().slice(0, 10);
  }
  const s = String(dateValue).trim();
  let m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  m = s.match(/^(\d{4})[\/.](\d{2})[\/.](\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}
