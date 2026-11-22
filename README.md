# Note to PowerPoint

Export an Obsidian note as a PowerPoint file you can keep editing. Headings
become slides, and everything on them is a real PowerPoint object: text boxes,
bulleted and numbered lists, native tables, embedded images and speaker notes.
Nothing is flattened into a picture.

**Export** builds the deck on your device from the text of the note. It makes
no network requests, needs no account and is free.

**AI design** is optional. It sends the note to
[EditablePPT](https://editableppt.com), the service that maintains this
plugin, to design the deck in one of its templates, and needs an account and
credits there. It runs only when you start it. See
[AI design](#ai-design-optional) for exactly what is sent.

## Disclosures

- **Network use**: only AI design uses the network. It talks to
  `editableppt.com` to sign in, write the outline, draw the slides, make them
  editable and download the finished file. The template pictures in its dialog
  load from the same site. Export never uses the network.
- **Account required** for AI design: an EditablePPT account. Export needs none.
- **Payment required** for AI design: it uses credits from your EditablePPT
  account, priced as on the website. Export is free.
- **No telemetry**: the plugin collects no usage data. Requests to EditablePPT
  are handled under its [privacy policy](https://editableppt.com/privacy-policy).

## Install

Until the plugin is listed in the community directory, install it by hand:
download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/a474516631/editableppt-obsidian/releases/latest),
put them in `<vault>/.obsidian/plugins/note-to-powerpoint/`, then enable
**Note to PowerPoint** under Settings → Community plugins.

Tested on desktop (macOS). It uses no desktop-only APIs, but has not been
tried on mobile yet.

## Use it

Open a note, then do one of these:

- Run **Note to PowerPoint: Export current note** from the command palette.
- Click the presentation icon in the ribbon.
- Right-click a note in the file explorer and choose **Export to PowerPoint**.

The `.pptx` is saved next to the note (or in the folder you set) and, on
desktop, opened in your presentation app.

Exporting again replaces the previous export. If the file was changed since the
plugin wrote it, or the plugin didn't write it, you are asked first and can
keep both.

## AI design (optional)

Run **Note to PowerPoint: Design with an EditablePPT template (AI)**, or
right-click a note and choose **Design as PowerPoint with AI**.

1. **Sign in.** The first time, your browser opens `editableppt.com` to approve
   the plugin. The plugin then keeps a sign-in key in Obsidian's keychain
   (Obsidian 1.11.4 or later), not in the vault. Sign out under Settings →
   Note to PowerPoint; that also revokes the key.
2. **Pick a template** and the deck language, then **Write the outline**. The
   note is sent as Markdown, without its front matter and `%%comments%%`.
   Images and linked notes are not sent.
3. **Check the outline.** Write it again, or go on to **Preview the design**:
   two previews of the template are drawn and you pick a layout.
4. **Make the slides.** Every slide is drawn, then rebuilt as editable
   PowerPoint text and shapes, and the file is saved as
   `<note> (EditablePPT).pptx` next to the note (or in the folder you set).
   This takes a few minutes and keeps going if you close the dialog; the status
   bar shows progress. If Obsidian closes first, it resumes the next time, or
   run **Continue the AI-designed deck**.

Credits are charged as on the website: the outline, the previews and the
drawing by usage, and a fixed amount per slide to make it editable (shown
before you start). A slide that can't be made editable is left out and named.

## How a note becomes slides

| In the note | In the deck |
| --- | --- |
| The note's only top-level heading, or `title:` in front matter | Title slide |
| Each heading below it | A slide with that title |
| A heading with nothing under it | A section slide |
| Subheadings of a section that fits on one slide | Bold subheadings on that slide |
| A section too long for one slide | One slide per subheading, then continuation slides marked (2), (3) |
| Lists, numbered lists, task lists | Editable lists, nesting kept |
| Tables | PowerPoint tables; the header row repeats when a table continues |
| `![[image.png]]`, `![](image.png)` | The image, beside the text when there is one image and room for it |
| Quotes and callouts | A shaded text box; a callout keeps its title |
| Code blocks | A monospaced text box |
| `note: ...` paragraph | Speaker notes of that slide |
| `[[links]]`, `==highlight==`, bold, italic, strikethrough, web links | Kept as formatted text |
| `%%comments%%`, block ids, front matter | Left out |

A note that uses `---` separators is split there instead, one slide per
separator, like the core Slides plugin. In that mode everything after `note:`
on a slide goes to the speaker notes.

Text is never shrunk below a readable size to fit. Long content continues on
the next slide.

## Settings

- **New slide at**: automatic, `---` separators, or a fixed heading depth.
- **Title slide**, **Slide numbers**: on or off.
- **Theme**: Light, Paper, Dark, Violet.
- **Slide size**: 16:9 or 4:3.
- **Font**, **Code font**: font names written into the file. Fonts are not
  embedded, so pick ones installed where the deck will be opened.
- **Save to**: a vault folder, or next to the note.
- **Open after export** (desktop).
- **AI design**: sign in to or out of EditablePPT.

## What export does not do

- Images on the web (`![](https://...)`) are skipped, because the plugin never
  uses the network. Images in the vault are embedded. WebP, SVG, GIF and very
  large images are converted to PNG or JPEG first; an animated GIF keeps only
  its first frame.
- Math is exported as its LaTeX source in italics, not typeset.
- Mermaid and other rendered code blocks are exported as their source.
- Embedded notes (`![[Other note]]`) appear as their name, not their content.
- HTML in a note is reduced to its text.
- Slide heights are estimated from the text, without measuring fonts. A slide
  can end up with spare room, or need a small manual adjustment with an
  unusual font.

## Development

```bash
npm install
npm run dev      # rebuild main.js on change
npm run build    # type-check and build main.js
npm test
npm run sample   # build decks from samples/*.md into output/, without Obsidian
```

To try a build, copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/note-to-powerpoint/` and enable the plugin.

`scripts/render-keynote.sh output/<name>.pptx` renders a deck to PNG pages
through Keynote (macOS, needs `pdftoppm`), to see what a presentation app makes
of it.

The pipeline is `src/parse.ts` (Markdown to blocks), `src/outline.ts` (blocks
to slides), `src/layout.ts` (slides to positioned frames, including the split
over several pages), and `src/render.ts` (frames to PPTX with
[PptxGenJS](https://github.com/gitbrent/PptxGenJS)). AI design lives in
`src/cloud/`: `api.ts` and `job.ts` (the EditablePPT calls, no Obsidian), then
`controller.ts` and `modal.ts`. To point it at a local EditablePPT server, set
`"serviceUrl"` in the plugin's `data.json`.

## License

MIT. Built by [EditablePPT](https://editableppt.com).
