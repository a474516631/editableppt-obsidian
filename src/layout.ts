import {
  hasWideGlyphs,
  lineCount,
  linesHeight,
  PX_PER_PT,
  textWidth,
  WIDE_LINE_HEIGHT,
  wrap,
} from './metrics';
import type { Align, Block, ImageMap, ListItem, Run, SourceSlide } from './model';
import { plain } from './model';

export type Ratio = '16:9' | '4:3';

export interface Geometry {
  width: number;
  height: number;
  margin: number;
  kickerTop: number;
  titleTop: number;
  titleHeight: number;
  ruleTop: number;
  bodyTop: number;
  bodyBottom: number;
}

export function geometry(ratio: Ratio): Geometry {
  return {
    width: ratio === '4:3' ? 960 : 1280,
    height: 720,
    margin: ratio === '4:3' ? 56 : 72,
    kickerTop: 36,
    titleTop: 58,
    titleHeight: 88,
    ruleTop: 154,
    bodyTop: 178,
    bodyBottom: 656,
  };
}

export interface Para {
  runs: Run[];
  fontPt: number;
  bold?: boolean;
  italic?: boolean;
  tone?: 'text' | 'accent' | 'muted';
  align?: 'center';
  /** List nesting, 0 for the outermost level. */
  level: number;
  marker?: 'bullet' | 'number' | 'todo' | 'done' | 'blank';
  number?: number;
  /** Hanging indent of one list level, in pt. */
  indentPt?: number;
  spaceBeforePt: number;
  /** Pieces of one paragraph that was divided between slides share an id. */
  part?: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Frame = Box &
  (
    | { kind: 'text'; paras: Para[] }
    | { kind: 'quote'; paras: Para[] }
    | { kind: 'code'; lines: string[]; fontPt: number }
    | {
        kind: 'table';
        header: Run[][];
        rows: Run[][][];
        align: Align[];
        colW: number[];
        /** Header row first. */
        rowH: number[];
        fontPt: number;
      }
    | { kind: 'image'; src: string; alt: string }
  );

export interface Page {
  kind: SourceSlide['kind'];
  title: Run[];
  titlePt: number;
  kicker?: string;
  subtitle?: Run[];
  frames: Frame[];
  notes: string;
  /** Content starts at the top margin because the slide has no title. */
  untitled?: boolean;
}

export interface LayoutOptions {
  geometry: Geometry;
  images: ImageMap;
}

const SCALES = [1.2, 1, 0.85];
const GAP = 18;
const QUOTE = { padX: 20, padY: 12, bar: 6 };
const CODE = { padX: 16, padY: 12, line: 1.3 };
const TABLE = { padX: 10, padY: 7, line: 1.3 };
const IMAGE_GAP = 20;
/** Paragraphs longer than this are divided so they can continue on the next slide. */
const CHUNK_LINES = 6;

interface Atom {
  h: number;
  /** Stay on the same slide as the atom that follows (a subheading). */
  keep?: boolean;
  group: Group;
  para?: Para;
  line?: string;
  row?: number;
  images?: (Box & { src: string; alt: string })[];
}

interface Group {
  kind: Frame['kind'];
  /** Height added once per slide the group appears on: padding or a header row. */
  overhead: number;
  atoms: Atom[];
  build(atoms: Atom[], box: Box): Frame[];
}

interface Context extends LayoutOptions {
  nextPart: number;
}

const tidy = (runs: Run[]) => {
  const out: Run[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    const same =
      last &&
      !run.breakBefore &&
      !!last.bold === !!run.bold &&
      !!last.italic === !!run.italic &&
      !!last.strike === !!run.strike &&
      !!last.code === !!run.code &&
      !!last.highlight === !!run.highlight &&
      last.link === run.link;
    if (same) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
};

function textGroup(kind: 'text' | 'quote', inset: { x: number; y: number }): Group {
  return {
    kind,
    overhead: inset.y * 2,
    atoms: [],
    build(atoms, box) {
      const paras: Para[] = [];
      for (const atom of atoms) {
        const para = atom.para!;
        const last = paras[paras.length - 1];
        if (last && para.part !== undefined && last.part === para.part)
          last.runs = tidy([...last.runs, ...para.runs]);
        else paras.push({ ...para, runs: tidy(para.runs) });
      }
      if (paras[0]) paras[0].spaceBeforePt = 0;
      return [{ kind, ...box, paras }];
    },
  };
}

function addPara(group: Group, para: Para, width: number, context: Context, keep = false) {
  const indent = para.marker
    ? (para.level + 1) * (para.indentPt ?? 0) * PX_PER_PT
    : 0;
  const lines = wrap(para.runs, Math.max(80, width - indent), para.fontPt, para.bold);
  const space = para.spaceBeforePt * PX_PER_PT;
  const wide = hasWideGlyphs(plain(para.runs));
  if (lines.length <= CHUNK_LINES + 2) {
    group.atoms.push({
      group,
      para,
      keep,
      h: space + linesHeight(lines.length, para.fontPt, wide),
    });
    return;
  }
  const part = context.nextPart++;
  for (let at = 0; at < lines.length; at += CHUNK_LINES) {
    const chunk = lines.slice(at, at + CHUNK_LINES);
    const first = at === 0;
    group.atoms.push({
      group,
      h: (first ? space : 0) + linesHeight(chunk.length, para.fontPt, wide),
      para: {
        ...para,
        runs: chunk.flat(),
        part,
        spaceBeforePt: first ? para.spaceBeforePt : 0,
        marker: first || !para.marker ? para.marker : 'blank',
      },
    });
  }
}

function listPara(item: ListItem, scale: number): Para {
  const fontPt = [20, 18, 16][Math.min(item.level, 2)]! * scale;
  return {
    runs: item.runs,
    fontPt,
    level: item.level,
    marker: item.continuation
      ? 'blank'
      : item.task
        ? item.task
        : item.ordered
          ? 'number'
          : 'bullet',
    number: item.number,
    indentPt: Math.round(20 * scale * 1.35),
    spaceBeforePt: (item.continuation ? 2 : 7) * scale,
  };
}

function columnWidths(header: Run[][], rows: Run[][][], width: number, fontPt: number) {
  const count = Math.max(header.length, ...rows.map((row) => row.length));
  const natural = Array.from({ length: count }, (_unused, column) => {
    let widest = textWidth(plain(header[column] ?? []), fontPt, true);
    for (const row of rows)
      widest = Math.max(widest, textWidth(plain(row[column] ?? []), fontPt));
    return Math.min(widest, width * 0.5) + TABLE.padX * 2;
  });
  const floor = Math.min(72, width / count);
  const total = natural.reduce((sum, value) => sum + value, 0);
  const scaled = natural.map((value) => Math.max(floor, (value / total) * width));
  const sum = scaled.reduce((a, b) => a + b, 0);
  return scaled.map((value) => (value / sum) * width);
}

function compose(blocks: Block[], width: number, scale: number, imageMaxH: number, context: Context) {
  const groups: Group[] = [];
  const text = () => {
    const last = groups[groups.length - 1];
    if (last?.kind === 'text') return last;
    const group = textGroup('text', { x: 0, y: 0 });
    groups.push(group);
    return group;
  };
  const plainPara = (runs: Run[], extra: Partial<Para> = {}): Para => ({
    runs,
    fontPt: 20 * scale,
    level: 0,
    spaceBeforePt: 10 * scale,
    ...extra,
  });

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    switch (block.type) {
      case 'paragraph':
        addPara(text(), plainPara(block.runs), width, context);
        break;
      case 'heading':
        addPara(
          text(),
          plainPara(block.runs, {
            fontPt: 22 * scale,
            bold: true,
            tone: 'accent',
            spaceBeforePt: 16 * scale,
          }),
          width,
          context,
          true
        );
        break;
      case 'math':
        addPara(
          text(),
          plainPara([{ text: block.text }], { italic: true, align: 'center' }),
          width,
          context
        );
        break;
      case 'list':
        for (const item of block.items)
          addPara(text(), listPara(item, scale), width, context);
        break;
      case 'quote': {
        const group = textGroup('quote', { x: QUOTE.padX, y: QUOTE.padY });
        const inner = width - QUOTE.padX * 2 - QUOTE.bar;
        if (block.label)
          addPara(
            group,
            plainPara([{ text: block.label }], {
              fontPt: 18 * scale,
              bold: true,
              tone: 'accent',
              spaceBeforePt: 0,
            }),
            inner,
            context,
            block.paragraphs.length > 0
          );
        for (const runs of block.paragraphs)
          addPara(
            group,
            plainPara(runs, { fontPt: 18 * scale, spaceBeforePt: 6 * scale }),
            inner,
            context
          );
        if (group.atoms.length) groups.push(group);
        break;
      }
      case 'code': {
        const fontPt = Math.max(11, 14 * scale);
        const inner = width - CODE.padX * 2;
        const lineH =
          fontPt * PX_PER_PT * (hasWideGlyphs(block.text) ? WIDE_LINE_HEIGHT : CODE.line);
        const group: Group = {
          kind: 'code',
          overhead: CODE.padY * 2,
          atoms: [],
          build: (atoms, box) => [
            { kind: 'code', ...box, fontPt, lines: atoms.map((atom) => atom.line!) },
          ],
        };
        for (const raw of block.text.split('\n')) {
          const line = raw.replace(/\t/g, '    ');
          const rows = Math.max(1, Math.ceil(textWidth(line, fontPt, false, true) / inner));
          group.atoms.push({ group, line, h: rows * lineH });
        }
        groups.push(group);
        break;
      }
      case 'table': {
        const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length));
        if (!columns) break;
        const fontPt = (columns >= 6 ? 12 : 14) * scale;
        const colW = columnWidths(block.header, block.rows, width, fontPt);
        const rowHeight = (row: Run[][], bold: boolean) =>
          TABLE.padY * 2 +
          Math.max(
            1,
            ...colW.map((w, column) =>
              lineCount(row[column] ?? [], w - TABLE.padX * 2, fontPt, bold)
            )
          ) *
            fontPt *
            PX_PER_PT *
            (row.some((cell) => hasWideGlyphs(plain(cell))) ? WIDE_LINE_HEIGHT : TABLE.line);
        const headerH = rowHeight(block.header, true);
        const group: Group = {
          kind: 'table',
          overhead: headerH,
          atoms: [],
          build: (atoms, box) => [
            {
              kind: 'table',
              ...box,
              header: block.header,
              rows: atoms.map((atom) => block.rows[atom.row!]!),
              align: block.align,
              colW,
              rowH: [headerH, ...atoms.map((atom) => atom.h)],
              fontPt,
            },
          ],
        };
        block.rows.forEach((row, at) =>
          group.atoms.push({ group, row: at, h: rowHeight(row, false) })
        );
        // A table with only a header row still needs something to place.
        if (!group.atoms.length) group.atoms.push({ group, row: -1, h: 0 });
        groups.push(group);
        break;
      }
      case 'image': {
        const row = [block];
        while (row.length < 3) {
          const next = blocks[index + 1];
          if (next?.type !== 'image') break;
          row.push(next);
          index += 1;
        }
        const known = row.filter((image) => context.images.has(image.src));
        for (const image of row)
          if (!context.images.has(image.src))
            addPara(
              text(),
              plainPara([{ text: `[${image.alt || image.src}]` }], {
                tone: 'muted',
                italic: true,
              }),
              width,
              context
            );
        if (!known.length) break;
        const cell = (width - IMAGE_GAP * (known.length - 1)) / known.length;
        const placed = known.map((image, at) => {
          const info = context.images.get(image.src)!;
          const fit = Math.min(cell / info.width, imageMaxH / info.height, 1.5);
          const w = info.width * fit;
          const h = info.height * fit;
          return {
            src: image.src,
            alt: image.alt,
            x: at * (cell + IMAGE_GAP) + (cell - w) / 2,
            y: 0,
            w,
            h,
          };
        });
        const rowH = Math.max(...placed.map((image) => image.h));
        const used =
          known.length === 1
            ? placed[0]!.w
            : known.length * cell + IMAGE_GAP * (known.length - 1);
        const group: Group = {
          kind: 'image',
          overhead: 0,
          atoms: [],
          build: (_atoms, box) =>
            placed.map((image) => ({
              kind: 'image' as const,
              src: image.src,
              alt: image.alt,
              // A lone image is centered; a row is spread over the width.
              x:
                box.x +
                (known.length === 1 ? (box.w - used) / 2 : image.x),
              y: box.y + (rowH - image.h) / 2,
              w: image.w,
              h: image.h,
            })),
        };
        group.atoms.push({ group, h: rowH, images: placed });
        groups.push(group);
        break;
      }
    }
  }
  return groups;
}

interface Segment {
  group: Group;
  atoms: Atom[];
  h: number;
}

function pack(groups: Group[], height: number): Segment[][] {
  const atoms = groups.flatMap((group) => group.atoms);
  const pages: Segment[][] = [[]];
  let used = 0;
  atoms.forEach((atom, index) => {
    let page = pages[pages.length - 1]!;
    let segment = page[page.length - 1];
    const cost = (onPage: Segment[], current: Segment | undefined) =>
      (current?.group === atom.group
        ? 0
        : (onPage.length ? GAP : 0) + atom.group.overhead) + atom.h;
    let need = cost(page, segment);
    const next = atoms[index + 1];
    if (atom.keep && next)
      need +=
        next.h + (next.group === atom.group ? 0 : GAP + next.group.overhead);
    if (used + need > height && page.length) {
      page = [];
      pages.push(page);
      segment = undefined;
      used = 0;
    }
    const added = cost(page, segment);
    if (!segment || segment.group !== atom.group) {
      segment = { group: atom.group, atoms: [], h: atom.group.overhead };
      page.push(segment);
    }
    segment.atoms.push(atom);
    segment.h += atom.h;
    used += added;
  });
  return pages.filter((page) => page.length);
}

function place(segments: Segment[], box: Box, center: boolean): Frame[] {
  const total =
    segments.reduce((sum, segment) => sum + segment.h, 0) +
    GAP * (segments.length - 1);
  let y = box.y + (center ? Math.max(0, (box.h - total) / 2) : 0);
  const frames: Frame[] = [];
  for (const segment of segments) {
    frames.push(
      ...segment.group.build(segment.atoms, { x: box.x, y, w: box.w, h: segment.h })
    );
    y += segment.h + GAP;
  }
  return frames;
}

function fitTitle(runs: Run[], width: number, sizes: [number, number][]) {
  for (const [fontPt, maxLines] of sizes)
    if (lineCount(runs, width, fontPt, true) <= maxLines) return fontPt;
  return sizes[sizes.length - 1]![0];
}

interface Plan {
  pages: Frame[][];
}

function planContent(slide: SourceSlide, body: Box, options: LayoutOptions, singleOnly: boolean): Plan | null {
  const context: Context = { ...options, nextPart: 1 };
  const images = slide.blocks.filter(
    (block) => block.type === 'image' && options.images.has(block.src)
  ) as Extract<Block, { type: 'image' }>[];
  const others = slide.blocks.filter((block) => !images.includes(block as never));
  const onlyImages = slide.blocks.length > 0 && others.length === 0;

  // One image beside the text, when the text is plain enough for a narrow column.
  const lone = images.length === 1 ? options.images.get(images[0]!.src)! : null;
  if (
    lone &&
    others.length &&
    lone.width / lone.height <= 2 &&
    !others.some((block) => block.type === 'table' || block.type === 'code')
  ) {
    const gap = 40;
    const textW = Math.round(body.w * 0.56);
    const imageW = body.w - textW - gap;
    for (const scale of SCALES) {
      const pages = pack(compose(others, textW, scale, body.h, context), body.h);
      if (pages.length !== 1) continue;
      const fit = Math.min(imageW / lone.width, body.h / lone.height, 1.5);
      const w = lone.width * fit;
      const h = lone.height * fit;
      return {
        pages: [
          [
            ...place(pages[0]!, { ...body, w: textW }, false),
            {
              kind: 'image',
              src: images[0]!.src,
              alt: images[0]!.alt,
              x: body.x + textW + gap + (imageW - w) / 2,
              y: body.y + Math.min((body.h - h) / 2, 24),
              w,
              h,
            },
          ],
        ],
      };
    }
  }

  const imageMaxH = onlyImages ? body.h : body.h * 0.6;
  for (const scale of SCALES) {
    const pages = pack(compose(slide.blocks, body.w, scale, imageMaxH, context), body.h);
    if (pages.length <= 1)
      return { pages: pages.map((page) => place(page, body, onlyImages)) };
  }
  if (singleOnly) return null;
  const pages = pack(compose(slide.blocks, body.w, 1, imageMaxH, context), body.h);
  return {
    pages: pages.map((page) =>
      place(page, body, page.every((segment) => segment.group.kind === 'image'))
    ),
  };
}

function bodyBox(slide: SourceSlide, g: Geometry): Box {
  const top = slide.title.length ? g.bodyTop : g.margin;
  return { x: g.margin, y: top, w: g.width - g.margin * 2, h: g.bodyBottom - top };
}

/** Whether the slide fits on one page without dropping below the smallest scale. */
export function fitsOnePage(slide: SourceSlide, options: LayoutOptions) {
  if (!slide.blocks.length) return true;
  return planContent(slide, bodyBox(slide, options.geometry), options, true) !== null;
}

export function layoutSlide(slide: SourceSlide, options: LayoutOptions): Page[] {
  const g = options.geometry;
  const width = g.width - g.margin * 2;
  if (slide.kind === 'title' || (slide.kind === 'section' && !slide.blocks.length)) {
    const inner = width - 48;
    return [
      {
        kind: slide.kind,
        title: slide.title,
        titlePt:
          slide.kind === 'title'
            ? fitTitle(slide.title, inner, [[44, 2], [36, 3], [30, 4]])
            : fitTitle(slide.title, inner, [[38, 2], [32, 3], [26, 4]]),
        kicker: slide.kicker,
        subtitle: slide.subtitle,
        frames: [],
        notes: slide.notes,
      },
    ];
  }
  const titlePt = fitTitle(slide.title, width, [[30, 1], [26, 2], [22, 2], [18, 3]]);
  const plan = planContent(slide, bodyBox(slide, g), options, false)!;
  return plan.pages.map((frames, index) => ({
    kind: 'content',
    title:
      index === 0 || !slide.title.length
        ? slide.title
        : [...slide.title, { text: ` (${index + 1})` }],
    titlePt,
    kicker: slide.kicker,
    frames,
    notes: index === 0 ? slide.notes : '',
    untitled: !slide.title.length,
  }));
}
