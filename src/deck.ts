import { fitsOnePage, geometry, layoutSlide, type Page, type Ratio } from './layout';
import type { Block, ImageInfo, ImageMap } from './model';
import { outline, type SplitMode } from './outline';
import { parseNote } from './parse';
import { renderDeck } from './render';
import { THEMES, type ThemeId } from './themes';

export interface DeckOptions {
  /** Deck title when the note doesn't set one: the file name. */
  fallbackTitle: string;
  split: SplitMode;
  titleSlide: boolean;
  ratio: Ratio;
  theme: ThemeId;
  font: string;
  monoFont: string;
  slideNumbers: boolean;
  /** Returns null for an image that can't be embedded. */
  loadImage: (src: string) => Promise<ImageInfo | null>;
}

export interface DeckResult {
  data: ArrayBuffer;
  title: string;
  slides: number;
  /** Image references that were left out. */
  missingImages: string[];
}

function imageSources(blocks: Block[]) {
  const sources = new Set<string>();
  for (const block of blocks) if (block.type === 'image') sources.add(block.src);
  return [...sources];
}

export async function planDeck(markdown: string, options: DeckOptions) {
  const note = parseNote(markdown);
  const images: ImageMap = new Map();
  const missingImages: string[] = [];
  for (const src of imageSources(note.blocks)) {
    const image = await options.loadImage(src).catch(() => null);
    if (image && image.width > 0 && image.height > 0) images.set(src, image);
    else missingImages.push(src);
  }
  const layout = { geometry: geometry(options.ratio), images };
  const { title, slides } = outline(note, {
    split: options.split,
    titleSlide: options.titleSlide,
    fallbackTitle: options.fallbackTitle,
    fits: (slide) => fitsOnePage(slide, layout),
  });
  const pages: Page[] = slides.flatMap((slide) => layoutSlide(slide, layout));
  return { title, pages, images, missingImages, geometry: layout.geometry };
}

export async function buildDeck(markdown: string, options: DeckOptions): Promise<DeckResult> {
  const plan = await planDeck(markdown, options);
  const data = await renderDeck(plan.pages, {
    title: plan.title,
    ratio: options.ratio,
    geometry: plan.geometry,
    theme: THEMES[options.theme] ?? THEMES.light,
    images: plan.images,
    font: options.font,
    monoFont: options.monoFont,
    slideNumbers: options.slideNumbers,
  });
  return {
    data,
    title: plan.title,
    slides: plan.pages.length,
    missingImages: plan.missingImages,
  };
}
