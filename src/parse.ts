import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';

import type { Align, Block, ListItem, ParsedNote, Run } from './model';
import { plain } from './model';

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|bmp|webp|avif|svg)$/i;

export const isImagePath = (path: string) =>
  IMAGE_EXTENSION.test(path.split(/[?#]/)[0] ?? '');

/** Splits `Note#Heading|Alias` into its parts. */
export function parseWikilink(inner: string) {
  const bar = inner.indexOf('|');
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
  const hash = target.indexOf('#');
  return {
    path: hash < 0 ? target : target.slice(0, hash),
    subpath: hash < 0 ? '' : target.slice(hash + 1),
    alias,
  };
}

function wikilinkLabel(inner: string) {
  const { path, subpath, alias } = parseWikilink(inner);
  if (alias) return alias;
  const name = path.split('/').pop() ?? path;
  const section = subpath.replace(/^\^/, '');
  if (!name) return section;
  return section ? `${name} > ${section}` : name;
}

function wikilinkRule(state: StateInline, silent: boolean) {
  const { src, pos } = state;
  const embed = src.charCodeAt(pos) === 0x21;
  const start = embed ? pos + 1 : pos;
  if (!src.startsWith('[[', start)) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner.trim() || /[\n[\]]/.test(inner)) return false;
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.content = inner;
    token.meta = { embed };
  }
  state.pos = end + 2;
  return true;
}

function markRule(state: StateInline, silent: boolean) {
  const { src, pos, posMax } = state;
  if (!src.startsWith('==', pos) || src.charCodeAt(pos + 2) === 0x3d)
    return false;
  const end = src.indexOf('==', pos + 2);
  if (end < 0 || end > posMax) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes('\n')) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    state.pos = pos + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  state.posMax = posMax;
  return true;
}

/** `$x^2$`, kept out of the emphasis rules so `_` and `*` survive. */
function mathRule(state: StateInline, silent: boolean) {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) === 0x24)
    return false;
  if (/\s/.test(src[pos + 1] ?? ' ')) return false;
  let end = pos + 1;
  for (;;) {
    end = src.indexOf('$', end);
    if (end < 0 || end > state.posMax) return false;
    if (src[end - 1] !== '\\') break;
    end += 1;
  }
  const inner = src.slice(pos + 1, end);
  if (!inner || /\s$/.test(inner) || inner.includes('\n')) return false;
  if (/\d/.test(src[end + 1] ?? '')) return false;
  if (!silent) state.push('math_inline', '', 0).content = inner;
  state.pos = end + 1;
  return true;
}

function createParser() {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
  md.inline.ruler.before('link', 'wikilink', wikilinkRule);
  md.inline.ruler.before('emphasis', 'mark', markRule);
  md.inline.ruler.before('escape', 'math_inline', mathRule);
  return md;
}

let parser: MarkdownIt | undefined;

/** Applies `edit` to every line outside fenced code blocks. */
function outsideFences(text: string, edit: (chunk: string) => string) {
  const out: string[] = [];
  let chunk: string[] = [];
  let fence = '';
  const flush = () => {
    if (chunk.length) out.push(edit(chunk.join('\n')));
    chunk = [];
  };
  for (const line of text.split('\n')) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (match && match[1]!.startsWith(fence) && !line.trim().slice(match[1]!.length))
        fence = '';
    } else if (match) {
      flush();
      fence = match[1]!;
      out.push(line);
    } else chunk.push(line);
  }
  flush();
  return out.join('\n');
}

function unquote(value: string) {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return (quoted ? quoted[2]! : trimmed).trim();
}

export function splitFrontMatter(source: string) {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { body: text, fields: {} as Record<string, string> };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(\S.*)$/.exec(line);
    if (field) fields[field[1]!.toLowerCase()] = unquote(field[2]!);
  }
  return { body: text.slice(match[0].length), fields };
}

function prepare(body: string) {
  return outsideFences(body, (chunk) =>
    chunk
      .replace(/%%[\s\S]*?%%/g, '')
      .replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/gm, '')
      .replace(
        /^[ \t]*\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$[ \t]*$/gm,
        (_all, math: string) => '\n```math\n' + math.trim() + '\n```\n'
      )
  );
}

const stripTags = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

interface Inline {
  runs: Run[];
  images: { src: string; alt: string }[];
}

function readInline(token: Token | undefined): Inline {
  const runs: Run[] = [];
  const images: Inline['images'] = [];
  const style = { bold: 0, italic: 0, strike: 0, highlight: 0 };
  const links: string[] = [];
  let pendingBreak = false;
  const push = (text: string, extra: Partial<Run> = {}) => {
    if (!text) return;
    const run: Run = { text, ...extra };
    if (style.bold) run.bold = true;
    if (style.italic) run.italic = true;
    if (style.strike) run.strike = true;
    if (style.highlight) run.highlight = true;
    const link = links[links.length - 1];
    if (link) run.link = link;
    if (pendingBreak && runs.length) run.breakBefore = true;
    pendingBreak = false;
    runs.push(run);
  };
  for (const child of token?.children ?? []) {
    switch (child.type) {
      case 'text':
        push(child.content);
        break;
      case 'code_inline':
        push(child.content, { code: true });
        break;
      case 'math_inline':
        push(child.content, { italic: true });
        break;
      case 'softbreak':
      case 'hardbreak':
        pendingBreak = true;
        break;
      case 'strong_open':
        style.bold += 1;
        break;
      case 'strong_close':
        style.bold -= 1;
        break;
      case 'em_open':
        style.italic += 1;
        break;
      case 'em_close':
        style.italic -= 1;
        break;
      case 's_open':
        style.strike += 1;
        break;
      case 's_close':
        style.strike -= 1;
        break;
      case 'mark_open':
        style.highlight += 1;
        break;
      case 'mark_close':
        style.highlight -= 1;
        break;
      case 'link_open': {
        const href = child.attrGet('href') ?? '';
        links.push(/^(https?:|mailto:)/i.test(href) ? href : '');
        break;
      }
      case 'link_close':
        links.pop();
        break;
      case 'image':
        images.push({
          src: child.attrGet('src') ?? '',
          alt: child.content.split('|')[0]!.trim(),
        });
        break;
      case 'wikilink': {
        const { path, alias } = parseWikilink(child.content);
        const { embed } = child.meta as { embed: boolean };
        if (embed && isImagePath(path))
          images.push({ src: path, alt: /^\d+(x\d+)?$/.test(alias) ? '' : alias });
        else push(wikilinkLabel(child.content));
        break;
      }
      case 'html_inline':
        if (/^<br\s*\/?>$/i.test(child.content)) pendingBreak = true;
        break;
    }
  }
  const first = runs[0];
  if (first) first.text = first.text.replace(/^\s+/, '');
  return { runs: runs.filter((run) => run.text), images };
}

const TEXT_ALIGN = /text-align:\s*(left|center|right)/;

class Walker {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek() {
    return this.tokens[this.index];
  }

  /** Type of the current token; undefined past the end. */
  private type() {
    return this.tokens[this.index]?.type;
  }

  /** Reads blocks until a token of type `until` at the starting depth. */
  blocks(until?: string): Block[] {
    const out: Block[] = [];
    while (this.type() && this.type() !== until) this.block(out);
    if (until) this.index += 1;
    return out;
  }

  private inline(close: string): Inline {
    this.index += 1;
    const inline = readInline(
      this.peek()?.type === 'inline' ? this.peek() : undefined
    );
    while (this.type() && this.type() !== close) this.index += 1;
    this.index += 1;
    return inline;
  }

  private block(out: Block[]) {
    const token = this.peek()!;
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1));
        const { runs } = this.inline('heading_close');
        if (runs.length) out.push({ type: 'heading', level, runs });
        return;
      }
      case 'paragraph_open': {
        const { runs, images } = this.inline('paragraph_close');
        const note = /^notes?:\s*/i.exec(runs[0]?.text ?? '');
        if (note) {
          runs[0]!.text = runs[0]!.text.slice(note[0].length);
          const text = plain(runs).trim();
          if (text) out.push({ type: 'note', text });
        } else if (runs.length) out.push({ type: 'paragraph', runs });
        for (const image of images) out.push({ type: 'image', ...image });
        return;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const items: ListItem[] = [];
        const trailing: Block[] = [];
        this.list(items, trailing, 0);
        if (items.length) out.push({ type: 'list', items });
        out.push(...trailing);
        return;
      }
      case 'blockquote_open': {
        this.index += 1;
        out.push(...quote(this.blocks('blockquote_close')));
        return;
      }
      case 'fence':
      case 'code_block': {
        this.index += 1;
        const lang = token.info.trim().split(/\s+/)[0] ?? '';
        const text = token.content.replace(/\n+$/, '');
        if (!text.trim()) return;
        out.push(
          lang === 'math' ? { type: 'math', text } : { type: 'code', lang, text }
        );
        return;
      }
      case 'table_open':
        out.push(this.table());
        return;
      case 'hr':
        this.index += 1;
        out.push({ type: 'rule' });
        return;
      case 'html_block': {
        this.index += 1;
        const text = stripTags(token.content);
        if (text) out.push({ type: 'paragraph', runs: [{ text }] });
        return;
      }
      default:
        this.index += 1;
    }
  }

  private list(items: ListItem[], trailing: Block[], level: number) {
    const open = this.peek()!;
    const ordered = open.type === 'ordered_list_open';
    const close = ordered ? 'ordered_list_close' : 'bullet_list_close';
    let number = Number(open.attrGet('start') ?? 1);
    this.index += 1;
    while (this.type() && this.type() !== close) {
      if (this.type() !== 'list_item_open') {
        this.index += 1;
        continue;
      }
      this.index += 1;
      let first = true;
      while (this.type() && this.type() !== 'list_item_close') {
        const type = this.type();
        if (type === 'bullet_list_open' || type === 'ordered_list_open') {
          this.list(items, trailing, level + 1);
          continue;
        }
        const inner: Block[] = [];
        this.block(inner);
        for (const block of inner) {
          if (block.type === 'image' || block.type === 'table') {
            trailing.push(block);
            continue;
          }
          for (const runs of asParagraphs(block)) {
            const item: ListItem = { runs, level, ordered };
            if (first) {
              const task = /^\[([ xX])\]\s+/.exec(runs[0]?.text ?? '');
              if (task) {
                runs[0]!.text = runs[0]!.text.slice(task[0].length);
                item.task = task[1] === ' ' ? 'todo' : 'done';
              }
              if (ordered) item.number = number;
            } else item.continuation = true;
            first = false;
            items.push(item);
          }
        }
      }
      this.index += 1;
      number += 1;
    }
    this.index += 1;
  }

  private table(): Block {
    const header: Run[][] = [];
    const rows: Run[][][] = [];
    const align: Align[] = [];
    let row: Run[][] | undefined;
    let inHead = false;
    this.index += 1;
    while (this.type() && this.type() !== 'table_close') {
      const token = this.peek()!;
      switch (token.type) {
        case 'thead_open':
          inHead = true;
          break;
        case 'thead_close':
          inHead = false;
          break;
        case 'tr_open':
          row = [];
          break;
        case 'tr_close':
          if (row && inHead) header.push(...row);
          else if (row) rows.push(row);
          row = undefined;
          break;
        case 'th_open':
          align.push(
            (TEXT_ALIGN.exec(token.attrGet('style') ?? '')?.[1] as Align) ?? 'left'
          );
          break;
        case 'inline':
          row?.push(readInline(token).runs);
          break;
      }
      this.index += 1;
    }
    this.index += 1;
    return { type: 'table', header, rows, align };
  }
}

/** Flattens a block into paragraphs of text, for places that only hold text. */
function asParagraphs(block: Block): Run[][] {
  switch (block.type) {
    case 'paragraph':
      return [block.runs];
    case 'heading':
      return [block.runs.map((run) => ({ ...run, bold: true }))];
    case 'list':
      return block.items.map((item) => [
        {
          text:
            '  '.repeat(item.level) +
            (item.continuation ? '  ' : item.ordered ? `${item.number}. ` : '• '),
        },
        ...item.runs,
      ]);
    case 'quote':
      return block.paragraphs;
    case 'code':
      return [
        block.text
          .split('\n')
          .map((text, index) => ({ text: text || ' ', code: true, breakBefore: index > 0 })),
      ];
    case 'math':
      return [[{ text: block.text, italic: true }]];
    default:
      return [];
  }
}

const CALLOUT = /^\[!([\w-]+)\][+-]?[ \t]*/;

function quote(inner: Block[]): Block[] {
  const out: Block[] = [];
  let paragraphs: Run[][] = [];
  let label: string | undefined;
  const first = inner[0];
  if (first?.type === 'paragraph') {
    const match = CALLOUT.exec(first.runs[0]?.text ?? '');
    if (match) {
      first.runs[0]!.text = first.runs[0]!.text.slice(match[0].length);
      const lineEnd = first.runs.findIndex((run, index) => index > 0 && run.breakBefore);
      const titleRuns = lineEnd < 0 ? first.runs : first.runs.slice(0, lineEnd);
      const rest = lineEnd < 0 ? [] : first.runs.slice(lineEnd);
      if (rest[0]) rest[0] = { ...rest[0], breakBefore: false };
      const type = match[1]!.replace(/-/g, ' ');
      label = plain(titleRuns).trim() || type[0]!.toUpperCase() + type.slice(1);
      first.runs = rest.filter((run) => run.text);
    }
  }
  const flush = () => {
    if (paragraphs.length || label !== undefined)
      out.push({ type: 'quote', label, paragraphs });
    paragraphs = [];
    label = undefined;
  };
  for (const block of inner) {
    if (block.type === 'image' || block.type === 'table' || block.type === 'code') {
      flush();
      out.push(block);
    } else if (block.type === 'quote') {
      if (block.label) paragraphs.push([{ text: block.label, bold: true }]);
      paragraphs.push(...block.paragraphs);
    } else
      paragraphs.push(...asParagraphs(block).filter((runs) => runs.length));
  }
  flush();
  return out;
}

export function parseNote(source: string): ParsedNote {
  const { body, fields } = splitFrontMatter(source);
  parser ??= createParser();
  const tokens = parser.parse(prepare(body), {});
  return {
    title: fields.title || undefined,
    subtitle: fields.subtitle || fields.description || undefined,
    blocks: new Walker(tokens).blocks(),
  };
}
