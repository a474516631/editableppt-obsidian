import PptxGenJS from 'pptxgenjs';

import type { Frame, Geometry, Page, Para, Ratio } from './layout';
import type { ImageMap, Run } from './model';
import type { Theme } from './themes';

export interface RenderOptions {
  title: string;
  ratio: Ratio;
  geometry: Geometry;
  theme: Theme;
  images: ImageMap;
  font: string;
  monoFont: string;
  slideNumbers: boolean;
}

type TextProps = PptxGenJS.TextProps;
type TextOptions = NonNullable<TextProps['options']>;

const MASTER = {
  title: 'NOTE_TITLE',
  section: 'NOTE_SECTION',
  content: 'NOTE_CONTENT',
  blank: 'NOTE_BLANK',
};
const BULLETS = ['2022', '25E6', '25AA'];
const inch = (px: number) => Math.round((px / 96) * 1000) / 1000;
const pt = (px: number) => Math.round(px * 0.75 * 10) / 10;
const half = (value: number) => Math.round(value * 2) / 2;
/** pptxgenjs reads a text box margin as [left, right, bottom, top], in px here. */
const inset = (top: number, right: number, bottom: number, left: number) =>
  [pt(left), pt(right), pt(bottom), pt(top)] as [number, number, number, number];

function runOptions(run: Run, para: Pick<Para, 'bold' | 'italic'>, options: RenderOptions): TextOptions {
  const out: TextOptions = {};
  if (run.bold || para.bold) out.bold = true;
  if (run.italic || para.italic) out.italic = true;
  if (run.strike) out.strike = 'sngStrike';
  if (run.code) {
    out.fontFace = options.monoFont;
    out.highlight = options.theme.surface;
  }
  if (run.highlight) out.highlight = options.theme.highlight;
  if (run.link) {
    out.hyperlink = { url: run.link };
    out.color = options.theme.accent;
  }
  return out;
}

function paragraphs(paras: Para[], options: RenderOptions): TextProps[] {
  const { theme } = options;
  const tones = { text: theme.text, accent: theme.accent, muted: theme.muted };
  const out: TextProps[] = [];
  // Numbered items of one list share a start value, or PowerPoint restarts at each.
  const sequences = new Map<number, number>();
  paras.forEach((para, index) => {
    const first: TextOptions = {};
    const indent = para.indentPt ?? 27;
    if (para.marker === 'number') {
      for (const level of sequences.keys())
        if (level > para.level) sequences.delete(level);
      if (!sequences.has(para.level))
        sequences.set(para.level, para.number ?? 1);
      first.bullet = {
        type: 'number',
        numberStartAt: sequences.get(para.level),
        indent,
      };
    } else {
      for (const level of sequences.keys())
        if (level >= para.level) sequences.delete(level);
      if (para.marker === 'bullet')
        first.bullet = { characterCode: BULLETS[para.level % BULLETS.length], indent };
      else if (para.marker === 'todo') first.bullet = { characterCode: '2610', indent };
      else if (para.marker === 'done') first.bullet = { characterCode: '2611', indent };
      else if (para.marker === 'blank') first.bullet = { characterCode: '00A0', indent };
    }
    if (para.marker && para.level) first.indentLevel = para.level;
    if (para.spaceBeforePt) first.paraSpaceBefore = half(para.spaceBeforePt);
    if (para.align) first.align = para.align;
    const runs = para.runs.length ? para.runs : [{ text: '' }];
    runs.forEach((run, at) => {
      const item: TextOptions = {
        ...runOptions(run, para, options),
        fontSize: half(para.fontPt),
      };
      if (!item.color) item.color = tones[para.tone ?? 'text'];
      if (at === 0) Object.assign(item, first);
      else if (run.breakBefore) item.softBreakBefore = true;
      if (at === runs.length - 1 && index < paras.length - 1) item.breakLine = true;
      out.push({ text: run.text, options: item });
    });
  });
  return out;
}

function titleRuns(runs: Run[], options: RenderOptions): TextProps[] {
  const list = runs.length ? runs : [{ text: '' }];
  return list.map((run, at) => {
    const item = runOptions(run, {}, options);
    delete item.highlight;
    if (at > 0 && run.breakBefore) item.softBreakBefore = true;
    return { text: run.text, options: item };
  });
}

function defineMasters(pptx: PptxGenJS, options: RenderOptions) {
  const { theme, geometry: g, font } = options;
  const width = g.width - g.margin * 2;
  const slideNumber = options.slideNumbers
    ? {
        x: inch(g.width - g.margin - 120),
        y: inch(g.height - 46),
        w: inch(120),
        h: inch(24),
        fontFace: font,
        fontSize: 10,
        color: theme.muted,
        align: 'right' as const,
      }
    : undefined;
  const title = (box: { x: number; y: number; w: number; h: number }, fontSize: number, valign: 'middle' | 'bottom') => ({
    placeholder: {
      options: {
        name: 'title',
        type: 'title' as const,
        x: inch(box.x),
        y: inch(box.y),
        w: inch(box.w),
        h: inch(box.h),
        fontFace: font,
        fontSize,
        bold: true,
        color: theme.title,
        align: 'left' as const,
        valign,
        margin: 0,
      },
      text: '',
    },
  });
  const bar = (x: number, y: number, w: number, h: number, color: string) => ({
    rect: { x: inch(x), y: inch(y), w: inch(w), h: inch(h), fill: { color } },
  });
  const indent = g.margin + 24;
  pptx.defineSlideMaster({
    title: MASTER.title,
    background: { color: theme.background },
    objects: [
      title({ x: indent, y: 170, w: width - 48, h: 220 }, 44, 'bottom'),
      bar(indent, 412, 96, 6, theme.accent),
    ],
  });
  pptx.defineSlideMaster({
    title: MASTER.section,
    background: { color: theme.background },
    objects: [
      bar(g.margin, 262, 6, 150, theme.accent),
      title({ x: indent, y: 262, w: width - 48, h: 150 }, 38, 'middle'),
    ],
    slideNumber,
  });
  pptx.defineSlideMaster({
    title: MASTER.content,
    background: { color: theme.background },
    objects: [
      title({ x: g.margin, y: g.titleTop, w: width, h: g.titleHeight }, 30, 'middle'),
      bar(g.margin, g.ruleTop, width, 1.5, theme.border),
    ],
    slideNumber,
  });
  pptx.defineSlideMaster({
    title: MASTER.blank,
    background: { color: theme.background },
    slideNumber,
  });
}

function addFrame(pptx: PptxGenJS, slide: PptxGenJS.Slide, frame: Frame, options: RenderOptions) {
  const { theme, font, monoFont } = options;
  const box = { x: inch(frame.x), y: inch(frame.y), w: inch(frame.w), h: inch(frame.h) };
  const base = {
    fontFace: font,
    color: theme.text,
    valign: 'top' as const,
    lineSpacingMultiple: 1.1,
  };
  switch (frame.kind) {
    case 'text':
      slide.addText(paragraphs(frame.paras, options), { ...box, ...base, margin: 0 });
      break;
    case 'quote': {
      const bar = 6;
      slide.addText(paragraphs(frame.paras, options), {
        ...box,
        ...base,
        // The box is sized from an estimate, so spare room is shared top and bottom.
        valign: 'middle',
        fill: { color: theme.surface },
        margin: inset(12, 20, 12, 20 + bar),
      });
      slide.addShape(pptx.ShapeType.rect, {
        ...box,
        w: inch(bar),
        fill: { color: theme.accent },
        line: { color: theme.accent, width: 0 },
      });
      break;
    }
    case 'code':
      slide.addText(
        frame.lines.map((line, at) => ({
          text: line || ' ',
          options: { breakLine: at < frame.lines.length - 1 },
        })),
        {
          ...box,
          fontFace: monoFont,
          fontSize: half(frame.fontPt),
          color: theme.text,
          valign: 'top',
          fill: { color: theme.surface },
          line: { color: theme.border, width: 0.75 },
          margin: inset(12, 16, 12, 16),
        }
      );
      break;
    case 'table': {
      const cell = (runs: Run[], column: number, header: boolean): PptxGenJS.TableCell => ({
        text: runs.length
          ? runs.map((run, at) => ({
              text: run.text,
              options: {
                ...runOptions(run, { bold: header }, options),
                ...(at > 0 && run.breakBefore ? { softBreakBefore: true } : {}),
              },
            }))
          : '',
        options: {
          align: frame.align[column] ?? 'left',
          ...(header
            ? { bold: true, color: theme.title, fill: { color: theme.surface } }
            : {}),
        },
      });
      const columns = frame.colW.length;
      const row = (cells: Run[][], header: boolean) =>
        Array.from({ length: columns }, (_unused, column) =>
          cell(cells[column] ?? [], column, header)
        );
      slide.addTable(
        [row(frame.header, true), ...frame.rows.map((cells) => row(cells, false))],
        {
          x: box.x,
          y: box.y,
          w: box.w,
          colW: frame.colW.map(inch),
          rowH: frame.rowH.map(inch),
          fontFace: font,
          fontSize: half(frame.fontPt),
          color: theme.text,
          valign: 'middle',
          border: { type: 'solid', pt: 0.75, color: theme.border },
          margin: [pt(7), pt(10), pt(7), pt(10)],
          autoPage: false,
        }
      );
      break;
    }
    case 'image': {
      const image = options.images.get(frame.src);
      if (image)
        slide.addImage({ data: image.data, ...box, altText: frame.alt || undefined });
      break;
    }
  }
}

export async function renderDeck(pages: Page[], options: RenderOptions): Promise<ArrayBuffer> {
  const { theme, geometry: g, font } = options;
  const pptx = new PptxGenJS();
  pptx.layout = options.ratio === '4:3' ? 'LAYOUT_4x3' : 'LAYOUT_WIDE';
  pptx.title = options.title;
  pptx.subject = options.title;
  pptx.author = '';
  pptx.company = '';
  pptx.theme = { headFontFace: font, bodyFontFace: font };
  defineMasters(pptx, options);
  const width = g.width - g.margin * 2;
  const indent = g.margin + 24;

  for (const page of pages) {
    const masterName =
      page.kind === 'content'
        ? page.untitled
          ? MASTER.blank
          : MASTER.content
        : MASTER[page.kind];
    const slide = pptx.addSlide({ masterName });
    if (!page.untitled)
      slide.addText(titleRuns(page.title, options), {
        placeholder: 'title',
        fontSize: page.titlePt,
      });
    if (page.kicker && page.kind !== 'title')
      slide.addText(page.kicker, {
        x: inch(page.kind === 'section' ? indent : g.margin),
        y: inch(page.kind === 'section' ? 232 : g.kickerTop),
        w: inch(width - 48),
        h: inch(24),
        margin: 0,
        fontFace: font,
        fontSize: 12,
        bold: true,
        color: theme.accent,
        valign: 'middle',
      });
    if (page.subtitle?.length)
      slide.addText(
        paragraphs(
          [{ runs: page.subtitle, fontPt: 20, level: 0, spaceBeforePt: 0, tone: 'muted' }],
          options
        ),
        {
          x: inch(indent),
          y: inch(page.kind === 'title' ? 438 : 424),
          w: inch(width - 48),
          h: inch(120),
          margin: 0,
          fontFace: font,
          valign: 'top',
          lineSpacingMultiple: 1.1,
        }
      );
    for (const frame of page.frames) addFrame(pptx, slide, frame, options);
    if (page.notes) slide.addNotes(page.notes);
  }
  return (await pptx.write({
    outputType: 'arraybuffer',
    compression: true,
  })) as ArrayBuffer;
}
