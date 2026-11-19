import { describe, expect, it } from 'vitest';

import type { Block } from '../src/model';
import { plain } from '../src/model';
import { parseNote, parseWikilink, splitFrontMatter } from '../src/parse';

const only = <T extends Block['type']>(blocks: Block[], type: T) => {
  const found = blocks.filter((block) => block.type === type);
  expect(found).toHaveLength(1);
  return found[0] as Extract<Block, { type: T }>;
};

describe('front matter', () => {
  it('reads the title and leaves the body', () => {
    const { body, fields } = splitFrontMatter('---\ntitle: "Q3 Review"\ntags: [a]\n---\n# Body\n');
    expect(fields.title).toBe('Q3 Review');
    expect(body).toBe('# Body\n');
  });

  it('treats a leading rule without a closing fence as content', () => {
    expect(splitFrontMatter('---\n# Slide\n').body).toBe('---\n# Slide\n');
  });
});

describe('inline syntax', () => {
  it('keeps bold, italic, highlight, strike and code as separate runs', () => {
    const { runs } = only(parseNote('a **b** *c* ==d== ~~e~~ `f`').blocks, 'paragraph');
    expect(runs.map((run) => run.text)).toEqual(['a ', 'b', ' ', 'c', ' ', 'd', ' ', 'e', ' ', 'f']);
    expect(runs[1]).toMatchObject({ bold: true });
    expect(runs[3]).toMatchObject({ italic: true });
    expect(runs[5]).toMatchObject({ highlight: true });
    expect(runs[7]).toMatchObject({ strike: true });
    expect(runs[9]).toMatchObject({ code: true });
  });

  it('shows a wikilink by its alias, or by its name and heading', () => {
    const text = (source: string) => plain(only(parseNote(source).blocks, 'paragraph').runs);
    expect(text('See [[Folder/Note|the note]].')).toBe('See the note.');
    expect(text('See [[Folder/Note#Part]].')).toBe('See Note > Part.');
    expect(parseWikilink('Note#^abc|x')).toEqual({ path: 'Note', subpath: '^abc', alias: 'x' });
  });

  it('keeps web links and drops links into the vault', () => {
    const { runs } = only(parseNote('[site](https://example.com) and [local](note.md)').blocks, 'paragraph');
    expect(runs[0]).toMatchObject({ text: 'site', link: 'https://example.com' });
    expect(runs[2]).toMatchObject({ text: 'local' });
    expect(runs[2]!.link).toBeUndefined();
  });

  it('does not read emphasis inside inline math', () => {
    const { runs } = only(parseNote('Mass $m_1 * m_2$ and price $5 or $6').blocks, 'paragraph');
    expect(plain(runs)).toBe('Mass m_1 * m_2 and price $5 or $6');
  });

  it('removes comments and block ids', () => {
    const blocks = parseNote('Visible %%hidden%% text ^abc123\n\n%%\nwhole block\n%%\n').blocks;
    expect(plain(only(blocks, 'paragraph').runs)).toBe('Visible  text');
  });
});

describe('blocks', () => {
  it('reads nested, ordered and task lists', () => {
    const { items } = only(parseNote('- a\n    - b\n- [x] done\n- [ ] todo\n').blocks, 'list');
    expect(items.map((item) => [plain(item.runs), item.level, item.task])).toEqual([
      ['a', 0, undefined],
      ['b', 1, undefined],
      ['done', 0, 'done'],
      ['todo', 0, 'todo'],
    ]);
    const ordered = only(parseNote('3. c\n4. d\n').blocks, 'list');
    expect(ordered.items.map((item) => item.number)).toEqual([3, 4]);
  });

  it('reads a table with its alignment', () => {
    const table = only(parseNote('| A | B |\n| :-- | --: |\n| 1 | **2** |\n').blocks, 'table');
    expect(table.header.map(plain)).toEqual(['A', 'B']);
    expect(table.align).toEqual(['left', 'right']);
    expect(table.rows[0]![1]![0]).toMatchObject({ text: '2', bold: true });
  });

  it('reads a callout title and body', () => {
    const quote = only(parseNote('> [!warning] Careful\n> Body text\n').blocks, 'quote');
    expect(quote.label).toBe('Careful');
    expect(quote.paragraphs.map(plain)).toEqual(['Body text']);
    expect(only(parseNote('> [!tip]\n> Body\n').blocks, 'quote').label).toBe('Tip');
  });

  it('turns image embeds into image blocks and note embeds into text', () => {
    const blocks = parseNote('![[shot.png|300]]\n\n![alt text](img/a%20b.jpg)\n\n![[Other note]]\n').blocks;
    expect(blocks.filter((block) => block.type === 'image')).toEqual([
      { type: 'image', src: 'shot.png', alt: '' },
      { type: 'image', src: 'img/a%20b.jpg', alt: 'alt text' },
    ]);
    expect(plain(only(blocks, 'paragraph').runs)).toBe('Other note');
  });

  it('keeps code verbatim, including Markdown-looking text', () => {
    const code = only(parseNote('```js\nconst a = "**x**"; // %%kept%%\n```\n').blocks, 'code');
    expect(code).toMatchObject({ lang: 'js', text: 'const a = "**x**"; // %%kept%%' });
  });

  it('reads display math and speaker notes', () => {
    const blocks = parseNote('$$\nx^2\n$$\n\nnote: say this\n').blocks;
    expect(only(blocks, 'math').text).toBe('x^2');
    expect(only(blocks, 'note').text).toBe('say this');
  });

  it('does not pass HTML through', () => {
    const blocks = parseNote('<div class="x">Hello <b>there</b></div>\n\n<script>alert(1)</script>\n').blocks;
    expect(blocks).toEqual([{ type: 'paragraph', runs: [{ text: 'Hello there' }] }]);
  });
});
