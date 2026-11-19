export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  highlight?: boolean;
  link?: string;
  /** A line break inside the paragraph comes before this run. */
  breakBefore?: boolean;
}

export interface ListItem {
  runs: Run[];
  level: number;
  ordered: boolean;
  number?: number;
  task?: 'todo' | 'done';
  /** A further paragraph of the previous item: indented, without a marker. */
  continuation?: boolean;
}

export type Align = 'left' | 'center' | 'right';

export type Block =
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'heading'; level: number; runs: Run[] }
  | { type: 'list'; items: ListItem[] }
  | { type: 'quote'; label?: string; paragraphs: Run[][] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'math'; text: string }
  | { type: 'table'; header: Run[][]; rows: Run[][][]; align: Align[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'note'; text: string }
  | { type: 'rule' };

export interface ParsedNote {
  /** From front matter, when the note sets one. */
  title?: string;
  subtitle?: string;
  blocks: Block[];
}

export interface SourceSlide {
  kind: 'title' | 'section' | 'content';
  title: Run[];
  /** Parent heading shown above the title when a section was split up. */
  kicker?: string;
  subtitle?: Run[];
  blocks: Block[];
  notes: string;
}

export interface ImageInfo {
  /** `data:image/png;base64,...` or `data:image/jpeg;base64,...` */
  data: string;
  width: number;
  height: number;
}

export type ImageMap = Map<string, ImageInfo>;

export const plain = (runs: Run[]) =>
  runs.map((run) => (run.breakBefore ? '\n' : '') + run.text).join('');
