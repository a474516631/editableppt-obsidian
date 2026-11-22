/**
 * The EditablePPT web API, used only by the optional AI design feature.
 * Requests go through a transport the caller provides (Obsidian's
 * `requestUrl` in the plugin, a fake in tests), so nothing here touches the
 * network on its own.
 */

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: () => string;
  arrayBuffer: () => ArrayBuffer;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export class CloudError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the server could not be reached. */
    readonly status: number
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface Account {
  account: { id: string; name: string; email: string };
  balance: number;
  costs: { standard: number; layered: number };
}

export interface StyleOption {
  id: string;
  kind: 'template' | 'library';
  name: string;
  tagline: string;
  dark: boolean;
  palette: string[];
  image: string | null;
}

export type DeckStatus = 'planning' | 'outline_ready' | 'rendering' | 'ready' | 'failed';
export type SlideStatus = 'pending' | 'rendering' | 'ready' | 'failed';

export interface SlideSnapshot {
  id: string;
  index: number;
  title: string;
  subtitle: string;
  body: string[];
  speakerNotes: string;
  status: SlideStatus;
  imageUrl: string | null;
  error: string | null;
}

export interface PreviewOption {
  id: string;
  layout: 'visual' | 'structured' | null;
  status: 'queued' | 'starting' | 'rendering' | 'ready' | 'failed';
  imageUrl: string | null;
  error: string | null;
}

export interface PreviewSnapshot {
  outlineRevision: number;
  options: PreviewOption[];
}

export interface DeckSnapshot {
  id: string;
  topic: string;
  title: string;
  status: DeckStatus;
  outlineRevision: number;
  slideCount: number;
  readySlideCount: number;
  previews?: PreviewSnapshot | null;
  error: string | null;
  slides: SlideSnapshot[];
}

export interface Conversion {
  id: string;
  status: 'pending' | 'processing' | 'success' | 'failed' | 'canceled';
  progress: number;
  error?: string;
}

interface Envelope<T> {
  code: number;
  message?: string;
  data?: T;
}

export class Cloud {
  constructor(
    private readonly http: Http,
    readonly base: string,
    private readonly token: () => string | null
  ) {}

  private async send(method: 'GET' | 'POST', path: string, body?: unknown) {
    const token = this.token();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.http({
        url: this.base + path,
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new CloudError(
        error instanceof Error ? error.message : 'Network request failed',
        0
      );
    }
  }

  private static fail(status: number, text: string): never {
    let message = '';
    try {
      message = (JSON.parse(text) as Envelope<unknown>).message ?? '';
    } catch {
      // Not the API's JSON (a proxy or gateway page).
    }
    throw new CloudError(message || `Request failed (HTTP ${status})`, status >= 400 ? status : 400);
  }

  /** A JSON endpoint: the `data` of `{ code: 0, data }`, or a CloudError. */
  async json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    const text = response.text();
    let envelope: Envelope<T> | undefined;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      envelope = undefined;
    }
    if (response.status >= 400 || !envelope || envelope.code !== 0)
      Cloud.fail(response.status, text);
    return envelope.data as T;
  }

  /** An endpoint that streams text (the outline writer); read to the end. */
  async stream(path: string, body: unknown): Promise<string> {
    const response = await this.send('POST', path, body);
    const text = response.text();
    if (response.status >= 400) Cloud.fail(response.status, text);
    return text;
  }

  /** A file download, with its response headers. */
  async file(path: string, body: unknown) {
    const response = await this.send('POST', path, body);
    if (response.status >= 400) Cloud.fail(response.status, response.text());
    return { data: response.arrayBuffer(), headers: response.headers };
  }

  me() {
    return this.json<Account>('GET', '/api/obsidian/me');
  }

  styles(locale: 'zh' | 'en') {
    return this.json<StyleOption[]>('GET', `/api/presentations/styles?locale=${locale}`);
  }
}

/** The text of the first error part in an AI SDK UI message stream. */
export function streamError(stream: string) {
  for (const line of stream.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const part = JSON.parse(line.slice(5).trim()) as { type?: string; errorText?: string };
      if (part.type === 'error') return part.errorText || 'The outline could not be written';
    } catch {
      // [DONE] or a partial line.
    }
  }
  return null;
}
