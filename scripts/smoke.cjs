// Loads the built main.js the way Obsidian does (CommonJS, with `obsidian`
// provided by the host) and runs one export against an in-memory vault.
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const notices = [];
const obsidian = {
  Plugin: class {
    constructor(app) { this.app = app; this.commands = []; }
    addCommand(command) { this.commands.push(command.id); }
    addRibbonIcon() {}
    addSettingTab() {}
    registerEvent() {}
    async loadData() { return null; }
    async saveData() {}
  },
  Modal: class {},
  Notice: class { constructor(message) { notices.push(message); } hide() {} },
  Setting: class {},
  PluginSettingTab: class {},
  MarkdownView: class {},
  TFile: class {},
  Platform: { isDesktopApp: false },
  normalizePath: (value) => value,
  getLanguage: () => 'zh',
};
const load = Module._load;
Module._load = (request, ...rest) => (request === 'obsidian' ? obsidian : load(request, ...rest));

const root = path.join(__dirname, '..');
// package.json marks .js as ES modules; Obsidian evaluates main.js as CommonJS
// whatever the package says, so compile it that way here too.
const bundle = new Module(path.join(root, 'main.cjs'), module);
bundle.filename = path.join(root, 'main.cjs');
bundle.paths = module.paths;
bundle._compile(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), bundle.filename);
const Plugin = bundle.exports.default;
const written = new Map();
const app = {
  workspace: { getActiveViewOfType: () => null, getActiveFile: () => null, on: () => ({}) },
  metadataCache: { getFirstLinkpathDest: () => null },
  vault: {
    cachedRead: async () => fs.readFileSync(path.join(root, 'samples/quarterly-review.md'), 'utf8'),
    getFileByPath: () => null,
    createBinary: async (file, data) => written.set(file, data),
    createFolder: async () => {},
    adapter: {
      exists: async (file) => written.has(file),
      stat: async (file) => (written.has(file) ? { mtime: 1, size: written.get(file).byteLength } : null),
    },
  },
};

(async () => {
  const plugin = new Plugin(app);
  await plugin.onload();
  await plugin.exportNote({ path: 'Review.md', basename: 'Review', extension: 'md', parent: { path: '/' } });
  const data = written.get('Review.pptx');
  if (!data || new Uint8Array(data)[0] !== 0x50) throw new Error('no PPTX was written: ' + notices.join(' | '));
  console.log('commands:', plugin.commands.join(', '));
  console.log('written: Review.pptx', data.byteLength, 'bytes');
  console.log('notices:', notices.join(' | '));
})().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error).slice(0, 2000));
  process.exit(1);
});
