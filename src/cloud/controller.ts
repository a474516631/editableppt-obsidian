import { Notice, requestUrl, type TFile } from 'obsidian';

import { t } from '../i18n';
import { type Account, Cloud, CloudError, type DeckSnapshot, type Http, type PreviewSnapshot } from './api';
import {
  buildDeck,
  confirmDesign,
  type DeckLocale,
  deckStatus,
  detectLocale,
  type JobHooks,
  type JobState,
  makePreviews,
  noteSource,
  type Progress,
  startDeck,
  writeOutline,
} from './job';
import { connectPair, connectUrl, waitForApproval } from './session';

export const SERVICE_URL = 'https://editableppt.com';
const TOKEN_SECRET = 'note-to-powerpoint-editableppt-key';

/** What the plugin needs from its host; keeps this file testable. */
export interface DeckHost {
  serviceUrl(): string;
  job(): JobState | null;
  saveJob(job: JobState | null): Promise<void>;
  readNote(path: string): Promise<{ markdown: string; basename: string } | null>;
  /** Writes the finished file; resolves with its vault path, or null if the user cancels. */
  saveDeck(job: JobState, data: ArrayBuffer): Promise<string | null>;
  /** Called with the saved file; opens it if the user wants that. */
  openFile(path: string): void;
}

/** Obsidian's keychain (`app.secretStorage`, 1.11.4+). */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export type Busy = 'signin' | 'outline' | 'previews' | 'confirm' | 'build' | null;

const http: Http = async (request) => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    contentType: request.headers['Content-Type'],
    throw: false,
  });
  return {
    status: response.status,
    headers: response.headers,
    text: () => response.text,
    arrayBuffer: () => response.arrayBuffer,
  };
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      window.clearTimeout(timer);
      reject(new CloudError('Stopped', 499));
    }
    signal?.addEventListener('abort', stop, { once: true });
  });

/** A message a person can act on, for any failure. */
export function describeError(error: unknown) {
  if (error instanceof CloudError) {
    if (error.status === 401) return t('cloud_error_signin');
    // 402 is also "earlier usage is still being priced", which passes by itself.
    if (error.status === 402)
      return /settlement|settle/i.test(error.message) ? t('cloud_error_settling') : t('cloud_error_credits');
    if (error.status === 0) return t('cloud_error_network');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The optional AI design feature: sign-in, the deck being made, and its build.
 * The build runs in the background, so closing the dialog doesn't stop it.
 */
export class DeckController {
  readonly cloud: Cloud;
  account: Account | null = null;
  busy: Busy = null;
  progress: Progress | null = null;
  error: string | null = null;
  /** The latest deck snapshot (outline and status). */
  deck: DeckSnapshot | null = null;
  previews: PreviewSnapshot | null = null;
  /** Vault path of the file the last build saved. */
  savedPath: string | null = null;
  /** Slides (1-based) the last build left out because they could not be made editable. */
  skipped: number[] = [];
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private memoryToken: string | null = null;

  constructor(
    private readonly host: DeckHost,
    private readonly secrets: SecretStore | undefined
  ) {
    this.cloud = new Cloud(http, host.serviceUrl().replace(/\/+$/, ''), () => this.token());
  }

  /** Obsidian keeps the key in its keychain (1.11.4+), outside the vault. */
  get supported() {
    return Boolean(this.secrets);
  }

  token() {
    return this.secrets?.getSecret(TOKEN_SECRET) || this.memoryToken || null;
  }

  get signedIn() {
    return Boolean(this.token());
  }

  get job() {
    return this.host.job();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private hooks(): JobHooks {
    return {
      save: (state) => this.host.saveJob(state),
      progress: (progress) => {
        this.progress = progress;
        this.changed();
      },
      sleep,
    };
  }

  private setToken(token: string | null) {
    this.memoryToken = token;
    this.secrets?.setSecret(TOKEN_SECRET, token ?? '');
  }

  private async run<T>(busy: Exclude<Busy, null>, task: (signal: AbortSignal) => Promise<T>) {
    if (this.busy) return undefined;
    this.busy = busy;
    this.error = null;
    this.abort = new AbortController();
    this.changed();
    try {
      return await task(this.abort.signal);
    } catch (error) {
      if (error instanceof CloudError && error.status === 499) return undefined;
      if (error instanceof CloudError && error.status === 401 && busy !== 'signin') {
        this.setToken(null);
        this.account = null;
      }
      this.error = describeError(error);
      return undefined;
    } finally {
      this.busy = null;
      this.progress = null;
      this.abort = null;
      this.changed();
    }
  }

  /** Stops whatever is running (the deck itself is kept). */
  stop() {
    this.abort?.abort();
  }

  async refreshAccount() {
    if (!this.signedIn) {
      this.account = null;
      this.changed();
      return;
    }
    try {
      this.account = await this.cloud.me();
    } catch (error) {
      if (error instanceof CloudError && error.status === 401) {
        this.setToken(null);
        this.account = null;
      }
    }
    this.changed();
  }

  signIn() {
    return this.run('signin', async (signal) => {
      const { verifier, challenge } = await connectPair();
      window.open(connectUrl(this.cloud.base, challenge));
      const approved = await waitForApproval(this.cloud, verifier, sleep, signal);
      this.setToken(approved.token);
      this.account = await this.cloud.me().catch(() => null);
      new Notice(t('cloud_signed_in', { email: approved.account.email }));
    });
  }

  async signOut() {
    this.stop();
    if (this.signedIn) await this.cloud.json('POST', '/api/obsidian/logout').catch(() => undefined);
    this.setToken(null);
    this.account = null;
    this.changed();
  }

  /** Creates a deck for the note and writes its outline. */
  start(file: TFile, markdown: string, style: string, locale: DeckLocale) {
    return this.run('outline', async () => {
      const note = noteSource(markdown, file.basename);
      if (!note.text) throw new Error(t('empty'));
      this.savedPath = null;
      this.previews = null;
      const { deck } = await startDeck(this.cloud, { note, notePath: file.path, style, locale }, this.hooks());
      this.deck = deck;
    });
  }

  /** Writes the outline again, for a deck whose first attempt failed. */
  retryOutline() {
    return this.run('outline', async () => {
      const job = this.requireJob();
      const note = await this.host.readNote(job.notePath);
      if (!note) throw new Error(t('cloud_note_missing'));
      const source = noteSource(note.markdown, note.basename);
      this.deck = await writeOutline(this.cloud, job, source, detectLocale(source.text), this.hooks());
    });
  }

  /** The current deck snapshot, fetched when the dialog reopens. */
  load() {
    return this.run('outline', async () => {
      this.deck = await deckStatus(this.cloud, this.requireJob());
      if (this.deck.previews?.outlineRevision === this.deck.outlineRevision) this.previews = this.deck.previews;
    });
  }

  makePreviews() {
    return this.run('previews', async (signal) => {
      const job = this.requireJob();
      const deck = this.deck ?? (await deckStatus(this.cloud, job));
      this.deck = deck;
      this.previews = await makePreviews(this.cloud, job, deck, this.hooks(), signal);
    });
  }

  async confirm(previewId: string) {
    const ok = await this.run('confirm', async () => {
      const job = this.requireJob();
      const deck = this.deck ?? (await deckStatus(this.cloud, job));
      this.deck = await confirmDesign(this.cloud, job, deck, previewId, this.hooks());
      return true;
    });
    if (ok) void this.build();
  }

  /** Draws, splits and saves the confirmed deck; runs in the background. */
  build() {
    return this.run('build', async (signal) => {
      const job = this.requireJob();
      // When retrying after skipped slides, clear those layer IDs so they are tried again.
      if (this.skipped.length) {
        const deck = this.deck ?? (await deckStatus(this.cloud, job).catch(() => null));
        if (deck) {
          for (const index of this.skipped) {
            const slide = deck.slides.find((s) => s.index + 1 === index);
            if (slide) delete job.layers[slide.id];
          }
          await this.host.saveJob(job);
        }
        this.skipped = [];
      }
      const result = await buildDeck(this.cloud, job, this.hooks(), signal);
      const path = await this.host.saveDeck(job, result.data);
      if (!path) return;
      this.savedPath = path;
      this.skipped = result.skipped;
      if (result.skipped.length) {
        // Kept so "Try the missing slides again" can finish the deck.
        job.layers = Object.fromEntries(Object.entries(job.layers));
        await this.host.saveJob(job);
        new Notice(t('cloud_skipped', { slides: result.skipped.join(', ') }), 15000);
      } else {
        await this.host.saveJob(null);
        this.deck = null;
        this.previews = null;
        new Notice(t('cloud_saved', { path }), 8000);
      }
      this.host.openFile(path);
      void this.refreshAccount();
    });
  }

  /** Accepts a deck with missing slides as it is and forgets the job. */
  async finish() {
    await this.host.saveJob(null);
    this.skipped = [];
    this.deck = null;
    this.previews = null;
    this.changed();
  }

  /** Forgets the deck in progress. What was already charged stays charged. */
  async discard() {
    this.stop();
    await this.host.saveJob(null);
    this.deck = null;
    this.previews = null;
    this.error = null;
    this.changed();
  }

  private requireJob() {
    const job = this.host.job();
    if (!job) throw new Error(t('cloud_no_job'));
    return job;
  }
}
