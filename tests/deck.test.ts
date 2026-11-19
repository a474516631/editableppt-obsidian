import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { buildDeck, planDeck, type DeckOptions } from '../src/deck';
import { readImageSize, toBase64 } from '../src/image';
import { geometry } from '../src/layout';
import { wrap } from '../src/metrics';
import { plain } from '../src/model';

/** 1x1 PNG. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0)
);

const options = (extra: Partial<DeckOptions> = {}): DeckOptions => ({
  fallbackTitle: 'Note',
  split: 'auto',
  titleSlide: true,
  ratio: '16:9',
  theme: 'light',
  font: 'Arial',
  monoFont: 'Courier New',
  slideNumbers: true,
  loadImage: async () => null,
  ...extra,
});

async function slideXml(markdown: string, extra: Partial<DeckOptions> = {}) {
  const deck = await buildDeck(markdown, options(extra));
  const zip = await JSZip.loadAsync(deck.data);
  const slides: string[] = [];
  for (let number = 1; number <= deck.slides; number += 1)
    slides.push(await zip.file(`ppt/slides/slide${number}.xml`)!.async('string'));
  return { deck, zip, slides };
}

const texts = (xml: string) =>
  [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);

describe('image header', () => {
  it('reads the size of a PNG and rejects other data', () => {
    expect(readImageSize(PNG)).toEqual({ width: 1, height: 1, mime: 'image/png' });
    expect(readImageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(atob(toBase64(PNG)).length).toBe(PNG.length);
  });

  it('reads the size of a JPEG past its leading segments', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03,
    ]);
    expect(readImageSize(jpeg)).toEqual({ width: 400, height: 300, mime: 'image/jpeg' });
  });
});

describe('wrapping', () => {
  it('gives back every character it was given', () => {
    const runs = [
      { text: 'One two three ' },
      { text: 'four five', bold: true },
      { text: ' six seven eight nine ten.' },
    ];
    const lines = wrap(runs, 180, 20);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.map(plain).join('')).toBe(plain(runs));
  });

  it('breaks Chinese text between characters', () => {
    const lines = wrap([{ text: '这是一段没有空格的中文文字需要自动换行' }], 200, 20);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map(plain).join('')).toBe('这是一段没有空格的中文文字需要自动换行');
  });
});

describe('deck', () => {
  it('writes text as text, not as pictures', async () => {
    const { slides, zip } = await slideXml('# Deck\n\n## Plan\n\n- **Bold** point\n- Second point\n');
    expect(slides).toHaveLength(2);
    expect(texts(slides[0]!)).toContain('Deck');
    expect(texts(slides[1]!)).toEqual(expect.arrayContaining(['Plan', 'Bold', ' point', 'Second point']));
    expect(slides[1]).toContain('type="title"');
    expect(slides[1]).toContain('<a:buChar');
    expect(Object.keys(zip.files).filter((name) => /^ppt\/media\/./.test(name))).toEqual([]);
  });

  it('writes a Markdown table as a table', async () => {
    const { slides } = await slideXml('## T\n\n| A | B |\n| - | - |\n| 1 | 2 |\n', { titleSlide: false });
    expect(slides[0]).toContain('<a:tbl>');
    expect((slides[0]!.match(/<a:tr /g) ?? []).length).toBe(2);
  });

  it('escapes text that looks like markup', async () => {
    const { slides } = await slideXml('## A < B & "C"\n\nx <y> z\n', { titleSlide: false });
    expect(slides[0]).toContain('A &lt; B &amp; &quot;C&quot;');
  });

  it('puts note: lines in the speaker notes', async () => {
    const { zip } = await slideXml('## One\n\ntext\n\nnote: say hello\n', { titleSlide: false });
    const notes = await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string');
    expect(texts(notes)).toContain('say hello');
  });

  it('embeds images it can load and reports the ones it cannot', async () => {
    const { deck, zip, slides } = await slideXml('## Pics\n\n![[ok.png]]\n\n![[gone.png]]\n', {
      titleSlide: false,
      loadImage: async (src) =>
        src === 'ok.png'
          ? { width: 800, height: 600, data: `data:image/png;base64,${toBase64(PNG)}` }
          : null,
    });
    expect(deck.missingImages).toEqual(['gone.png']);
    expect(Object.keys(zip.files).filter((name) => /^ppt\/media\/.+\.png$/.test(name))).toHaveLength(1);
    expect(texts(slides[0]!)).toContain('[gone.png]');
  });

  it('survives an image loader that throws', async () => {
    const deck = await buildDeck('![[a.png]]\n', options({
      loadImage: async () => {
        throw new Error('unreadable');
      },
    }));
    expect(deck.missingImages).toEqual(['a.png']);
  });

  it('continues a long section on further slides, inside the slide', async () => {
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8);
    const markdown = '## Long\n\n' + Array.from({ length: 12 }, () => paragraph).join('\n\n') + '\n';
    for (const ratio of ['16:9', '4:3'] as const) {
      const plan = await planDeck(markdown, options({ titleSlide: false, ratio }));
      const g = geometry(ratio);
      expect(plan.pages.length).toBeGreaterThan(2);
      expect(plain(plan.pages[1]!.title)).toBe('Long (2)');
      for (const page of plan.pages)
        for (const frame of page.frames) {
          expect(frame.y + frame.h).toBeLessThanOrEqual(g.bodyBottom + 0.5);
          expect(frame.x + frame.w).toBeLessThanOrEqual(g.width - g.margin + 0.5);
        }
      const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
      const laidOut = plan.pages
        .flatMap((page) => page.frames)
        .flatMap((frame) => (frame.kind === 'text' ? frame.paras : []))
        .reduce((sum, para) => sum + words(plain(para.runs)), 0);
      expect(laidOut).toBe(words(paragraph) * 12);
    }
  });

  it('repeats the header row when a table continues', async () => {
    const rows = Array.from({ length: 60 }, (_unused, at) => `| row ${at} | value |`).join('\n');
    const plan = await planDeck(`## T\n\n| Name | Value |\n| - | - |\n${rows}\n`, options({ titleSlide: false }));
    const tables = plan.pages.flatMap((page) =>
      page.frames.flatMap((frame) => (frame.kind === 'table' ? [frame] : []))
    );
    expect(tables.length).toBeGreaterThan(1);
    expect(tables.every((table) => plain(table.header[0]!) === 'Name')).toBe(true);
    expect(tables.reduce((sum, table) => sum + table.rows.length, 0)).toBe(60);
  });

  it('numbers a list on from where the previous slide stopped', async () => {
    const items = Array.from({ length: 40 }, (_unused, at) => `${at + 1}. item ${at + 1}`).join('\n');
    const { slides } = await slideXml(`## L\n\n${items}\n`, { titleSlide: false });
    expect(slides.length).toBeGreaterThan(1);
    const second = /startAt="(\d+)"/.exec(slides[1]!)?.[1];
    const firstOnSecond = /item (\d+)/.exec(texts(slides[1]!).join(' '))?.[1];
    expect(second).toBe(firstOnSecond);
    expect(Number(second)).toBeGreaterThan(1);
  });
});
