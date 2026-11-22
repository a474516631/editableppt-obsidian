import {
  type App,
  MarkdownView,
  Modal,
  normalizePath,
  Notice,
  Platform,
  Plugin,
  requireApiVersion,
  PluginSettingTab,
  Setting,
  type SettingDefinition,
  type SettingDefinitionItem,
  TFile,
} from 'obsidian';

import { DeckController, type SecretStore, SERVICE_URL } from './cloud/controller';
import type { DeckLocale, JobState } from './cloud/job';
import { DeckModal } from './cloud/modal';
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
  /** AI design: the deck being made on EditablePPT, if any. */
  cloudJob: JobState | null;
  /** AI design: the last template and language picked. */
  cloudStyle: string;
  cloudLocale: DeckLocale;
  /** EditablePPT address; only changed by hand in data.json, for development. */
  serviceUrl: string;
}

/** The settings a user edits in the settings tab. */
type SettingKey = Exclude<
  keyof Settings,
  'exports' | 'cloudJob' | 'cloudStyle' | 'cloudLocale' | 'serviceUrl'
>;

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
  cloudJob: null,
  cloudStyle: 'clean-tech-blue',
  cloudLocale: 'auto',
  serviceUrl: SERVICE_URL,
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
  deckController!: DeckController;

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
    this.setUpDesign();
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  override onunload() {
    this.deckController?.stop();
  }

  /** The optional AI design feature (EditablePPT account). Nothing runs until the user starts it. */
  private setUpDesign() {
    const app = this.app as App & { secretStorage?: SecretStore };
    // The keychain arrived in 1.11.4; older apps can't use AI design (the dialog says so).
    const secrets = requireApiVersion('1.11.4') ? app.secretStorage : undefined;
    this.deckController = new DeckController(
      {
        serviceUrl: () => this.settings.serviceUrl || SERVICE_URL,
        job: () => this.settings.cloudJob,
        saveJob: async (job) => {
          this.settings.cloudJob = job;
          await this.saveSettings();
        },
        readNote: async (path) => {
          const file = this.app.vault.getFileByPath(path);
          return file ? { markdown: await this.readNote(file), basename: file.basename } : null;
        },
        saveDeck: (job, data) => this.saveDesignedDeck(job, data),
        openFile: (path) => {
          if (this.settings.openAfterExport) this.openExternally(path);
        },
      },
      secrets
    );
    this.addCommand({
      id: 'design-with-template',
      name: t('cloud_command'),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== 'md') return false;
        if (!checking) this.openDesign(file);
        return true;
      },
    });
    this.addCommand({
      id: 'continue-design',
      name: t('cloud_continue_command'),
      checkCallback: (checking) => {
        if (!this.settings.cloudJob) return false;
        if (!checking) this.openDesign(null);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setTitle(t('cloud_menu'))
            .setIcon('sparkles')
            .onClick(() => this.openDesign(file))
        );
      })
    );
    const status = this.addStatusBarItem();
    status.addClass('mod-clickable');
    status.hide();
    status.onClickEvent(() => this.openDesign(null));
    this.register(
      this.deckController.subscribe(() => {
        const { busy, progress } = this.deckController;
        if (busy === 'build' && progress && 'total' in progress) {
          status.setText(t('cloud_status', { done: progress.done, total: progress.total }));
          status.show();
        } else status.hide();
      })
    );
    // A deck that was being built when Obsidian closed picks up where it stopped.
    this.app.workspace.onLayoutReady(() => {
      const job = this.settings.cloudJob;
      if (!job || !this.deckController.signedIn) return;
      if (job.stage === 'build') void this.deckController.build();
      else new Notice(t('cloud_waiting'), 10000);
    });
  }

  openDesign(file: TFile | null) {
    new DeckModal(this.app, this.deckController, {
      file,
      readNote: (note) => this.readNote(note),
      style: this.settings.cloudStyle,
      locale: this.settings.cloudLocale,
      remember: ({ style, locale }) => {
        this.settings.cloudStyle = style;
        this.settings.cloudLocale = locale;
        void this.saveSettings();
      },
      openFile: (path) => this.openExternally(path),
    }).open();
  }

  private openExternally(path: string) {
    const app = this.app as App & { openWithDefaultApp?: (path: string) => unknown };
    if (Platform.isDesktopApp) app.openWithDefaultApp?.(path);
  }

  /** Saves a designed deck next to its note, as "<note> (EditablePPT).pptx". */
  private async saveDesignedDeck(job: JobState, data: ArrayBuffer) {
    const note = this.app.vault.getFileByPath(job.notePath);
    const folder = this.settings.folder.trim().replace(/^\/+|\/+$/g, '');
    const parent = folder || note?.parent?.path || '';
    const dir = parent === '/' ? '' : parent;
    const stem = (note?.basename || job.title || 'Presentation').replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
    const path = await this.resolveTarget(
      normalizePath((dir ? dir + '/' : '') + `${stem} (EditablePPT).pptx`)
    );
    if (!path) return null;
    await this.write(path, data);
    return path;
  }

  async loadSettings() {
    const saved = ((await this.loadData()) ?? {}) as Partial<Settings>;
    this.settings = { ...DEFAULTS, ...saved, exports: { ...saved.exports } };
    if (!['auto', 'zh', 'en'].includes(this.settings.cloudLocale)) this.settings.cloudLocale = 'auto';
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
      const canvas = createEl('canvas');
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
      if (this.settings.openAfterExport) this.openExternally(path);
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
  private cleanup: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: NoteToPowerPointPlugin
  ) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
    return [...this.exportDefinitions(), this.designGroup(), this.aboutDefinition()];
  }

  /** The account row of the AI design feature; redrawn when its state changes. */
  private designGroup(): SettingDefinitionItem<SettingKey> {
    const controller = this.plugin.deckController;
    return {
      type: 'group',
      heading: t('cloud_settings_heading'),
      items: [
        {
          name: t('cloud_settings_account'),
          render: (setting: Setting) => this.renderAccount(setting),
        },
      ],
      visible: () => controller.supported,
    };
  }

  private renderAccount(setting: Setting) {
    const controller = this.plugin.deckController;
    const draw = () => {
      setting.controlEl.empty();
      const { account } = controller;
      if (controller.busy === 'signin') setting.setDesc(t('cloud_signing_in'));
      else if (controller.signedIn)
        setting.setDesc(
          account
            ? t('cloud_account', { email: account.account.email, balance: account.balance })
            : t('cloud_loading')
        );
      else setting.setDesc(t('cloud_settings_signed_out'));
      if (controller.busy === 'signin')
        setting.addButton((button) => button.setButtonText(t('exists_cancel')).onClick(() => controller.stop()));
      else if (controller.signedIn)
        setting.addButton((button) =>
          button.setButtonText(t('cloud_sign_out')).onClick(async () => {
            await controller.signOut();
            new Notice(t('cloud_signed_out'));
          })
        );
      else
        setting.addButton((button) =>
          button.setButtonText(t('cloud_sign_in')).setCta().onClick(() => void controller.signIn())
        );
    };
    draw();
    if (controller.signedIn && !controller.account) void controller.refreshAccount();
    return controller.subscribe(draw);
  }

  private aboutDefinition(): SettingDefinition<SettingKey> {
    return {
      name: t('about_name'),
      searchable: false,
      desc: createFragment((el) => {
        el.appendText(t('about') + ' ');
        el.createEl('a', {
          text: t('about_link'),
          href: 'https://editableppt.com/agent-ppt?utm_source=obsidian&utm_medium=plugin',
        });
      }),
    };
  }

  private exportDefinitions(): SettingDefinition<SettingKey>[] {
    return [
      {
        name: t('split_name'),
        desc: t('split_desc'),
        control: {
          type: 'dropdown',
          key: 'split',
          options: {
            auto: t('split_auto'),
            rule: t('split_rule'),
            h1: t('split_h1'),
            h2: t('split_h2'),
            h3: t('split_h3'),
          },
        },
      },
      {
        name: t('title_slide_name'),
        desc: t('title_slide_desc'),
        control: { type: 'toggle', key: 'titleSlide' },
      },
      {
        name: t('theme_name'),
        control: {
          type: 'dropdown',
          key: 'theme',
          options: {
            light: t('theme_light'),
            paper: t('theme_paper'),
            dark: t('theme_dark'),
            violet: t('theme_violet'),
          },
        },
      },
      {
        name: t('ratio_name'),
        control: {
          type: 'dropdown',
          key: 'ratio',
          options: { '16:9': t('ratio_wide'), '4:3': t('ratio_standard') },
        },
      },
      {
        name: t('font_name'),
        desc: t('font_desc'),
        control: { type: 'text', key: 'font', placeholder: DEFAULTS.font },
      },
      {
        name: t('mono_font_name'),
        control: { type: 'text', key: 'monoFont', placeholder: DEFAULTS.monoFont },
      },
      {
        name: t('numbers_name'),
        control: { type: 'toggle', key: 'slideNumbers' },
      },
      {
        name: t('folder_name'),
        desc: t('folder_desc'),
        control: {
          type: 'folder',
          key: 'folder',
          placeholder: t('folder_placeholder'),
        },
      },
      {
        name: t('open_name'),
        desc: t('open_desc'),
        visible: () => Platform.isDesktopApp,
        control: { type: 'toggle', key: 'openAfterExport' },
      },
    ];
  }

  override hide() {
    this.cleanup?.();
    this.cleanup = null;
    super.hide();
  }

  override getControlValue(key: string) {
    return this.plugin.settings[key as SettingKey];
  }

  override async setControlValue(key: string, value: unknown) {
    Object.assign(this.plugin.settings, { [key]: value });
    await this.plugin.saveSettings();
  }

  /** Obsidian before 1.13 doesn't read the definitions above and calls this instead. */
  override display() {
    this.containerEl.empty();
    this.cleanup?.();
    this.cleanup = null;
    for (const item of this.exportDefinitions()) this.renderPlain(item);
    // AI design needs the keychain (1.11.4); before 1.13 it gets a plain heading and row.
    if (this.plugin.deckController.supported) {
      new Setting(this.containerEl).setName(t('cloud_settings_heading')).setHeading();
      const unsubscribe = this.renderAccount(new Setting(this.containerEl).setName(t('cloud_settings_account')));
      this.cleanup = () => void unsubscribe();
    }
    this.renderPlain(this.aboutDefinition());
  }

  private renderPlain(item: SettingDefinition<SettingKey>) {
    const visible = typeof item.visible === 'function' ? item.visible() : item.visible;
    if (visible === false) return;
    const setting = new Setting(this.containerEl).setName(item.name);
    if (item.desc) setting.setDesc(item.desc);
    const { control } = item;
    if (!control) return;
    const value = this.getControlValue(control.key);
    const save = (next: unknown) => void this.setControlValue(control.key, next);
    if (control.type === 'toggle')
      setting.addToggle((toggle) => toggle.setValue(value === true).onChange(save));
    else if (control.type === 'dropdown')
      setting.addDropdown((dropdown) =>
        dropdown.addOptions(control.options).setValue(String(value)).onChange(save)
      );
    else if (control.type === 'text' || control.type === 'folder')
      setting.addText((text) =>
        text
          .setPlaceholder(control.placeholder ?? '')
          .setValue(String(value ?? ''))
          .onChange(save)
      );
  }
}
