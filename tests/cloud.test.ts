import { describe, expect, it } from 'vitest';

import { Cloud, CloudError, type Http, type HttpRequest, streamError } from '../src/cloud/api';
import {
  buildDeck,
  confirmDesign,
  detectLocale,
  type JobHooks,
  type JobState,
  makePreviews,
  noteSource,
  type Progress,
  startDeck,
} from '../src/cloud/job';
import { connectPair, waitForApproval } from '../src/cloud/session';

const TOKEN = 'a'.repeat(64);
const PPTX = new Uint8Array([80, 75, 3, 4]).buffer;

type Handler = (body: Record<string, unknown>, request: HttpRequest) => { status?: number; data?: unknown; text?: string; headers?: Record<string, string>; file?: ArrayBuffer };

/** A fake EditablePPT server: one handler per "METHOD path"; records every call. */
function fakeServer(handlers: Record<string, Handler>) {
  const calls: { route: string; body: Record<string, unknown>; auth?: string }[] = [];
  const http: Http = async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const body = (request.body ? JSON.parse(request.body) : Object.fromEntries(url.searchParams)) as Record<string, unknown>;
    calls.push({ route, body, auth: request.headers.Authorization });
    const handler = handlers[route];
    if (!handler) throw new Error(`unexpected ${route}`);
    const result = handler(body, request);
    const status = result.status ?? 200;
    const text =
      result.text ??
      JSON.stringify(status >= 400 ? { code: -1, message: String(result.data) } : { code: 0, data: result.data });
    return {
      status,
      headers: result.headers ?? {},
      text: () => text,
      arrayBuffer: () => result.file ?? new ArrayBuffer(0),
    };
  };
  return { http, calls };
}

function hooks() {
  const saved: JobState[] = [];
  const progress: Progress[] = [];
  const value: JobHooks = {
    save: async (state) => {
      saved.push(JSON.parse(JSON.stringify(state)) as JobState);
    },
    progress: (p) => progress.push(p),
    sleep: async () => {},
  };
  return { value, saved, progress };
}

const slide = (index: number, status: string) => ({
  id: `s${index}`,
  index,
  title: `Slide ${index + 1}`,
  subtitle: '',
  body: ['point'],
  speakerNotes: '',
  status,
  imageUrl: status === 'ready' ? `https://cdn.test/${index}.png` : null,
  error: null,
});

describe('note source', () => {
  it('leaves out front matter and private comments, and finds the title', () => {
    const note = noteSource('---\ntags: x\n---\n# Quarterly review\n\nRevenue %%secret%% grew.\n', 'Q3');
    expect(note).toEqual({ title: 'Quarterly review', text: '# Quarterly review\n\nRevenue  grew.', fileName: 'Q3' });
    expect(noteSource('---\ntitle: From front matter\n---\nbody', 'f').title).toBe('From front matter');
    expect(noteSource('just text', 'File name').title).toBe('File name');
  });

  it('detects Chinese notes', () => {
    expect(detectLocale('季度复盘：收入增长了 20%，主要来自海外市场。')).toBe('zh');
    expect(detectLocale('Quarterly review: revenue grew by 20% overseas.')).toBe('en');
  });
});

describe('deck pipeline', () => {
  it('goes from a note to a saved deck with the bearer key on every call', async () => {
    let outlineRevision = 0;
    let deckStatus = 'planning';
    let slides = [slide(0, 'pending'), slide(1, 'pending')];
    let previewPolls = 0;
    const conversions: Record<string, number> = {};
    const deck = () => ({
      id: 'p1',
      topic: 'Q3',
      title: 'Quarterly review',
      status: deckStatus,
      outlineRevision,
      slideCount: slides.length,
      readySlideCount: slides.filter((s) => s.status === 'ready').length,
      error: null,
      slides,
    });
    const preview = (status: string) => ({
      outlineRevision,
      options: [
        { id: 'v', layout: 'visual', status, imageUrl: status === 'ready' ? 'https://cdn.test/v.png' : null, error: null },
        { id: 's', layout: 'structured', status, imageUrl: status === 'ready' ? 'https://cdn.test/s.png' : null, error: null },
      ],
    });
    const { http, calls } = fakeServer({
      'POST /api/presentations/generate': () => ({ data: { presentation: deck(), accessToken: TOKEN } }),
      'POST /api/presentations/status': () => ({ data: deck() }),
      'POST /api/presentations/chat': (body) => {
        expect(body.mode).toBe('direct');
        const [file] = body.attachments as { mediaType: string; url: string }[];
        expect(file!.mediaType).toBe('text/markdown');
        const text = new TextDecoder().decode(
          Uint8Array.from(atob(file!.url.split(',')[1]!), (c) => c.charCodeAt(0))
        );
        expect(text).toContain('收入');
        expect(text).not.toContain('secret');
        outlineRevision = 1;
        deckStatus = 'outline_ready';
        return { text: 'data: {"type":"text-delta","delta":"ok"}\n\ndata: [DONE]\n' };
      },
      'POST /api/presentations/previews': (body) => {
        if (body.action === 'start') return { data: preview('rendering') };
        previewPolls += 1;
        return { data: preview(previewPolls > 1 ? 'ready' : 'rendering') };
      },
      'POST /api/presentations/confirm': (body) => {
        expect(body.previewId).toBe('s');
        deckStatus = 'rendering';
        return { data: deck() };
      },
      'POST /api/presentations/render': (body) => {
        slides = slides.map((s) => (s.id === body.slideId ? slide(s.index, 'ready') : s));
        if (slides.every((s) => s.status === 'ready')) deckStatus = 'ready';
        return { data: deck() };
      },
      'POST /api/presentations/layered': (body) => {
        conversions[`c-${String(body.slideId)}`] = 0;
        return { data: { id: `c-${String(body.slideId)}`, status: 'processing', progress: 0 } };
      },
      'GET /api/image-conversions': (body) => {
        const id = String(body.id);
        conversions[id] = (conversions[id] ?? 0) + 1;
        const status = id === 'c-s1' ? 'failed' : conversions[id]! > 1 ? 'success' : 'processing';
        return { data: { id, status, progress: 50 } };
      },
      'POST /api/presentations/export/pptx': () => ({ file: PPTX, headers: { 'x-skipped-slides': '2' } }),
    });
    const cloud = new Cloud(http, 'https://editableppt.test', () => 'sk_test');
    const { value, saved, progress } = hooks();

    const note = noteSource('# 季度复盘\n\n收入增长 %%secret%%\n', 'Q3');
    const started = await startDeck(cloud, { note, notePath: 'Q3.md', style: 'clean-tech-blue', locale: 'auto' }, value);
    expect(started.deck.status).toBe('outline_ready');
    expect(calls[0]!.body).toMatchObject({ style: 'clean-tech-blue', locale: 'auto' });
    const kickoff = calls.find((call) => call.route.endsWith('/chat'))!.body.message as string;
    expect(kickoff).toContain('请直接根据附件笔记');

    const job = started.state;
    const previews = await makePreviews(cloud, job, started.deck, value);
    expect(previews.options.every((o) => o.status === 'ready')).toBe(true);
    expect(job.stage).toBe('design');

    await confirmDesign(cloud, job, started.deck, 's', value);
    expect(job.stage).toBe('build');

    const built = await buildDeck(cloud, job, value);
    expect(built.data).toBe(PPTX);
    expect(built.skipped).toEqual([2]);
    expect(job.layers).toEqual({ s0: 'c-s0', s1: 'c-s1' });
    expect(saved.at(-1)!.layers).toEqual({ s0: 'c-s0', s1: 'c-s1' });
    expect(progress).toContainEqual({ phase: 'drawing', done: 2, total: 2 });
    expect(progress).toContainEqual({ phase: 'editable', done: 2, total: 2 });
    expect(calls.every((call) => call.auth === 'Bearer sk_test')).toBe(true);

    // Running the build again after an interruption starts no new work.
    const before = calls.filter((call) => /render|layered/.test(call.route)).length;
    await buildDeck(cloud, job, value);
    expect(calls.filter((call) => /render|layered/.test(call.route)).length).toBe(before);
  });

  it('stops on a missing balance instead of retrying', async () => {
    let renders = 0;
    const { http } = fakeServer({
      'POST /api/presentations/status': () => ({
        data: {
          id: 'p1', topic: 't', title: 't', status: 'rendering', outlineRevision: 1,
          slideCount: 1, readySlideCount: 0, error: null, slides: [slide(0, 'pending')],
        },
      }),
      'POST /api/presentations/render': () => {
        renders += 1;
        return { status: 402, data: 'Usage settlement is pending or credits are insufficient' };
      },
    });
    const cloud = new Cloud(http, 'https://x.test', () => 'sk_test');
    const job: JobState = {
      presentationId: 'p1', accessToken: TOKEN, notePath: 'n.md', title: 't',
      stage: 'build', layers: {}, createdAt: 0,
    };
    await expect(buildDeck(cloud, job, hooks().value)).rejects.toMatchObject({ status: 402 });
    expect(renders).toBe(1);
  });

  it('reports an outline the model failed to write', async () => {
    const { http } = fakeServer({
      'POST /api/presentations/generate': () => ({
        data: { presentation: { id: 'p1', outlineRevision: 0, status: 'planning', slides: [] }, accessToken: TOKEN },
      }),
      'POST /api/presentations/status': () => ({
        data: { id: 'p1', outlineRevision: 0, status: 'planning', slides: [] },
      }),
      'POST /api/presentations/chat': () => ({
        text: 'data: {"type":"error","errorText":"The AI response was interrupted. Please try again."}\n',
      }),
    });
    const cloud = new Cloud(http, 'https://x.test', () => 'sk_test');
    const note = noteSource('# Hi\n\ntext', 'Hi');
    await expect(
      startDeck(cloud, { note, notePath: 'Hi.md', style: 'x', locale: 'en' }, hooks().value)
    ).rejects.toThrow('The AI response was interrupted');
  });
});

describe('api client', () => {
  it('turns API errors and unreachable servers into CloudErrors', async () => {
    const down = new Cloud(async () => { throw new Error('ENOTFOUND'); }, 'https://x.test', () => null);
    await expect(down.me()).rejects.toMatchObject({ status: 0 });
    const { http } = fakeServer({ 'GET /api/obsidian/me': () => ({ status: 401, data: 'Sign in to continue' }) });
    const error = await new Cloud(http, 'https://x.test', () => 'sk').me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudError);
    expect(error).toMatchObject({ status: 401, message: 'Sign in to continue' });
  });

  it('finds the error in an outline stream', () => {
    expect(streamError('data: {"type":"start"}\n\ndata: {"type":"error","errorText":"boom"}\n')).toBe('boom');
    expect(streamError('data: {"type":"finish"}\n\ndata: [DONE]\n')).toBeNull();
  });
});

describe('sign-in', () => {
  it('makes a verifier the website accepts and a matching S256 challenge', async () => {
    const { verifier, challenge } = await connectPair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(Buffer.from(digest).toString('base64url')).toBe(challenge);
  });

  it('polls until the user approves, riding out throttling', async () => {
    let polls = 0;
    const { http, calls } = fakeServer({
      'POST /api/obsidian/token': () => {
        polls += 1;
        if (polls === 1) return { status: 429, data: 'Too many requests' };
        if (polls < 3) return { data: { status: 'pending' } };
        return { data: { status: 'approved', token: 'sk_new', account: { id: 'u', name: 'U', email: 'u@test' } } };
      },
    });
    const cloud = new Cloud(http, 'https://x.test', () => null);
    const result = await waitForApproval(cloud, 'v'.repeat(43), async () => {});
    expect(result).toMatchObject({ status: 'approved', token: 'sk_new' });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.auth).toBeUndefined();
  });
});
