import {
  type App,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from 'obsidian';

import { buildDeck } from './deck';
import { t } from './i18n';
import { readImageSize, toBase64 } from './image';
import type { Ratio } from './layout';
import type { ImageInfo } from './model';
import type { SplitMode } from './outline';
import { splitFrontMatter } from './parse';
import { THEMES, type ThemeId } from './themes';

interface ExportRecord {
  mtime: number;
  size: number;
}

interface Settings {
  split: SplitMode;
  titleSlide: boolean;
  ratio: Ratio;
  theme: ThemeId;
  font: string;
  monoFont: string;
  slideNumbers: boolean;
  folder: string;
  openAfterExport: boolean;
  /** What this plugin last wrote, to tell its own files from edited ones. */
  exports: Record<string, ExportRecord>;
}

const DEFAULTS: Settings = {
  split: 'auto',
  titleSlide: true,
  ratio: '16:9',
  theme: 'light',
  font: 'Arial',
  monoFont: 'Courier New',
  slideNumbers: true,
  folder: '',
  openAfterExport: true,
  exports: {},
};

/** Larger images are scaled down so a deck of photos stays a reasonable size. */
const MAX_IMAGE_EDGE = 2400;
const MAX_EXPORT_RECORDS = 500;

type Choice = 'replace' | 'keep' | 'cancel';

class ReplaceModal extends Modal {
  private choice: Choice = 'cancel';

  constructor(
    app: App,
    private readonly path: string,
    private readonly done: (choice: Choice) => void
  ) {
    super(app);
  }

  override onOpen() {
    this.setTitle(t('exists_title'));
    this.contentEl.createEl('p', { text: t('exists_body', { path: this.path }) });
    const pick = (choice: Choice) => () => {
      this.choice = choice;
      this.close();
    };
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(t('exists_keep')).setCta().onClick(pick('keep'))
      )
      .addButton((button) =>
        button.setButtonText(t('exists_replace')).setWarning().onClick(pick('replace'))
      )
      .addButton((button) =>
        button.setButtonText(t('exists_cancel')).onClick(pick('cancel'))
      );
  }

  override onClose() {
    this.contentEl.empty();
    this.done(this.choice);
  }
}

export default class NoteToPowerPointPlugin extends Plugin {
  override settings: Settings = DEFAULTS;
  private busy = false;

  override async onload() {
    await this.loadSettings();
    this.addCommand({
      id: 'export-current-note',
      name: t('command_export'),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== 'md') return false;
        if (!checking) void this.exportNote(file);
        return true;
      },
    });
    this.addRibbonIcon('presentation', t('ribbon_export'), () => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === 'md') void this.exportNote(file);
      else new Notice(t('not_markdown'));
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setTitle(t('menu_export'))
            .setIcon('presentation')
            .onClick(() => void this.exportNote(file))
        );
      })
    );
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  async loadSettings() {
    const saved = ((await this.loadData()) ?? {}) as Partial<Settings>;
    this.settings = { ...DEFAULTS, ...saved, exports: { ...saved.exports } };
    if (!(this.settings.theme in THEMES)) this.settings.theme = DEFAULTS.theme;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async readNote(file: TFile) {
    // The editor can be ahead of the file on disk.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) return view.getViewData();
    return this.app.vault.cachedRead(file);
  }

  private async loadImage(src: string, sourcePath: string): Promise<ImageInfo | null> {
    // Images on the web are skipped: exporting never uses the network.
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    let linkpath = src.split(/[?#]/)[0] ?? '';
    try {
      linkpath = decodeURIComponent(linkpath);
    } catch {
      // Not percent-encoded; use it as written.
    }
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    if (!file) return null;
    const bytes = new Uint8Array(await this.app.vault.readBinary(file));
    const size = readImageSize(bytes);
    if (size && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE)
      return {
        width: size.width,
        height: size.height,
        data: `data:${size.mime};base64,${toBase64(bytes)}`,
      };
    return this.rasterize(bytes, file.extension.toLowerCase());
  }

  /** Redraws formats PowerPoint can't show (WebP, SVG, GIF) and oversized images. */
  private async rasterize(bytes: Uint8Array, extension: string): Promise<ImageInfo | null> {
    const types: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    };
    const type = types[extension];
    if (!type) return null;
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image'));
        image.src = url;
      });
      const naturalW = image.naturalWidth || 1200;
      const naturalH = image.naturalHeight || 900;
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(naturalW, naturalH));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(naturalW * scale));
      canvas.height = Math.max(1, Math.round(naturalH * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const photo = type === 'image/jpeg';
      return {
        width: canvas.width,
        height: canvas.height,
        data: photo ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png'),
      };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private targetPath(file: TFile) {
    const folder = this.settings.folder.trim().replace(/^\/+|\/+$/g, '');
    const parent = folder || file.parent?.path || '';
    const dir = parent === '/' ? '' : parent;
    return normalizePath((dir ? dir + '/' : '') + file.basename + '.pptx');
  }

  private async freePath(path: string) {
    const stem = path.replace(/\.pptx$/i, '');
    for (let count = 1; ; count += 1) {
      const candidate = `${stem} ${count}.pptx`;
      if (!(await this.app.vault.adapter.exists(candidate))) return candidate;
    }
  }

  /** Where to write, or null when the user cancels. */
  private async resolveTarget(path: string) {
    const { adapter } = this.app.vault;
    if (!(await adapter.exists(path))) return path;
    const stat = await adapter.stat(path);
    const last = this.settings.exports[path];
    // Unchanged since this plugin wrote it: nothing of the user's is lost.
    if (last && stat && stat.mtime === last.mtime && stat.size === last.size)
      return path;
    const choice = await new Promise<Choice>((resolve) =>
      new ReplaceModal(this.app, path, resolve).open()
    );
    if (choice === 'cancel') return null;
    return choice === 'replace' ? path : this.freePath(path);
  }

  private async write(path: string, data: ArrayBuffer) {
    const { vault } = this.app;
    const slash = path.lastIndexOf('/');
    if (slash > 0) {
      const dir = path.slice(0, slash);
      if (!(await vault.adapter.exists(dir))) await vault.createFolder(dir);
    }
    const existing = vault.getFileByPath(path);
    if (existing) await vault.modifyBinary(existing, data);
    else if (await vault.adapter.exists(path)) await vault.adapter.writeBinary(path, data);
    else await vault.createBinary(path, data);
    const stat = await vault.adapter.stat(path);
    if (!stat) return;
    const { exports } = this.settings;
    delete exports[path];
    exports[path] = { mtime: stat.mtime, size: stat.size };
    const paths = Object.keys(exports);
    for (const old of paths.slice(0, Math.max(0, paths.length - MAX_EXPORT_RECORDS)))
      delete exports[old];
    await this.saveSettings();
  }

  async exportNote(file: TFile) {
    if (this.busy) return;
    this.busy = true;
    let progress: Notice | undefined;
    try {
      const markdown = await this.readNote(file);
      if (!splitFrontMatter(markdown).body.trim()) {
        new Notice(t('empty'));
        return;
      }
      const path = await this.resolveTarget(this.targetPath(file));
      if (!path) return;
      progress = new Notice(t('exporting'), 0);
      const deck = await buildDeck(markdown, {
        fallbackTitle: file.basename,
        split: this.settings.split,
        titleSlide: this.settings.titleSlide,
        ratio: this.settings.ratio,
        theme: this.settings.theme,
        font: this.settings.font.trim() || DEFAULTS.font,
        monoFont: this.settings.monoFont.trim() || DEFAULTS.monoFont,
        slideNumbers: this.settings.slideNumbers,
        loadImage: (src) => this.loadImage(src, file.path),
      });
      try {
        await this.write(path, deck.data);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          new Notice(t('locked', { path }), 8000);
          return;
        }
        throw error;
      }
      new Notice(
        deck.slides === 1
          ? t('done_one', { path })
          : t('done', { path, slides: deck.slides }),
        6000
      );
      if (deck.missingImages.length)
        new Notice(
          t('missing_images', {
            count: deck.missingImages.length,
            names: deck.missingImages.slice(0, 5).join(', '),
          }),
          10000
        );
      if (this.settings.openAfterExport && Platform.isDesktopApp) {
        const app = this.app as App & { openWithDefaultApp?: (path: string) => unknown };
        app.openWithDefaultApp?.(path);
      }
    } catch (error) {
      console.error('Note to PowerPoint: export failed', error);
      new Notice(
        t('failed', { message: error instanceof Error ? error.message : String(error) }),
        10000
      );
    } finally {
      progress?.hide();
      this.busy = false;
    }
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NoteToPowerPointPlugin
  ) {
    super(app, plugin);
  }

  override display() {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl)
      .setName(t('split_name'))
      .setDesc(t('split_desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            auto: t('split_auto'),
            rule: t('split_rule'),
            h1: t('split_h1'),
            h2: t('split_h2'),
            h3: t('split_h3'),
          })
          .setValue(settings.split)
          .onChange((value) => {
            settings.split = value as SplitMode;
            save();
          })
      );
    new Setting(containerEl)
      .setName(t('title_slide_name'))
      .setDesc(t('title_slide_desc'))
      .addToggle((toggle) =>
        toggle.setValue(settings.titleSlide).onChange((value) => {
          settings.titleSlide = value;
          save();
        })
      );
    new Setting(containerEl).setName(t('theme_name')).addDropdown((dropdown) =>
      dropdown
        .addOptions({
          light: t('theme_light'),
          paper: t('theme_paper'),
          dark: t('theme_dark'),
          violet: t('theme_violet'),
        })
        .setValue(settings.theme)
        .onChange((value) => {
          settings.theme = value as ThemeId;
          save();
        })
    );
    new Setting(containerEl).setName(t('ratio_name')).addDropdown((dropdown) =>
      dropdown
        .addOptions({ '16:9': t('ratio_wide'), '4:3': t('ratio_standard') })
        .setValue(settings.ratio)
        .onChange((value) => {
          settings.ratio = value as Ratio;
          save();
        })
    );
    new Setting(containerEl)
      .setName(t('font_name'))
      .setDesc(t('font_desc'))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULTS.font)
          .setValue(settings.font)
          .onChange((value) => {
            settings.font = value;
            save();
          })
      );
    new Setting(containerEl).setName(t('mono_font_name')).addText((text) =>
      text
        .setPlaceholder(DEFAULTS.monoFont)
        .setValue(settings.monoFont)
        .onChange((value) => {
          settings.monoFont = value;
          save();
        })
    );
    new Setting(containerEl).setName(t('numbers_name')).addToggle((toggle) =>
      toggle.setValue(settings.slideNumbers).onChange((value) => {
        settings.slideNumbers = value;
        save();
      })
    );
    new Setting(containerEl)
      .setName(t('folder_name'))
      .setDesc(t('folder_desc'))
      .addText((text) =>
        text
          .setPlaceholder(t('folder_placeholder'))
          .setValue(settings.folder)
          .onChange((value) => {
            settings.folder = value;
            save();
          })
      );
    if (Platform.isDesktopApp)
      new Setting(containerEl)
        .setName(t('open_name'))
        .setDesc(t('open_desc'))
        .addToggle((toggle) =>
          toggle.setValue(settings.openAfterExport).onChange((value) => {
            settings.openAfterExport = value;
            save();
          })
        );

    const about = containerEl.createEl('p', { cls: 'setting-item-description' });
    about.appendText(t('about') + ' ');
    about.createEl('a', {
      text: t('about_link'),
      href: 'https://editableppt.com/agent-ppt?utm_source=obsidian&utm_medium=plugin',
    });
  }
}
