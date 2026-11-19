import { describe, expect, it } from 'vitest';

import { plain } from '../src/model';
import { outline, type OutlineOptions } from '../src/outline';
import { parseNote } from '../src/parse';

const options = (extra: Partial<OutlineOptions> = {}): OutlineOptions => ({
  split: 'auto',
  titleSlide: true,
  fallbackTitle: 'File name',
  fits: () => true,
  ...extra,
});
const titles = (source: string, extra: Partial<OutlineOptions> = {}) =>
  outline(parseNote(source), options(extra)).slides.map(
    (slide) => `${slide.kind}:${plain(slide.title)}`
  );

describe('heading outline', () => {
  it('uses a single top heading as the deck title', () => {
    const source = '# Deck\n\nIntro line\n\n## One\n\ntext\n\n## Two\n\ntext\n';
    const result = outline(parseNote(source), options());
    expect(result.title).toBe('Deck');
    expect(result.slides.map((slide) => `${slide.kind}:${plain(slide.title)}`)).toEqual([
      'title:Deck',
      'content:One',
      'content:Two',
    ]);
    expect(plain(result.slides[0]!.subtitle!)).toBe('Intro line');
  });

  it('falls back to the file name and makes each top heading a slide', () => {
    expect(titles('# One\n\na\n\n# Two\n\nb\n')).toEqual(['title:File name', 'content:One', 'content:Two']);
  });

  it('prefers the front matter title', () => {
    const result = outline(parseNote('---\ntitle: From YAML\n---\n# Heading\n\ntext\n'), options());
    expect(result.title).toBe('From YAML');
  });

  it('can leave the title slide out', () => {
    expect(titles('# Deck\n\n## One\n\na\n', { titleSlide: false })).toEqual(['content:One']);
  });

  it('keeps subsections on one slide while they fit', () => {
    expect(titles('# D\n\n## One\n\n### A\n\na\n\n### B\n\nb\n')).toEqual(['title:D', 'content:One']);
  });

  it('gives each subsection a slide when the section is too long', () => {
    const source = '# D\n\n## One\n\nlead\n\n### A\n\na\n\n### B\n\nb\n';
    const result = outline(
      parseNote(source),
      options({ fits: (slide) => !slide.blocks.some((block) => block.type === 'heading') })
    );
    expect(result.slides.map((slide) => `${slide.kind}:${plain(slide.title)}`)).toEqual([
      'title:D',
      'content:One',
      'content:A',
      'content:B',
    ]);
    expect(result.slides[2]!.kicker).toBe('One');
  });

  it('splits down to the chosen heading level even when a section fits', () => {
    expect(titles('# D\n\n## One\n\n### A\n\na\n\n### B\n\nb\n', { split: 'h3' })).toEqual([
      'title:D',
      'content:A',
      'content:B',
    ]);
  });

  it('turns a heading without content into a section slide', () => {
    expect(titles('# A\n\n# B\n\ntext\n', { titleSlide: false })).toEqual(['section:A', 'content:B']);
  });

  it('moves note: lines into the speaker notes', () => {
    const result = outline(parseNote('# D\n\n## One\n\ntext\n\nnote: remember this\n'), options());
    expect(result.slides[1]!.notes).toBe('remember this');
    expect(result.slides[1]!.blocks).toHaveLength(1);
  });
});

describe('rule outline', () => {
  const source = '# Talk\n\nA subtitle\n\n---\n\n## One\n\n- a\n\nnote: first\nsecond line\n\n---\n\nNo heading here\n\n---\n\n## End\n';

  it('makes one slide per separator', () => {
    const result = outline(parseNote(source), options());
    expect(result.title).toBe('Talk');
    expect(result.slides.map((slide) => `${slide.kind}:${plain(slide.title)}`)).toEqual([
      'title:Talk',
      'content:One',
      'content:',
      'section:End',
    ]);
    expect(plain(result.slides[0]!.subtitle!)).toBe('A subtitle');
    expect(result.slides[1]!.notes).toBe('first\nsecond line');
  });

  it('is not used when the split is set to headings', () => {
    expect(titles('## One\n\na\n\n---\n\nb\n\n## Two\n\nc\n', { split: 'h2' })).toEqual([
      'title:File name',
      'content:One',
      'content:Two',
    ]);
  });
});

it('uses the only heading of a note as the deck title', () => {
  expect(titles('## One\n\na\n\nb\n')).toEqual(['title:One', 'content:One']);
});

it('still makes a deck from a note without content', () => {
  expect(titles('')).toEqual(['title:File name']);
});
