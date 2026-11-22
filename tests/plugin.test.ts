import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const notices: string[] = [];
const modals: string[] = [];

vi.mock('obsidian', () => {
  class Plugin {
    commands: { id: string; checkCallback?: (checking: boolean) => unknown }[] = [];
    private data: unknown = null;
    constructor(public app: unknown) {}
    addCommand(command: { id: string }) {
      this.commands.push(command);
    }
    addRibbonIcon() {}
    tab: unknown;
    addSettingTab(tab: unknown) {
      this.tab = tab;
    }
    registerEvent() {}
    register() {}
    addStatusBarItem() {
      return { addClass() {}, hide() {}, show() {}, setText() {}, onClickEvent() {} };
    }
    async loadData() {
      return this.data;
    }
    async saveData(data: unknown) {
      this.data = JSON.parse(JSON.stringify(data));
    }
  }
  class Modal {
    contentEl = { createEl: () => ({}), empty: () => {} };
    constructor(public app: unknown) {}
    setTitle(title: string) {
      modals.push(title);
    }
    onOpen() {}
    onClose() {}
    open() {
      this.onOpen();
      this.onClose();
    }
    close() {}
  }
  class Notice {
    constructor(message: string) {
      notices.push(message);
    }
    hide() {}
  }
  class Setting {
    addButton() {
      return this;
    }
  }
  class TFile {}
  return {
    Plugin,
    Modal,
    Notice,
    Setting,
    TFile,
    MarkdownView: class {},
    PluginSettingTab: class {
      constructor(
        public app: unknown,
        public plugin: unknown
      ) {}
    },
    Platform: { isDesktopApp: false },
    normalizePath: (path: string) => path.replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
    getLanguage: () => 'en',
    requireApiVersion: () => true,
  };
});

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0)
);

function fakeApp(notes: Record<string, string>) {
  const files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  let clock = 1000;
  const put = (path: string, data: ArrayBuffer) => {
    clock += 1;
    files.set(path, { data, mtime: clock });
  };
  const handle = (path: string) => ({ path });
  const app = {
    workspace: {
      getActiveViewOfType: () => null,
      getActiveFile: () => null,
      on: () => ({}),
      onLayoutReady: (callback: () => void) => callback(),
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string) =>
        link === 'pic.png' ? { path: 'assets/pic.png', extension: 'png' } : null,
    },
    vault: {
      cachedRead: async (file: { path: string }) => notes[file.path] ?? '',
      readBinary: async () => PNG.buffer,
      getFileByPath: (path: string) => (files.has(path) ? handle(path) : null),
      createBinary: async (path: string, data: ArrayBuffer) => put(path, data),
      modifyBinary: async (file: { path: string }, data: ArrayBuffer) => put(file.path, data),
      createFolder: async () => {},
      adapter: {
        exists: async (path: string) => files.has(path) || path === 'talks',
        stat: async (path: string) => {
          const file = files.get(path);
          return file ? { mtime: file.mtime, size: file.data.byteLength } : null;
        },
        writeBinary: async (path: string, data: ArrayBuffer) => put(path, data),
      },
    },
  };
  return { app, files, put };
}

const note = (path: string) => {
  const name = path.split('/').pop()!;
  const slash = path.lastIndexOf('/');
  return {
    path,
    basename: name.replace(/\.md$/, ''),
    extension: 'md',
    parent: { path: slash < 0 ? '/' : path.slice(0, slash) },
  };
};

interface SettingsTabLike {
  getSettingDefinitions(): { name?: string; control?: { key: string } }[];
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): Promise<void>;
}

async function load(notes: Record<string, string>) {
  const { default: PluginClass } = await import('../src/main');
  const fake = fakeApp(notes);
  const plugin = new (PluginClass as unknown as new (app: unknown) => InstanceType<typeof PluginClass>)(fake.app);
  await plugin.onload();
  return { plugin, ...fake };
}

beforeEach(() => {
  notices.length = 0;
  modals.length = 0;
});

describe('plugin', () => {
  it('registers the export and AI design commands', async () => {
    const { plugin } = await load({});
    const commands = (plugin as unknown as { commands: { id: string }[] }).commands;
    expect(commands.map((command) => command.id)).toEqual([
      'export-current-note',
      'design-with-template',
      'continue-design',
    ]);
  });

  it('writes a deck next to the note, with its embedded image', async () => {
    const { plugin, files } = await load({ 'talks/My talk.md': '# My talk\n\n## One\n\n- a\n\n![[pic.png]]\n' });
    await plugin.exportNote(note('talks/My talk.md') as never);
    expect([...files.keys()]).toEqual(['talks/My talk.pptx']);
    const zip = await JSZip.loadAsync(files.get('talks/My talk.pptx')!.data);
    expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
    expect(Object.keys(zip.files).some((name) => /^ppt\/media\/.+\.png$/.test(name))).toBe(true);
    expect(notices.at(-1)).toBe('Saved talks/My talk.pptx (2 slides).');
  });

  it('saves at the vault root for a note at the root', async () => {
    const { plugin, files } = await load({ 'Note.md': '## A\n\ntext\n' });
    await plugin.exportNote(note('Note.md') as never);
    expect([...files.keys()]).toEqual(['Note.pptx']);
  });

  it('replaces its own unchanged export without asking', async () => {
    const { plugin, files } = await load({ 'Note.md': '## A\n\ntext\n' });
    await plugin.exportNote(note('Note.md') as never);
    const first = files.get('Note.pptx')!.mtime;
    await plugin.exportNote(note('Note.md') as never);
    expect(modals).toEqual([]);
    expect(files.get('Note.pptx')!.mtime).toBeGreaterThan(first);
  });

  it('asks before replacing a file that was edited, and keeps it on cancel', async () => {
    const { plugin, files, put } = await load({ 'Note.md': '## A\n\ntext\n' });
    await plugin.exportNote(note('Note.md') as never);
    const edited = new Uint8Array([1, 2, 3]).buffer;
    put('Note.pptx', edited);
    await plugin.exportNote(note('Note.md') as never);
    expect(modals).toEqual(['Replace the existing file?']);
    expect(files.get('Note.pptx')!.data).toBe(edited);
  });

  it('asks before replacing a file it did not write', async () => {
    const { plugin, files, put } = await load({ 'Note.md': '## A\n\ntext\n' });
    const theirs = new Uint8Array([9]).buffer;
    put('Note.pptx', theirs);
    await plugin.exportNote(note('Note.md') as never);
    expect(modals).toHaveLength(1);
    expect(files.get('Note.pptx')!.data).toBe(theirs);
  });

  it('describes every setting for the settings tab and saves a change', async () => {
    vi.stubGlobal('createFragment', () => ({}));
    const { plugin } = await load({});
    const tab = (plugin as unknown as { tab: SettingsTabLike }).tab;
    const keys = tab.getSettingDefinitions().flatMap((item) => (item.control ? [item.control.key] : []));
    const internal = ['exports', 'cloudJob', 'cloudStyle', 'cloudLocale', 'serviceUrl'];
    expect([...keys].sort()).toEqual(
      Object.keys(plugin.settings)
        .filter((key) => !internal.includes(key))
        .sort()
    );
    expect(tab.getControlValue('theme')).toBe('light');
    await tab.setControlValue('theme', 'dark');
    expect(plugin.settings.theme).toBe('dark');
    expect(((await plugin.loadData()) as { theme: string }).theme).toBe('dark');
    vi.unstubAllGlobals();
  });

  it('says so instead of writing a deck for an empty note', async () => {
    const { plugin, files } = await load({ 'Empty.md': '---\ntitle: x\n---\n\n' });
    await plugin.exportNote(note('Empty.md') as never);
    expect(files.size).toBe(0);
    expect(notices).toEqual(['This note has no content to export.']);
  });
});
