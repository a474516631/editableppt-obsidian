import { type App, ButtonComponent, DropdownComponent, Modal, setIcon, TextComponent, type TFile } from 'obsidian';

import { t, uiLocale } from '../i18n';
import type { StyleOption } from './api';
import type { DeckController } from './controller';
import type { DeckLocale } from './job';

export interface DeckModalOptions {
  file: TFile | null;
  readNote: (file: TFile) => Promise<string>;
  style: string;
  locale: DeckLocale;
  remember: (choice: { style: string; locale: DeckLocale }) => void;
  openFile: (path: string) => void;
}

/** Styles are the same for every deck; fetched once per session. */
let styleCache: { locale: string; styles: StyleOption[] } | null = null;

/**
 * The dialog of the AI design feature. It only shows the controller's state
 * and calls its actions, so it can be closed and reopened at any time.
 */
export class DeckModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private styles: StyleOption[] | null = null;
  private stylesError: string | null = null;
  private query = '';
  private choice: string | null = null;
  private previewChoice: string | null = null;

  constructor(
    app: App,
    private readonly controller: DeckController,
    private readonly options: DeckModalOptions
  ) {
    super(app);
  }

  override onOpen() {
    this.modalEl.addClass('ntp-deck-modal');
    this.setTitle(t('cloud_title'));
    this.unsubscribe = this.controller.subscribe(() => this.render());
    const { controller } = this;
    if (controller.signedIn && !controller.account) void controller.refreshAccount();
    const job = controller.job;
    if (job && !controller.busy) {
      if (job.stage === 'build' && !controller.error && !controller.skipped.length) void controller.build();
      else if (!controller.deck) void controller.load();
    }
    this.render();
  }

  override onClose() {
    this.unsubscribe?.();
    this.contentEl.empty();
    // A sign-in waits on this dialog; a build keeps running in the background.
    if (this.controller.busy === 'signin') this.controller.stop();
  }

  private render() {
    const { contentEl, controller } = this;
    contentEl.empty();
    if (!controller.supported) {
      contentEl.createEl('p', { text: t('cloud_unsupported') });
      return;
    }
    if (controller.error) {
      const box = contentEl.createDiv({ cls: 'ntp-error' });
      box.createSpan({ text: controller.error });
      if (controller.error === t('cloud_error_credits') || controller.error === t('cloud_error_settling'))
        box.createEl('a', {
          text: t('cloud_buy_credits'),
          href: `${controller.cloud.base}/pricing?utm_source=obsidian&utm_medium=plugin`,
        });
    }
    if (!controller.signedIn || controller.busy === 'signin') return this.renderSignIn();
    const job = controller.job;
    if (!job) return controller.savedPath ? this.renderDone(controller.savedPath) : this.renderSetup();
    contentEl.createEl('p', { cls: 'ntp-muted', text: t('cloud_working_on', { note: job.notePath }) });
    if (job.stage === 'outline') return this.renderOutline();
    if (job.stage === 'design') return this.renderDesign();
    return this.renderBuild();
  }

  private buttons(...items: { text: string; cta?: boolean; disabled?: boolean; onClick: () => void }[]) {
    const row = this.contentEl.createDiv({ cls: 'ntp-buttons' });
    for (const item of items) {
      const button = new ButtonComponent(row).setButtonText(item.text).onClick(item.onClick);
      if (item.cta) button.setCta();
      if (item.disabled) button.setDisabled(true);
    }
  }

  private spinner(text: string) {
    const row = this.contentEl.createDiv({ cls: 'ntp-working' });
    setIcon(row.createSpan({ cls: 'ntp-spin' }), 'loader-circle');
    row.createSpan({ text });
  }

  private renderSignIn() {
    const { contentEl, controller } = this;
    contentEl.createEl('p', { text: t('cloud_intro') });
    const list = contentEl.createEl('ul', { cls: 'ntp-facts' });
    for (const key of ['cloud_fact_upload', 'cloud_fact_account', 'cloud_fact_credits'] as const)
      list.createEl('li', { text: t(key) });
    if (controller.busy === 'signin') {
      this.spinner(t('cloud_signing_in'));
      this.buttons({ text: t('exists_cancel'), onClick: () => controller.stop() });
      return;
    }
    this.buttons({ text: t('cloud_sign_in'), cta: true, onClick: () => void controller.signIn() });
  }

  private account() {
    const { account } = this.controller;
    if (!account) return;
    this.contentEl.createEl('p', {
      cls: 'ntp-muted',
      text: t('cloud_account', { email: account.account.email, balance: account.balance }),
    });
  }

  private async loadStyles() {
    const locale = uiLocale();
    if (styleCache?.locale === locale) {
      this.styles = styleCache.styles;
      return;
    }
    try {
      const styles = await this.controller.cloud.styles(locale);
      styleCache = { locale, styles };
      this.styles = styles;
    } catch (error) {
      this.stylesError = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  private renderSetup() {
    const { contentEl, controller, options } = this;
    const file = options.file;
    this.account();
    if (!file) {
      contentEl.createEl('p', { text: t('not_markdown') });
      return;
    }
    contentEl.createEl('p', { text: t('cloud_setup_intro', { note: file.basename }) });

    if (controller.busy === 'outline') {
      this.spinner(t('cloud_writing_outline'));
      return;
    }
    if (!this.styles && !this.stylesError) void this.loadStyles();
    const selected = this.choice ?? options.style;

    const controls = contentEl.createDiv({ cls: 'ntp-controls' });
    new TextComponent(controls)
      .setPlaceholder(t('cloud_style_search'))
      .setValue(this.query)
      .onChange((value) => {
        this.query = value;
        this.renderGrid(grid, selected);
      });
    const language = new DropdownComponent(controls)
      .addOptions({ auto: t('cloud_lang_auto'), zh: '中文', en: 'English' })
      .setValue(options.locale)
      .onChange((value) => (options.locale = value as DeckLocale));

    const grid = contentEl.createDiv({ cls: 'ntp-style-grid' });
    if (this.stylesError) grid.createEl('p', { text: this.stylesError });
    else if (!this.styles) grid.createEl('p', { cls: 'ntp-muted', text: t('cloud_loading') });
    else this.renderGrid(grid, selected);

    contentEl.createEl('p', { cls: 'ntp-muted', text: t('cloud_privacy') });
    this.buttons({
      text: t('cloud_write_outline'),
      cta: true,
      disabled: !this.styles,
      onClick: () => {
        const style = this.choice ?? options.style;
        const locale = language.getValue() as DeckLocale;
        options.remember({ style, locale });
        void options.readNote(file).then((markdown) => controller.start(file, markdown, style, locale));
      },
    });
  }

  private renderGrid(grid: HTMLElement, selected: string) {
    grid.empty();
    const query = this.query.trim().toLowerCase();
    const styles = (this.styles ?? []).filter(
      (style) => !query || `${style.name} ${style.tagline}`.toLowerCase().includes(query)
    );
    for (const style of styles) {
      const card = grid.createEl('button', { cls: 'ntp-style' });
      card.toggleClass('is-selected', style.id === (this.choice ?? selected));
      card.setAttr('aria-pressed', String(style.id === (this.choice ?? selected)));
      if (style.image) card.createEl('img', { attr: { src: style.image, alt: '', loading: 'lazy' } });
      else {
        const swatches = card.createDiv({ cls: 'ntp-swatches' });
        for (const color of style.palette.slice(0, 5))
          swatches.createSpan({ cls: 'ntp-swatch' }).setCssProps({ '--ntp-swatch': color });
      }
      card.createDiv({ cls: 'ntp-style-name', text: style.name });
      card.createDiv({ cls: 'ntp-style-tagline', text: style.tagline });
      card.onClickEvent(() => {
        this.choice = style.id;
        this.renderGrid(grid, style.id);
      });
    }
  }

  private renderOutline() {
    const { contentEl, controller } = this;
    if (controller.busy === 'outline') {
      this.spinner(t('cloud_writing_outline'));
      return;
    }
    const deck = controller.deck;
    if (!deck || deck.status !== 'outline_ready') {
      this.buttons(
        { text: t('cloud_retry'), cta: true, onClick: () => void controller.retryOutline() },
        { text: t('cloud_discard'), onClick: () => void controller.discard() }
      );
      return;
    }
    contentEl.createEl('h3', { text: deck.title || deck.topic });
    const list = contentEl.createEl('ol', { cls: 'ntp-outline' });
    for (const slide of [...deck.slides].sort((a, b) => a.index - b.index)) {
      const item = list.createEl('li');
      item.createDiv({ cls: 'ntp-slide-title', text: slide.title });
      const body = slide.body.filter(Boolean).slice(0, 3).join(' · ');
      if (body) item.createDiv({ cls: 'ntp-muted', text: body });
    }
    contentEl.createEl('p', { cls: 'ntp-muted', text: t('cloud_outline_next') });
    this.buttons(
      { text: t('cloud_preview_design'), cta: true, onClick: () => void controller.makePreviews() },
      { text: t('cloud_rewrite'), onClick: () => void controller.retryOutline() },
      { text: t('cloud_discard'), onClick: () => void controller.discard() }
    );
  }

  private renderDesign() {
    const { contentEl, controller } = this;
    if (controller.busy === 'previews') {
      this.spinner(t('cloud_drawing_previews'));
      return;
    }
    if (controller.busy) {
      this.spinner(t('cloud_loading'));
      return;
    }
    const previews = controller.previews;
    const ready = previews?.options.filter((option) => option.status === 'ready' && option.imageUrl) ?? [];
    if (!previews || ready.length < previews.options.length) {
      this.buttons(
        { text: t('cloud_draw_previews'), cta: true, onClick: () => void controller.makePreviews() },
        { text: t('cloud_discard'), onClick: () => void controller.discard() }
      );
      return;
    }
    contentEl.createEl('p', { text: t('cloud_pick_preview') });
    const grid = contentEl.createDiv({ cls: 'ntp-previews' });
    for (const option of ready) {
      const card = grid.createEl('button', { cls: 'ntp-preview' });
      card.toggleClass('is-selected', option.id === this.previewChoice);
      card.createEl('img', { attr: { src: option.imageUrl!, alt: '' } });
      card.createDiv({
        cls: 'ntp-style-name',
        text: option.layout === 'structured' ? t('cloud_layout_structured') : t('cloud_layout_visual'),
      });
      card.onClickEvent(() => {
        this.previewChoice = option.id;
        this.render();
      });
    }
    const slides = controller.deck?.slides.length ?? 0;
    const perSlide = controller.account?.costs.layered;
    contentEl.createEl('p', {
      cls: 'ntp-muted',
      text: perSlide ? t('cloud_cost', { slides, credits: perSlide }) : t('cloud_cost_unknown', { slides }),
    });
    this.buttons(
      {
        text: t('cloud_make_slides', { slides }),
        cta: true,
        disabled: !ready.some((option) => option.id === this.previewChoice),
        onClick: () => {
          if (this.previewChoice) void controller.confirm(this.previewChoice);
        },
      },
      { text: t('cloud_discard'), onClick: () => void controller.discard() }
    );
  }

  private renderBuild() {
    const { contentEl, controller } = this;
    if (controller.busy) {
      const progress = controller.progress;
      const text =
        progress?.phase === 'drawing'
          ? t('cloud_progress_drawing', { done: progress.done, total: progress.total })
          : progress?.phase === 'editable'
            ? t('cloud_progress_editable', { done: progress.done, total: progress.total })
            : progress?.phase === 'saving'
              ? t('cloud_progress_saving')
              : t('cloud_loading');
      this.spinner(text);
      if (progress && 'total' in progress && progress.total) {
        const bar = contentEl.createEl('progress', { cls: 'ntp-progress' });
        bar.max = progress.total;
        bar.value = progress.done;
      }
      contentEl.createEl('p', { cls: 'ntp-muted', text: t('cloud_background') });
      this.buttons(
        { text: t('cloud_hide'), cta: true, onClick: () => this.close() },
        { text: t('cloud_stop'), onClick: () => controller.stop() }
      );
      return;
    }
    if (controller.skipped.length && controller.savedPath) {
      const path = controller.savedPath;
      contentEl.createEl('p', { text: t('cloud_saved', { path }) });
      contentEl.createEl('p', {
        cls: 'ntp-muted',
        text: t('cloud_skipped_detail', { slides: controller.skipped.join(', ') }),
      });
      this.buttons(
        { text: t('cloud_retry_missing'), cta: true, onClick: () => void controller.build() },
        { text: t('cloud_open'), onClick: () => this.options.openFile(path) },
        { text: t('cloud_keep_as_is'), onClick: () => void controller.finish() }
      );
      return;
    }
    this.buttons(
      { text: t('cloud_continue'), cta: true, onClick: () => void controller.build() },
      { text: t('cloud_discard'), onClick: () => void controller.discard() }
    );
  }

  private renderDone(path: string) {
    this.contentEl.createEl('p', { text: t('cloud_saved', { path }) });
    this.buttons(
      { text: t('cloud_open'), cta: true, onClick: () => this.options.openFile(path) },
      { text: t('cloud_close'), onClick: () => this.close() }
    );
  }
}
