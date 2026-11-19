import type { Block, ParsedNote, Run, SourceSlide } from './model';
import { plain } from './model';

export type SplitMode = 'auto' | 'rule' | 'h1' | 'h2' | 'h3';

export interface OutlineOptions {
  split: SplitMode;
  titleSlide: boolean;
  /** Used when the note has no title of its own (the file name). */
  fallbackTitle: string;
  /** Whether a slide's content fits on a single page. */
  fits: (slide: SourceSlide) => boolean;
}

export interface Outline {
  title: string;
  slides: SourceSlide[];
}

const SUBTITLE_LIMIT = 160;

function makeSlide(title: Run[], blocks: Block[], kicker?: string): SourceSlide {
  const notes: string[] = [];
  const content: Block[] = [];
  for (const block of blocks) {
    if (block.type === 'note') notes.push(block.text);
    else if (block.type !== 'rule') content.push(block);
  }
  return {
    kind: content.length ? 'content' : 'section',
    title,
    kicker,
    blocks: content,
    notes: notes.join('\n\n'),
  };
}

function blockText(block: Block): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return plain(block.runs);
    case 'list':
      return block.items.map((item) => plain(item.runs)).join('\n');
    case 'quote':
      return block.paragraphs.map(plain).join('\n');
    case 'code':
    case 'math':
    case 'note':
      return block.text;
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map(plain).join(' | '))
        .join('\n');
    default:
      return '';
  }
}

const isShortParagraph = (block: Block | undefined, limit: number) =>
  block?.type === 'paragraph' && plain(block.runs).length <= limit;

/** One slide per `---`, the convention of the core Slides plugin. */
function byRules(note: ParsedNote, options: OutlineOptions): Outline {
  const groups: Block[][] = [[]];
  for (const block of note.blocks) {
    if (block.type === 'rule') groups.push([]);
    else groups[groups.length - 1]!.push(block);
  }
  const slides: SourceSlide[] = [];
  for (const group of groups) {
    if (!group.length) continue;
    // Everything after `note:` belongs to the speaker notes.
    const noteAt = group.findIndex((block) => block.type === 'note');
    const visible = noteAt < 0 ? group : group.slice(0, noteAt);
    const notes =
      noteAt < 0
        ? ''
        : group.slice(noteAt).map(blockText).filter(Boolean).join('\n\n');
    const first = visible[0];
    const title = first?.type === 'heading' ? first.runs : [];
    const slide = makeSlide(title, title.length ? visible.slice(1) : visible);
    slide.notes = notes;
    if (!slide.title.length && !slide.blocks.length) continue;
    if (!slides.length && title.length) {
      const [lead, ...rest] = slide.blocks;
      if (!lead) slide.kind = 'title';
      else if (!rest.length && isShortParagraph(lead, SUBTITLE_LIMIT)) {
        slide.kind = 'title';
        slide.subtitle = (lead as { runs: Run[] }).runs;
        slide.blocks = [];
      }
    }
    slides.push(slide);
  }
  const firstTitle = slides.find((slide) => slide.title.length)?.title;
  return {
    title:
      note.title || (firstTitle && plain(firstTitle)) || options.fallbackTitle,
    slides,
  };
}

interface Section {
  title: Run[];
  level: number;
  blocks: Block[];
}

/** Splits at the shallowest heading level found in `blocks`. */
function sectionize(blocks: Block[], maxLevel = 6) {
  let level = 7;
  for (const block of blocks)
    if (block.type === 'heading') level = Math.min(level, block.level);
  const intro: Block[] = [];
  const sections: Section[] = [];
  if (level > maxLevel) return { intro: blocks, sections };
  for (const block of blocks) {
    if (block.type === 'heading' && block.level === level)
      sections.push({ title: block.runs, level, blocks: [] });
    else (sections[sections.length - 1]?.blocks ?? intro).push(block);
  }
  return { intro, sections };
}

function byHeadings(note: ParsedNote, options: OutlineOptions): Outline {
  let blocks = note.blocks.filter((block) => block.type !== 'rule');
  const levels = blocks.flatMap((block) =>
    block.type === 'heading' ? [block.level] : []
  );
  const top = Math.min(...levels);
  const first = blocks[0];
  let noteTitle: Run[] | undefined;
  // A single top-level heading that opens the note is its title, not a slide.
  if (
    first?.type === 'heading' &&
    first.level === top &&
    levels.filter((level) => level === top).length === 1
  ) {
    noteTitle = first.runs;
    blocks = blocks.slice(1);
  }
  const title =
    note.title || (noteTitle && plain(noteTitle)) || options.fallbackTitle;
  const forced =
    options.split === 'auto' ? 0 : Number(options.split.slice(1));
  const slides: SourceSlide[] = [];

  const emit = (section: Section, kicker: string | undefined, depth: number, siblings: number) => {
    const whole = makeSlide(section.title, section.blocks, kicker);
    const subLevels = section.blocks.flatMap((block) =>
      block.type === 'heading' ? [block.level] : []
    );
    const mustSplit = subLevels.some((level) => level <= forced);
    if (!subLevels.length || (!mustSplit && options.fits(whole))) {
      slides.push(whole);
      return;
    }
    const { intro, sections } = sectionize(section.blocks);
    const lead = makeSlide(section.title, intro, kicker);
    if (lead.blocks.length || lead.notes) slides.push(lead);
    else if (depth === 0 && siblings > 1 && sections.length > 1) slides.push(lead);
    const parent = plain(section.title);
    for (const child of sections) emit(child, parent || kicker, depth + 1, sections.length);
  };

  const { intro, sections } = sectionize(blocks);
  let subtitle: Run[] | undefined = note.subtitle
    ? [{ text: note.subtitle }]
    : undefined;
  let lead = intro;
  if (
    options.titleSlide &&
    !subtitle &&
    intro.length === 1 &&
    isShortParagraph(intro[0], SUBTITLE_LIMIT)
  ) {
    subtitle = (intro[0] as { runs: Run[] }).runs;
    lead = [];
  }
  if (options.titleSlide)
    slides.push({
      kind: 'title',
      title: [{ text: title }],
      subtitle,
      blocks: [],
      notes: '',
    });
  if (lead.some((block) => block.type !== 'rule'))
    emit({ title: [{ text: title }], level: 0, blocks: lead }, undefined, 1, 1);
  for (const section of sections) emit(section, undefined, 0, sections.length);
  return { title, slides };
}

export function outline(note: ParsedNote, options: OutlineOptions): Outline {
  const hasRules = note.blocks.some((block) => block.type === 'rule');
  const result =
    options.split === 'rule' || (options.split === 'auto' && hasRules)
      ? byRules(note, options)
      : byHeadings(note, options);
  if (!result.slides.length)
    result.slides.push({
      kind: 'title',
      title: [{ text: result.title }],
      blocks: [],
      notes: '',
    });
  return result;
}
