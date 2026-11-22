import { toBase64 } from '../image';
import { splitFrontMatter } from '../parse';
import {
  type Cloud,
  CloudError,
  type Conversion,
  type DeckSnapshot,
  type PreviewSnapshot,
  streamError,
} from './api';

export type DeckLocale = 'auto' | 'zh' | 'en';

/** What the plugin keeps between sessions about the deck being made. */
export interface JobState {
  presentationId: string;
  accessToken: string;
  notePath: string;
  title: string;
  /** What the job waits for: the outline review, the design pick, or the build. */
  stage: 'outline' | 'design' | 'build';
  /** Layered conversion id of each slide, by slide id. */
  layers: Record<string, string>;
  createdAt: number;
}

export type Progress =
  | { phase: 'outline' }
  | { phase: 'previews' }
  | { phase: 'drawing'; done: number; total: number }
  | { phase: 'editable'; done: number; total: number }
  | { phase: 'saving' };

export interface JobHooks {
  save(state: JobState): Promise<void>;
  progress(progress: Progress): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface NoteSource {
  title: string;
  /** The note as sent: no front matter, no %%comments%%. */
  text: string;
  fileName: string;
}

export interface BuiltDeck {
  data: ArrayBuffer;
  /** 1-based numbers of slides that could not be made editable (left out). */
  skipped: number[];
}

const STATUS_POLL_MS = 2500;
const PREVIEW_POLL_MS = 3000;
const LAYER_POLL_MS = 4000;
const RENDER_CONCURRENCY = 2;
const RENDER_ATTEMPTS = 3;
/** Rounds that send failed slides back to be drawn again. */
const RENDER_ROUNDS = 3;
/** A slide still drawing after this long is asked for again (a lost request). */
const RENDER_NUDGE_MS = 60_000;
const PREVIEW_TIMEOUT_MS = 8 * 60_000;
const MAX_TOPIC = 1000;

const transient = (error: unknown) =>
  !(error instanceof CloudError) || error.status === 0 || error.status === 429 || error.status >= 500;

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CloudError('Stopped', 499);
}

/** The note's text as it is sent: without front matter or private %%comments%%. */
export function noteSource(markdown: string, fileName: string): NoteSource {
  const { body, fields } = splitFrontMatter(markdown);
  const text = body.replace(/%%[\s\S]*?%%/g, '').trim();
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  return { title: (fields.title || heading || fileName).trim(), text, fileName };
}

/** Chinese when CJK characters make up a good share of the letters. */
export function detectLocale(text: string): 'zh' | 'en' {
  const cjk = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk > 0 && cjk * 4 >= latin ? 'zh' : 'en';
}

function kickoff(note: NoteSource, locale: 'zh' | 'en') {
  return locale === 'zh'
    ? `请直接根据附件笔记《${note.fileName}》生成完整的演示文稿大纲，不要提问。忠实保留笔记里的事实、数据和结构。\n主题：${note.title}`
    : `Write the complete presentation outline from the attached note "${note.fileName}" right away, without asking questions. Keep the note's facts, figures and structure.\nTopic: ${note.title}`;
}

function markdownAttachment(note: NoteSource) {
  const name = `${note.fileName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180)}.md`;
  return {
    type: 'file',
    filename: name,
    mediaType: 'text/markdown',
    url: `data:text/markdown;base64,${toBase64(new TextEncoder().encode(note.text))}`,
  };
}

export function deckStatus(cloud: Cloud, state: JobState) {
  return cloud.json<DeckSnapshot>('POST', '/api/presentations/status', {
    presentationId: state.presentationId,
    accessToken: state.accessToken,
  });
}

/** Writes (or rewrites) the outline from the note; resolves with the new deck. */
export async function writeOutline(
  cloud: Cloud,
  state: JobState,
  note: NoteSource,
  locale: 'zh' | 'en',
  hooks: JobHooks
) {
  hooks.progress({ phase: 'outline' });
  const before = await deckStatus(cloud, state);
  const stream = await cloud.stream('/api/presentations/chat', {
    presentationId: state.presentationId,
    accessToken: state.accessToken,
    expectedRevision: before.outlineRevision,
    message: kickoff(note, locale),
    mode: 'direct',
    attachments: [markdownAttachment(note)],
  });
  const deck = await deckStatus(cloud, state);
  if (deck.status !== 'outline_ready' || deck.outlineRevision === before.outlineRevision)
    throw new CloudError(streamError(stream) || 'The outline could not be written. Try again.', 502);
  state.stage = 'outline';
  await hooks.save(state);
  return deck;
}

/** Creates the deck on EditablePPT, then writes its outline from the note. */
export async function startDeck(
  cloud: Cloud,
  input: { note: NoteSource; notePath: string; style: string; locale: DeckLocale },
  hooks: JobHooks
) {
  hooks.progress({ phase: 'outline' });
  const { note } = input;
  const topic = `${note.title}\n\n${note.text}`.slice(0, MAX_TOPIC).trim().padEnd(3, '.');
  const created = await cloud.json<{ presentation: DeckSnapshot; accessToken: string }>(
    'POST',
    '/api/presentations/generate',
    { topic, style: input.style, locale: input.locale }
  );
  const state: JobState = {
    presentationId: created.presentation.id,
    accessToken: created.accessToken,
    notePath: input.notePath,
    title: note.title,
    stage: 'outline',
    layers: {},
    createdAt: Date.now(),
  };
  await hooks.save(state);
  const locale = input.locale === 'auto' ? detectLocale(note.text) : input.locale;
  const deck = await writeOutline(cloud, state, note, locale, hooks);
  return { state, deck };
}

const settled = (preview: PreviewSnapshot) =>
  preview.options.length > 0 &&
  preview.options.every((option) => option.status === 'ready' || option.status === 'failed');

/** Draws the design previews (two layouts of the chosen style) and waits for them. */
export async function makePreviews(
  cloud: Cloud,
  state: JobState,
  deck: DeckSnapshot,
  hooks: JobHooks,
  signal?: AbortSignal
) {
  hooks.progress({ phase: 'previews' });
  const access = { presentationId: state.presentationId, accessToken: state.accessToken };
  const current = deck.previews?.outlineRevision === deck.outlineRevision ? deck.previews : null;
  const needsStart =
    !current || current.options.length === 0 || current.options.some((option) => option.status === 'failed');
  let preview = needsStart
    ? await cloud.json<PreviewSnapshot>('POST', '/api/presentations/previews', {
        action: 'start',
        ...access,
        expectedRevision: deck.outlineRevision,
      })
    : current;
  state.stage = 'design';
  await hooks.save(state);
  const until = Date.now() + PREVIEW_TIMEOUT_MS;
  while (!settled(preview)) {
    aborted(signal);
    if (Date.now() > until) throw new CloudError('The previews are taking too long. Try again.', 504);
    await hooks.sleep(PREVIEW_POLL_MS, signal);
    preview = await cloud
      .json<PreviewSnapshot>('POST', '/api/presentations/previews', { action: 'status', ...access })
      .catch((error: unknown) => {
        if (transient(error)) return preview;
        throw error;
      });
  }
  return preview;
}

export async function confirmDesign(
  cloud: Cloud,
  state: JobState,
  deck: DeckSnapshot,
  previewId: string,
  hooks: JobHooks
) {
  const confirmed = await cloud.json<DeckSnapshot>('POST', '/api/presentations/confirm', {
    presentationId: state.presentationId,
    accessToken: state.accessToken,
    expectedRevision: deck.outlineRevision,
    previewId,
  });
  state.stage = 'build';
  await hooks.save(state);
  return confirmed;
}

async function withRetry<T>(task: () => Promise<T>, hooks: JobHooks, signal?: AbortSignal) {
  for (let attempt = 1; ; attempt += 1) {
    aborted(signal);
    try {
      return await task();
    } catch (error) {
      if (attempt >= RENDER_ATTEMPTS || !transient(error)) throw error;
      await hooks.sleep(1500 * 2 ** (attempt - 1), signal);
    }
  }
}

async function eachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await task(item);
      }
    })
  );
}

/** Draws every slide that isn't drawn yet, then waits until none is drawing. */
async function drawSlides(cloud: Cloud, state: JobState, hooks: JobHooks, signal?: AbortSignal) {
  const access = { presentationId: state.presentationId, accessToken: state.accessToken };
  let deck = await deckStatus(cloud, state);
  const report = () =>
    hooks.progress({ phase: 'drawing', done: deck.readySlideCount, total: deck.slides.length });
  for (let round = 0; round < RENDER_ROUNDS; round += 1) {
    const todo = deck.slides.filter(
      (slide) => slide.status === 'pending' || (round > 0 && slide.status === 'failed')
    );
    report();
    let stop: Error | undefined;
    await eachLimited(todo, RENDER_CONCURRENCY, async (slide) => {
      if (stop) return;
      try {
        const snapshot = await withRetry(
          () =>
            cloud.json<DeckSnapshot>('POST', '/api/presentations/render', {
              ...access,
              slideId: slide.id,
            }),
          hooks,
          signal
        );
        deck = { ...snapshot, readySlideCount: Math.max(snapshot.readySlideCount, deck.readySlideCount) };
        report();
      } catch (error) {
        stop = error instanceof Error ? error : new Error('Slide drawing failed');
      }
    });
    if (stop) throw stop;
    // Slides drawn by the image provider in the background finish through status polls.
    let nudged = Date.now();
    for (;;) {
      deck = await withRetry(() => deckStatus(cloud, state), hooks, signal);
      report();
      const drawing = deck.slides.filter(
        (slide) => slide.status === 'pending' || slide.status === 'rendering'
      );
      if (!drawing.length) break;
      if (Date.now() - nudged > RENDER_NUDGE_MS) {
        nudged = Date.now();
        // Only a slide whose own request was lost is drawn again; the rest just report.
        for (const slide of drawing)
          await cloud
            .json('POST', '/api/presentations/render', { ...access, slideId: slide.id })
            .catch((error: unknown) => {
              // Signed out or out of credits stops; anything else is reported by the next poll.
              if (error instanceof CloudError && (error.status === 401 || error.status === 402))
                throw error;
            });
      }
      await hooks.sleep(STATUS_POLL_MS, signal);
    }
    if (!deck.slides.some((slide) => slide.status === 'failed')) return deck;
  }
  const failed = deck.slides.find((slide) => slide.status === 'failed');
  throw new CloudError(
    `Slide ${(failed?.index ?? 0) + 1} could not be drawn${failed?.error ? `: ${failed.error}` : ''}`,
    502
  );
}

/** Tries per slide, matching the website's limit: the first split and two retries. */
const SPLIT_ATTEMPTS = 3;

/**
 * Splits each drawn slide into editable layers and waits for every split. A
 * failed split is started again (its credits were refunded) up to
 * SPLIT_ATTEMPTS times. Resolves with the 1-based numbers of slides that still
 * failed.
 */
async function splitSlides(
  cloud: Cloud,
  state: JobState,
  deck: DeckSnapshot,
  hooks: JobHooks,
  signal?: AbortSignal
) {
  const slides = [...deck.slides].sort((a, b) => a.index - b.index);
  const access = { presentationId: state.presentationId, accessToken: state.accessToken };
  const done = new Map<string, 'success' | 'failed'>();
  const tries = new Map<string, number>();
  const report = () => hooks.progress({ phase: 'editable', done: done.size, total: slides.length });
  const start = async (slideId: string, retry: boolean) => {
    const task = await withRetry(
      () =>
        cloud.json<Conversion>('POST', '/api/presentations/layered', {
          ...access,
          slideId,
          ...(retry ? { retry: true } : {}),
        }),
      hooks,
      signal
    );
    tries.set(slideId, (tries.get(slideId) ?? 0) + 1);
    state.layers[slideId] = task.id;
    await hooks.save(state);
    return task;
  };
  report();
  for (const slide of slides) {
    if (state.layers[slide.id]) continue;
    aborted(signal);
    await start(slide.id, false);
  }
  for (;;) {
    for (const slide of slides) {
      if (done.has(slide.id)) continue;
      aborted(signal);
      const id = state.layers[slide.id]!;
      const task = await cloud
        .json<Conversion>('GET', `/api/image-conversions?id=${encodeURIComponent(id)}`)
        .catch((error: unknown) => {
          if (transient(error)) return null;
          throw error;
        });
      if (!task) continue;
      if (task.status === 'success') done.set(slide.id, 'success');
      else if (task.status === 'failed' || task.status === 'canceled') {
        // Pre-existing layers (not started in this run) are not retried on resume.
        if ((tries.get(slide.id) ?? SPLIT_ATTEMPTS) < SPLIT_ATTEMPTS) {
          const next = await start(slide.id, true).catch((error: unknown) => {
            if (error instanceof CloudError && error.status === 402) throw error;
            return null;
          });
          if (next && next.id !== id) continue;
        }
        done.set(slide.id, 'failed');
      }
    }
    report();
    if (done.size >= slides.length)
      return slides.filter((slide) => done.get(slide.id) === 'failed').map((slide) => slide.index + 1);
    await hooks.sleep(LAYER_POLL_MS, signal);
  }
}

/**
 * Takes a confirmed deck to a finished .pptx: draws the slides, makes each one
 * editable, then downloads the file. Safe to run again after an interruption;
 * finished steps are skipped.
 */
export async function buildDeck(
  cloud: Cloud,
  state: JobState,
  hooks: JobHooks,
  signal?: AbortSignal
): Promise<BuiltDeck> {
  const deck = await drawSlides(cloud, state, hooks, signal);
  const failed = await splitSlides(cloud, state, deck, hooks, signal);
  hooks.progress({ phase: 'saving' });
  const { data, headers } = await withRetry(
    () =>
      cloud.file('/api/presentations/export/pptx', {
        presentationId: state.presentationId,
        accessToken: state.accessToken,
      }),
    hooks,
    signal
  );
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-skipped-slides')?.[1];
  const reported = (header ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const skipped = [...new Set([...failed, ...reported])].sort((a, b) => a - b);
  return { data, skipped };
}
