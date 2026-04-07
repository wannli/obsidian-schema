const { Plugin, PluginSettingTab, Setting, Notice, normalizePath } = require("obsidian");

const TERMINAL_STATUSES = new Set(["done", "superseded", "cancelled"]);

const DEFAULT_SETTINGS = {
  enabled: true,
  runOnModify: false,
  debounceMs: 1200,
  schemasFolder: "Schemas",
  excludedFolders: ["Attachments", "Schemas", "Templates"],
  archiveFolder: "Archive",
  enableDatePrefixRename: false,
  verboseLogging: false,
  pruneManagedBacklinks: false
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
    this.fullRunRequested = false;
    this.schemasDirty = true;
    this.selfTouchedUntil = new Map();
    this.lastRunMode = "background";
    this.runStats = createRunStats();

    this.addSettingTab(new MobileSchemaTyperSettingTab(this.app, this));
    this.addCommand({
      id: "mobile-schema-typer-run-now",
      name: "Run schema fix now",
      callback: () => {
        new Notice("MST command: run schema fix now");
        this.scheduleRun({ full: true, mode: "manual" });
      }
    });

    this.addCommand({
      id: "mobile-schema-typer-run-current-file",
      name: "Run schema fix on current file",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") {
          new Notice("No active markdown file");
          return;
        }
        new Notice(`MST command: current file ${file.path}`);
        this.scheduleRun({ filePath: file.path, mode: "manual" });
      }
    });

    this.addCommand({
      id: "mobile-schema-typer-backlink-sync-now",
      name: "Rebuild backlinks now",
      callback: async () => {
        await this.ensureSchemasFresh();
        const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcludedPath(f.path));
        this.runStats = createRunStats();
        await this.runBacklinkSync(files);
        this.showRunSummary("manual", { backlinkOnly: true });
      }
    });

    this.addCommand({
      id: "mobile-schema-typer-preview-run",
      name: "Preview schema fix summary",
      callback: async () => {
        await this.ensureSchemasFresh();
        const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcludedPath(f.path));
        new Notice(`Mobile Schema Typer would scan ${files.length} markdown files.`);
      }
    });

    await this.ensureSchemasFresh();
    new Notice(`MST loaded (${this.schemas.size} schemas)`);

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.enabled || !this.settings.runOnModify || !file || file.extension !== "md") return;
        this.handleMarkdownEvent("modify", file);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!this.settings.enabled || !this.settings.runOnModify || !file || file.extension !== "md") return;
        this.handleMarkdownEvent("create", file);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!this.settings.enabled || !file || file.extension !== "md") return;
        this.handleMarkdownDelete(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.settings.enabled || !file || file.extension !== "md") return;
        this.handleMarkdownRename(file, oldPath);
      })
    );
  }

  onunload() {
    this.clearRunTimer();
  }

  scheduleSchemaRefresh() {
    this.schemasDirty = true;
    window.setTimeout(() => this.ensureSchemasFresh(), 300);
  }

  validateSettings() {
    const next = Object.assign({}, this.settings);
    next.schemasFolder = this.cleanFolder(next.schemasFolder) || "Schemas";
    next.archiveFolder = this.cleanFolder(next.archiveFolder) || "Archive";
    next.debounceMs = Math.max(250, Number(next.debounceMs) || 1200);
    next.excludedFolders = Array.isArray(next.excludedFolders)
      ? next.excludedFolders.map((folder) => this.cleanFolder(folder)).filter(Boolean)
      : DEFAULT_SETTINGS.excludedFolders;
    next.pruneManagedBacklinks = Boolean(next.pruneManagedBacklinks);
    this.settings = next;
  }

  handleMarkdownEvent(_eventName, file) {
    if (this.settings.verboseLogging) new Notice(`MST event ${_eventName}: ${file?.path || "unknown"}`);
    if (!file || this.isExcludedPath(file.path) || this.isSelfTouch(file.path)) return;

    if (this.isSchemaFile(file.path)) {
      this.scheduleSchemaRefresh();
      this.scheduleRun({ full: true });
      return;
    }

    this.scheduleRun({ filePath: file.path });
  }

  handleMarkdownDelete(file) {
    if (!file) return;
    if (this.isSchemaFile(file.path)) {
      this.scheduleSchemaRefresh();
      this.scheduleRun({ full: true });
    }
  }

  handleMarkdownRename(file, oldPath) {
    if (!file || this.isExcludedPath(file.path) || this.isSelfTouch(file.path)) return;

    const oldWasSchema = this.isSchemaFile(oldPath);
    const newIsSchema = this.isSchemaFile(file.path);
    if (oldWasSchema || newIsSchema) {
      this.scheduleSchemaRefresh();
      this.scheduleRun({ full: true });
      return;
    }

    this.scheduleRun({ filePath: file.path });
  }

  scheduleRun({ filePath = null, full = false, mode = "background" } = {}) {
    if (filePath) this.pendingPaths.add(filePath);
    if (full) this.fullRunRequested = true;
    this.lastRunMode = mode;
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

  async ensureSchemasFresh() {
    if (!this.schemasDirty) return;
    await this.refreshSchemas();
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
      if (!fm) continue;
      const inferredType = normalizeTypeKey(file.basename);
      if (!inferredType) continue;
      const schema = parseSchemaFrontmatter(fm, { type: inferredType });
      const frontmatterType = normalizeTypeKey(fm.type);
      if (frontmatterType && frontmatterType !== inferredType) {
        this.recordWarning(
          `Schema file '${file.path}' declares type '${frontmatterType}' but filename implies '${inferredType}'`
        );
      }
      const schemaKey = inferredType;
      schema.type = schemaKey;
      schema.extends = normalizeTypeKey(schema.extends);
      nextSchemas.set(schemaKey, schema);
      if (schema.folder) {
        const folderKey = this.cleanFolder(schema.folder);
        if (folderKey) nextFolderTypeMap.set(folderKey, schemaKey);
      }
    }

    this.schemas = nextSchemas;
    this.folderTypeMap = nextFolderTypeMap;
    this.schemasDirty = false;
    if (this.settings.verboseLogging) new Notice(`MST schemas refreshed: ${this.schemas.size}`);
  }

  async runOnce() {
    if (this.running) {
      this.pendingRun = true;
      return;
    }
    this.running = true;
    this.runStats = createRunStats();
    const runMode = this.lastRunMode;
    try {
      await this.ensureSchemasFresh();
      const runFull = this.fullRunRequested || this.pendingPaths.size === 0;
      const files = runFull
        ? this.app.vault.getMarkdownFiles().filter((f) => !this.isExcludedPath(f.path))
        : [...this.pendingPaths]
            .map((p) => this.app.vault.getAbstractFileByPath(p))
            .filter((f) => f && f.extension === "md" && !this.isExcludedPath(f.path));
      this.pendingPaths.clear();
      this.fullRunRequested = false;
      this.runStats.scanned = files.length;
      for (const file of files) {
        await this.applySchemaToFile(file);
      }
      await this.runBacklinkSync(files);
      this.showRunSummary(runMode);
    } finally {
      this.running = false;
      this.lastRunMode = "background";
      if (this.pendingRun) {
        this.pendingRun = false;
        this.scheduleRun();
      }
    }
  }

  inferType(file) {
    const folder = this.cleanFolder(file.parent?.path || "");
    if (folder && this.folderTypeMap.has(folder)) return this.folderTypeMap.get(folder);
    const firstSegment = folder.split("/")[0] || "";
    if (this.folderTypeMap.has(firstSegment)) return this.folderTypeMap.get(firstSegment);
    const segments = folder.split("/").filter(Boolean);
    while (segments.length > 1) {
      segments.pop();
      const ancestor = segments.join("/");
      if (this.folderTypeMap.has(ancestor)) return this.folderTypeMap.get(ancestor);
    }
    return null;
  }

  resolveSchema(type) {
    const typeKey = normalizeTypeKey(type);
    if (!typeKey || !this.schemas.has(typeKey)) return null;
    const chain = [];
    const seen = new Set();
    let current = this.schemas.get(typeKey);
    while (current && !seen.has(current.type)) {
      seen.add(current.type);
      chain.push(current);
      current = current.extends ? this.schemas.get(current.extends) : null;
    }
    chain.reverse();
    const merged = {
      type: typeKey,
      fields: new Map(),
      required: new Set(),
      folder: null,
      prependDateToTitle: false,
      pairRulesByField: {}
    };
    for (const schema of chain) {
      if (schema.folder) merged.folder = schema.folder;
      if (schema.prependDateToTitle) merged.prependDateToTitle = true;
      for (const [k, v] of schema.fields.entries()) merged.fields.set(k, v);
      for (const req of schema.required.values()) merged.required.add(req);
      for (const [field, rule] of Object.entries(schema.pairRulesByField || {})) {
        merged.pairRulesByField[field] = cloneValue(rule);
      }
    }
    merged.pairRules = Object.values(merged.pairRulesByField);
    return merged;
  }

  async applySchemaToFile(file) {
    if (this.settings.verboseLogging) new Notice(`MST apply ${file.path}`);
    const text = await this.app.vault.cachedRead(file);
    const parsed = parseMarkdownWithFrontmatter(text);
    const fm = cloneValue(parsed.frontmatter || {});

    let type = typeof fm.type === "string" ? fm.type.trim() : "";
    let frontmatterChanged = false;
    if (!type) {
      const inferred = this.inferType(file);
      if (inferred) {
        fm.type = inferred;
        type = inferred;
        frontmatterChanged = true;
      }
    }

    type = normalizeTypeKey(type);
    if (type && fm.type !== type) {
      fm.type = type;
      frontmatterChanged = true;
    }

    const resolved = this.resolveSchema(type);
    if (!resolved) return;

    for (const [field, def] of resolved.fields.entries()) {
      const hasField = Object.prototype.hasOwnProperty.call(fm, field);
      if (!hasField && resolved.required.has(field)) {
        fm[field] = defaultValueForMissing(def);
        frontmatterChanged = true;
      } else if (!hasField && def.defaultDefined) {
        fm[field] = cloneValue(def.defaultValue);
        frontmatterChanged = true;
      }
    }

    if (resolved.required.has("type") && !fm.type) {
      fm.type = type || "";
      frontmatterChanged = true;
    }

    if (frontmatterChanged) {
      const nextText = stringifyMarkdownWithFrontmatter(fm, parsed.body);
      if (nextText !== text) {
        await this.app.vault.modify(file, nextText);
        this.markSelfTouch(file.path);
        this.runStats.updated += 1;
        new Notice(`MST updated ${file.path}`);
      } else if (this.settings.verboseLogging) {
        new Notice(`MST no-op ${file.path}`);
      }
    }

    const latest = this.app.vault.getAbstractFileByPath(file.path) || file;
    if (!latest || !latest.path) return;
    let currentFile = latest;

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
            this.runStats.renamed += 1;
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
          this.runStats.moved += 1;
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

  async readFreshFrontmatterForFile(file) {
    if (!file) return null;
    const text = await this.app.vault.cachedRead(file);
    return parseFrontmatter(text);
  }

  async runBacklinkSync(files) {
    const notes = [];

    for (const file of files) {
      if (!file || file.extension !== "md") continue;
      const fm = (await this.readFreshFrontmatterForFile(file)) || {};
      const type = typeof fm.type === "string" ? fm.type.trim() : "";
      const schema = this.resolveSchema(type);
      if (!schema || !Array.isArray(schema.pairRules) || schema.pairRules.length === 0) continue;
      const title = String(file.basename || "").trim();
      const note = { file, frontmatter: fm, schema, title };
      notes.push(note);
    }

    const planned = new Map();
    const dedupe = new Set();
    const managedFieldsByTarget = new Map();
    for (const source of notes) {
      for (const rule of source.schema.pairRules) {
        this.planBacklinkDirection({
          source,
          sourceField: rule.sourceField,
          targetType: rule.targetType,
          targetField: rule.targetField,
          descriptor: rule.descriptor || `pair.${rule.sourceField}`,
          planned,
          dedupe,
          managedFieldsByTarget
        });
      }
    }

    for (const [targetPath, ops] of planned.entries()) {
      const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!targetFile || targetFile.extension !== "md") continue;
      let changed = false;
      const managedFields = managedFieldsByTarget.get(targetPath) || new Set();
      const targetNote = notes.find((note) => note.file.path === targetPath);
      await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
        if (this.settings.pruneManagedBacklinks) {
          for (const field of managedFields) {
            const fieldOps = ops.filter((op) => op.field === field);
            const schemaDef = targetNote?.schema?.fields?.get(field);
            const currentValue = fm[field];
            const containerKind = fieldContainerKind(schemaDef, currentValue);
            const desiredLinks = fieldOps.map((op) => op.link);
            const pruneRes = pruneManagedInverseLinks({
              frontmatter: fm,
              field,
              desiredLinks,
              containerKind
            });
            if (!pruneRes.ok) {
              this.recordWarning(`${pruneRes.message} (${field})`);
            } else {
              changed = changed || pruneRes.changed;
              if (pruneRes.changed) this.runStats.backlinksRemoved += pruneRes.removedCount;
            }
          }
        }

        for (const op of ops) {
          const res = addInverseLink({
            frontmatter: fm,
            field: op.field,
            link: op.link,
            containerKind: op.containerKind
          });
          if (!res.ok) {
            this.recordWarning(`${res.message} (${op.descriptor})`);
            continue;
          }
          changed = changed || res.changed;
        }
      });
      if (changed) {
        this.markSelfTouch(targetPath);
        this.runStats.backlinksAdded += 1;
      }
    }
  }

  planBacklinkDirection({ source, sourceField, targetType, targetField, descriptor, planned, dedupe, managedFieldsByTarget }) {
    const links = extractLinkTargets(source.frontmatter[sourceField]);
    for (const link of links) {
      const target = this.resolveBacklinkTarget(link, source.file.path, descriptor);
      if (!target) continue;
      if (targetType && !typeMatchesOrExtends(target.frontmatter.type, targetType, this.schemas)) {
        this.recordWarning(
          `Backlink target '${target.file.path}' type mismatch for '${source.file.path}' (${descriptor})`
        );
        continue;
      }
      const containerKind = fieldContainerKind(target.schema?.fields?.get(targetField), target.frontmatter[targetField]);
      if (containerKind === "unknown") {
        this.recordWarning(
          `Cannot infer container type for '${targetField}' on '${target.file.path}' (${descriptor})`
        );
        continue;
      }
      const sourceLink = buildWikiLinkToFile(source.file);
      const opKey = `${target.file.path}::${targetField}::${normalizeTitleKey(source.file.path)}`;
      if (dedupe.has(opKey)) continue;
      dedupe.add(opKey);
      if (!planned.has(target.file.path)) planned.set(target.file.path, []);
      if (!managedFieldsByTarget.has(target.file.path)) managedFieldsByTarget.set(target.file.path, new Set());
      managedFieldsByTarget.get(target.file.path).add(targetField);
      planned.get(target.file.path).push({
        field: targetField,
        link: sourceLink,
        containerKind,
        descriptor
      });
    }
  }

  resolveBacklinkTarget(link, sourcePath, descriptor) {
    const targetRef = parseWikiLinkTarget(link);
    if (!targetRef) return null;

    const destination = this.app.metadataCache.getFirstLinkpathDest(targetRef, sourcePath);
    if (!destination || destination.extension !== "md") {
      this.recordWarning(
        `Unresolved backlink target '${targetRef}' from '${sourcePath}' (${descriptor})`
      );
      return null;
    }

    const cache = this.app.metadataCache.getFileCache(destination);
    const fm = cache?.frontmatter ? cloneValue(cache.frontmatter) : {};
    const type = typeof fm.type === "string" ? normalizeTypeKey(fm.type) : "";
    const schema = this.resolveSchema(type);
    if (!schema) {
      this.recordWarning(
        `Resolved backlink target '${destination.path}' has no matching schema (${descriptor})`
      );
      return null;
    }

    return {
      file: destination,
      frontmatter: fm,
      schema,
      title: String(destination.basename || "").trim()
    };
  }

  recordWarning(message) {
    if (!message) return;
    this.runStats.warnings.push(message);
    if (this.settings.verboseLogging) console.debug(`[mobile-schema-typer] ${message}`);
  }

  showRunSummary(mode, { backlinkOnly = false } = {}) {
    if (mode !== "manual") return;
    const stats = this.runStats;
    const parts = backlinkOnly
      ? [
          `backlink sync complete`,
          `${stats.backlinksAdded} files updated`,
          `${stats.backlinksRemoved} links removed`,
          `${stats.warnings.length} warnings`
        ]
      : [
          `scanned ${stats.scanned} files`,
          `${stats.updated} updated`,
          `${stats.renamed} renamed`,
          `${stats.moved} moved`,
          `${stats.backlinksAdded} backlink updates`,
          `${stats.backlinksRemoved} links removed`,
          `${stats.warnings.length} warnings`
        ];
    new Notice(`Mobile Schema Typer: ${parts.join(", ")}`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.validateSettings();
  }

  async saveSettings() {
    this.validateSettings();
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
          this.plugin.settings.debounceMs = Number.isFinite(parsed) ? Math.max(250, parsed) : 1200;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Schemas folder")
      .setDesc("Folder containing schema markdown files.")
      .addText((text) =>
        text.setValue(this.plugin.settings.schemasFolder).onChange(async (value) => {
          this.plugin.settings.schemasFolder = value.trim() || "Schemas";
          await this.plugin.saveSettings();
          this.display();
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
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Archive folder")
      .setDesc("Target folder when status is done/superseded/cancelled.")
      .addText((text) =>
        text.setValue(this.plugin.settings.archiveFolder).onChange(async (value) => {
          this.plugin.settings.archiveFolder = value.trim() || "Archive";
          await this.plugin.saveSettings();
          this.display();
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

    new Setting(containerEl)
      .setName("Verbose logging")
      .setDesc("Log warnings to the developer console during runs.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.verboseLogging).onChange(async (value) => {
          this.plugin.settings.verboseLogging = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Prune managed backlinks")
      .setDesc("Remove stale inverse links from fields managed by pair rules. Off by default for safety.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pruneManagedBacklinks).onChange(async (value) => {
          this.plugin.settings.pruneManagedBacklinks = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

function parseMarkdownWithFrontmatter(text) {
  if (!text || !text.startsWith("---\n")) {
    return { frontmatter: {}, body: text || "" };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: text || "" };
  }
  const frontmatterText = text.slice(0, end + 4);
  const body = text.slice(end + 4).replace(/^\n/, "");
  return {
    frontmatter: parseFrontmatter(frontmatterText) || {},
    body
  };
}

function stringifyMarkdownWithFrontmatter(frontmatter, body = "") {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter || {})) {
    lines.push(...serializeFrontmatterEntry(key, value));
  }
  lines.push("---");
  if (body) lines.push(body.replace(/^\n+/, ""));
  return `${lines.join("\n")}\n`;
}

function serializeFrontmatterEntry(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map((entry) => `  - ${serializeScalar(entry)}`)];
  }
  return [`${key}: ${serializeScalar(value)}`];
}

function serializeScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const str = String(value);
  if (!str) return "";
  if (/^\[\[[^\]]+\]\]$/.test(str)) return str;
  if (/^[A-Za-z0-9_\/-]+$/.test(str)) return str;
  return JSON.stringify(str);
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

function parseSchemaFrontmatter(fm, options = {}) {
  const reserved = new Set(["type", "extends", "folder", "purpose", "prependDateToTitle"]);
  const required = new Set(["type"]);
  const fields = new Map();
  const explicitDefaults = new Map();
  const pairRulesByField = {};

  for (const [rawKey, rawValue] of Object.entries(fm)) {
    const key = String(rawKey).trim();
    if (!key) continue;
    const baseKey = key.endsWith("*") ? key.slice(0, -1) : key;
    if (baseKey.startsWith("pair.")) {
      const sourceField = baseKey.slice("pair.".length).trim();
      if (!sourceField) continue;
      const pair = parsePairValue(rawValue);
      if (pair) {
        pairRulesByField[sourceField] = {
          sourceField,
          targetType: pair.targetType,
          targetField: pair.targetField,
          descriptor: `pair.${sourceField}`
        };
      }
      continue;
    }
    // Backward-compatible alias: linkPair.<id>: left<->right
    if (baseKey.startsWith("linkPair.")) {
      const pairId = baseKey.slice("linkPair.".length).trim();
      if (!pairId) continue;
      const pair = parseLinkPairValue(rawValue);
      if (pair) {
        if (!pairRulesByField[pair.left]) {
          pairRulesByField[pair.left] = {
            sourceField: pair.left,
            targetType: null,
            targetField: pair.right,
            descriptor: `linkPair.${pairId}`
          };
        }
        if (!pairRulesByField[pair.right]) {
          pairRulesByField[pair.right] = {
            sourceField: pair.right,
            targetType: null,
            targetField: pair.left,
            descriptor: `linkPair.${pairId}`
          };
        }
      }
      continue;
    }
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
    type: String(options.type || fm.type || "").trim(),
    extends: parseSimpleWikiLinkRef(fm.extends),
    folder: String(fm.folder || "").trim().replace(/^\/+|\/+$/g, "") || null,
    prependDateToTitle: parseOptionalBool(fm.prependDateToTitle),
    required,
    fields,
    pairRulesByField
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

function parseLinkPairValue(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^([A-Za-z0-9_-]+)\s*<->\s*([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  return { left: m[1], right: m[2] };
}

function parsePairValue(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  return { targetType: m[1], targetField: m[2] };
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

function normalizeWikiLinkValue(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const target = parseWikiLinkTarget(raw);
  if (target) return `[[${target}]]`;
  const cleaned = raw.replace(/^\[\[|\]\]$/g, "").trim();
  return cleaned ? `[[${cleaned}]]` : null;
}

function parseWikiLinkTarget(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^\[\[([^\]]+)\]\]$/);
  if (!match) return null;
  const base = match[1].split("|")[0].split("#")[0].trim();
  return base || null;
}

function extractLinkTargets(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeWikiLinkValue(entry)).filter(Boolean);
  }
  const one = normalizeWikiLinkValue(value);
  return one ? [one] : [];
}

function normalizeTitleKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTypeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTypeValue(value) {
  return normalizeTypeKey(value);
}

function typeMatchesOrExtends(noteType, targetType, schemasByType) {
  const wanted = normalizeTypeValue(targetType);
  if (!wanted) return true;
  let current = normalizeTypeValue(noteType);
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (current === wanted) return true;
    seen.add(current);
    const schema = schemasByType?.get?.(current);
    current = normalizeTypeValue(schema?.extends);
  }
  return false;
}

function fieldContainerKind(def, currentValue) {
  if (def && (def.kind === "array" || def.kind === "array-enum")) return "array";
  if (def && (def.kind === "string" || def.kind === "value" || def.kind === "string-enum")) return "scalar";
  if (Array.isArray(currentValue)) return "array";
  if (typeof currentValue === "string" && currentValue.trim()) return "scalar";
  return "unknown";
}

function pruneManagedInverseLinks({ frontmatter, field, desiredLinks, containerKind }) {
  if (containerKind === "unknown") {
    return {
      ok: false,
      changed: false,
      removedCount: 0,
      message: `Cannot infer container type for inverse field '${field}'`
    };
  }

  const desiredKeys = new Set(
    (desiredLinks || []).map((entry) => normalizeTitleKey(parseWikiLinkTarget(entry) || entry)).filter(Boolean)
  );

  if (containerKind === "array") {
    const current = Array.isArray(frontmatter[field]) ? frontmatter[field] : extractLinkTargets(frontmatter[field]);
    const normalized = current.map((entry) => normalizeWikiLinkValue(entry)).filter(Boolean);
    const kept = [];
    let removedCount = 0;
    for (const entry of normalized) {
      const key = normalizeTitleKey(parseWikiLinkTarget(entry) || entry);
      if (desiredKeys.has(key)) {
        kept.push(entry);
      } else {
        removedCount += 1;
      }
    }
    const changed = removedCount > 0 || !Array.isArray(frontmatter[field]);
    if (changed) frontmatter[field] = kept;
    return { ok: true, changed, removedCount };
  }

  const existing = normalizeWikiLinkValue(frontmatter[field]);
  if (!existing) return { ok: true, changed: false, removedCount: 0 };
  const key = normalizeTitleKey(parseWikiLinkTarget(existing) || existing);
  if (desiredKeys.has(key)) return { ok: true, changed: false, removedCount: 0 };
  frontmatter[field] = "";
  return { ok: true, changed: true, removedCount: 1 };
}

function addInverseLink({ frontmatter, field, link, containerKind }) {
  if (containerKind === "unknown") {
    return {
      ok: false,
      rule: "backlink/unknown-field",
      message: `Cannot infer container type for inverse field '${field}'`
    };
  }

  if (containerKind === "array") {
    const current = Array.isArray(frontmatter[field]) ? frontmatter[field] : extractLinkTargets(frontmatter[field]);
    const normalized = current.map((entry) => normalizeWikiLinkValue(entry)).filter(Boolean);
    const existing = new Set(normalized.map((entry) => normalizeTitleKey(parseWikiLinkTarget(entry) || entry)));
    const key = normalizeTitleKey(parseWikiLinkTarget(link) || link);
    if (!existing.has(key)) {
      normalized.push(link);
      frontmatter[field] = normalized;
      return { ok: true, changed: true };
    }
    if (!Array.isArray(frontmatter[field])) {
      frontmatter[field] = normalized;
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
    rule: "backlink/scalar-conflict",
    message: `Scalar inverse field '${field}' already points to '${existing}'`
  };
}

function cloneValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  return value;
}

function createRunStats() {
  return {
    scanned: 0,
    updated: 0,
    renamed: 0,
    moved: 0,
    backlinksAdded: 0,
    backlinksRemoved: 0,
    warnings: []
  };
}

function buildWikiLinkToFile(file) {
  const path = String(file?.path || "").trim();
  if (!path) return "[[" + String(file?.basename || "") + "]]";
  const withoutExt = path.replace(/\.md$/i, "");
  return `[[${withoutExt}]]`;
}

module.exports._test = {
  parseSchemaFrontmatter,
  normalizeTypeKey,
  typeMatchesOrExtends,
  fieldContainerKind,
  addInverseLink,
  pruneManagedInverseLinks,
  buildWikiLinkToFile,
  extractDatePrefix,
  createRunStats,
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
};

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
