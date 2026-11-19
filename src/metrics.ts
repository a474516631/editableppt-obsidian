import type { Run } from './model';

export const PX_PER_PT = 96 / 72;
/** Rendered line height as a multiple of the font size, at 110% spacing. */
export const LINE_HEIGHT = 1.38;
/** Chinese, Japanese and Korean fonts are set on a taller line. */
export const WIDE_LINE_HEIGHT = 1.62;
/** Real fonts differ from the estimate below, so lines are assumed wider. */
const SAFETY = 1.06;

const NARROW = new Set("iljtfrI.,;:'!|()[]{}`\"-");
const WIDE = new Set('mwMW@%');

function isWideGlyph(code: number) {
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f000
  );
}

/** Width of one character in em. */
function charEm(char: string, mono: boolean) {
  const code = char.codePointAt(0)!;
  if (isWideGlyph(code)) return 1;
  if (mono) return 0.6;
  if (char === ' ') return 0.28;
  if (NARROW.has(char)) return 0.3;
  if (WIDE.has(char)) return 0.87;
  if (char >= 'A' && char <= 'Z') return 0.68;
  if (char >= '0' && char <= '9') return 0.56;
  return 0.53;
}

export function textWidth(text: string, fontPt: number, bold = false, mono = false) {
  let em = 0;
  for (const char of text) em += charEm(char, mono);
  return em * fontPt * PX_PER_PT * (bold && !mono ? 1.06 : 1) * SAFETY;
}

interface Piece {
  text: string;
  run: Run;
  width: number;
  space: boolean;
}

function pieces(run: Run, fontPt: number, bold: boolean): Piece[] {
  const out: Piece[] = [];
  let word = '';
  const flush = () => {
    if (!word) return;
    out.push({
      text: word,
      run,
      width: textWidth(word, fontPt, bold || run.bold, run.code),
      space: false,
    });
    word = '';
  };
  for (const char of run.text) {
    if (char === ' ' || char === '\t') {
      flush();
      out.push({
        text: char,
        run,
        width: textWidth(' ', fontPt, false, run.code),
        space: true,
      });
    } else if (isWideGlyph(char.codePointAt(0)!)) {
      flush();
      out.push({
        text: char,
        run,
        width: textWidth(char, fontPt, bold || run.bold),
        space: false,
      });
    } else word += char;
  }
  flush();
  return out;
}

type Part = Run & { source?: Run };

/**
 * Breaks runs into the lines they are expected to take at `width` px.
 * Each line keeps its runs, so a long paragraph can be divided between slides.
 */
export function wrap(runs: Run[], width: number, fontPt: number, bold = false): Run[][] {
  const lines: Part[][] = [];
  let line: Part[] = [];
  let x = 0;
  const append = (piece: Piece) => {
    const last = line[line.length - 1];
    if (last && last.source === piece.run) last.text += piece.text;
    else {
      const next: Part = { ...piece.run, text: piece.text, source: piece.run };
      delete next.breakBefore;
      line.push(next);
    }
    x += piece.width;
  };
  const newline = () => {
    lines.push(line);
    line = [];
    x = 0;
  };
  for (const run of runs) {
    if (run.breakBefore && (line.length || lines.length)) newline();
    for (const piece of pieces(run, fontPt, bold)) {
      if (x + piece.width > width && x > 0) {
        // The space stays on the line it ends, so rejoined lines keep it.
        if (piece.space) {
          append(piece);
          newline();
          continue;
        }
        newline();
      }
      if (piece.width > width) {
        // A token longer than a line (a URL) is cut across several lines.
        const chars = Array.from(piece.text);
        const perLine = Math.max(1, Math.floor((chars.length * width) / piece.width));
        for (let at = 0; at < chars.length; at += perLine) {
          const text = chars.slice(at, at + perLine).join('');
          if (at > 0) newline();
          append({ ...piece, text, width: (piece.width * text.length) / chars.length });
        }
        continue;
      }
      append(piece);
    }
  }
  if (line.length || !lines.length) lines.push(line);
  return lines.map((parts) =>
    parts.map(({ source: _source, ...run }) => run)
  );
}

export const lineCount = (runs: Run[], width: number, fontPt: number, bold = false) =>
  wrap(runs, width, fontPt, bold).length;

export function hasWideGlyphs(text: string) {
  for (const char of text) if (isWideGlyph(char.codePointAt(0)!)) return true;
  return false;
}

export const linesHeight = (lines: number, fontPt: number, wide = false) =>
  lines * fontPt * PX_PER_PT * (wide ? WIDE_LINE_HEIGHT : LINE_HEIGHT);
