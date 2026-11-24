# Rich TeX Editor

A rich LaTeX editor for [Orca](https://orca.dev). It opens `.tex`, `.ltx` and `.latex` files in two
views you can switch between at any time. The file stays plain LaTeX on disk.

- **Visual**: you edit the source, but anything the cursor isn't on shows rendered. `\section{…}`
  becomes a numbered heading, `\textbf{…}` shows as bold, math is typeset with KaTeX, `\ref` and
  `\cite` resolve to numbers, lists get bullets, tables and images are drawn, theorems get their
  numbered titles, footnotes shrink to their mark (hover to read them), the preamble folds to a
  one-line summary, environments show a thin labelled rule where they begin and end (the `{ }`
  toolbar button hides them), and lines that only arrange the page (`\centering`) fold away. Put the cursor on something, or click it, to see and edit its source. Display math shows a
  live rendering under the source while you edit it.
- **Split**: highlighted source with line numbers beside a live preview of the whole document:
  title block, numbered sections, equations, figures, tables, theorems, footnotes and the
  bibliography. The two panes scroll together. Double-click the preview to jump to that line.

**Images**: drag image files onto the editor, paste a screenshot, or use Insert → Image…. Each one
is saved into a `figures/` folder next to the `.tex` file (never overwriting a file) and a
`figure` with a caption to fill in is inserted. Images that `\includegraphics` references are shown
in both views, including extension-less names and `\graphicspath` folders: PNG, JPEG, GIF, WebP
and SVG, up to 25 MB each. PDF figures can be added and are found, but show as a card with their
path rather than drawn (a PDF renderer would more than double the plugin's size). A figure
redrawn on disk (a script or an agent writes a new plot) shows its new version within a few
seconds, and one the document names before it exists appears once it is written. TikZ, pgfplots
and other pictures only TeX can draw are not drawn here: the visual view shows their code as code
and the preview a card in their place. To see one, compile it to an image (as
`examples/figures/descent.tex` is) and `\includegraphics` that; it updates when you recompile. The
editor finds the `.tex` file on disk by its contents, so if the tab already had unsaved changes
when it opened, save once before adding an image; it never guesses another folder.

Both views have a formatting toolbar (headings, bold/italic/underline/monospace, inline and
display math, lists, links, a symbol palette and an Insert menu for equations, figures, tables
and theorems), autocompletion for commands, environments, `\ref` labels and `\cite` keys, find
and replace, and export of the preview as a standalone HTML file. Macros you define with
`\newcommand` or `\DeclareMathOperator` work in every formula.

Rich TeX Editor does not run TeX. It renders a large, common subset of LaTeX in the editor; use
your usual toolchain (for example `latexmk`) for the final PDF.

## Shortcuts

| Keys            | Action                                |
| --------------- | ------------------------------------- |
| ⌘B / ⌘I / ⌘U    | Bold, italic, underline (toggles)     |
| ⌘E              | `\emph`                               |
| ⌘M / ⇧⌘M        | Inline math, display math             |
| ⌘K              | Link                                  |
| ⌘F              | Find and replace                      |
| ⌘/              | Comment or uncomment lines            |
| ⌘Z / ⇧⌘Z        | Undo, redo                            |
| Ctrl+Space      | Show completions                      |

Ctrl replaces ⌘ on Windows and Linux.

## Working with agents

If the file changes on disk (an agent rewrites a paragraph, say), only the lines that changed are
replaced, so your cursor and your undo history stay where they were, and CRLF files stay CRLF.
If you have unsaved edits at that moment, the editor merges both line by line. Edits to different lines are kept as they are; when both
sides changed the same lines, both versions stay in the file between `%` comment markers, so the
document still compiles and nothing is lost.

## Access

The editor runs in Orca's isolated frame with no network and sees only the file it opens. Orca
never tells an editor where that file is, so the plugin also runs a small Node worker
(`trusted-worker`) to save and read images, and asks for `workspace:read` to learn your workspaces'
folders. The worker finds the open file by its contents, and it reads and writes only image files
(`.png .jpg .jpeg .gif .webp .svg .pdf`) inside your Orca workspaces: every path is checked against
the workspace folder, symbolic links included. It runs no commands and makes no network requests.
Your view choice and split width are kept in the frame's local storage.

## Develop

Requires Orca 1.4.248 or newer and Node 22.

```sh
npm install
npm run build          # bundles src/ into editor/app.js and copies KaTeX into editor/vendor/
npm run typecheck
npm test               # `orca plugin test .` (scanner, math, macros, renderer, merge, sync)
                       # plus the CodeMirror specs in src/**/*.spec.ts, bundled and run with node --test
orca plugin check .    # static check of the editor entry
orca plugin dev watch . --check   # load into Orca; rebuild with `npm run watch` in another terminal
```

To try the editor in a plain browser, serve the repository root (`python3 -m http.server`) and open
`/dev/harness.html?mode=split&theme=dark`. `dev/orca-mock.js` stands in for Orca's `orca` object and
exposes `window.__orcaMock` (`changes`, `replace(text)` to simulate an outside write).

`examples/showcase.tex` and `examples/figures-demo.tex` exercise most of what the editor draws.

`editor/app.js` and `editor/vendor/` are build output, committed because Orca loads plugin files
as they are. The sources are in `src/`:

| Path                      | What it does                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `src/main.ts`             | Starts the editor, the view switch, scroll sync, images, export |
| `src/protocol.ts`         | The requests between the editor and the worker                 |
| `src/images.ts`           | Locates the file, loads images, saves dropped and pasted ones  |
| `worker/`                 | The Node worker: finds the .tex file, saves and reads images   |
| `src/sync.ts`, `merge.ts` | Orca document session and the three-way line merge             |
| `src/latex/scan.ts`       | Finds math, headings, formatting, references in the source     |
| `src/latex/math.ts`       | Makes each formula KaTeX-ready with document-wide numbering    |
| `src/latex/macros.ts`     | Reads `\newcommand`-style macros                               |
| `src/latex/preview.ts`    | Renders the whole document to HTML for the split view          |
| `src/editor/`             | CodeMirror setup, visual decorations, commands, completions    |
| `src/ui/`                 | Toolbar and the preview pane                                   |

KaTeX is © Khan Academy and contributors (MIT); its stylesheet and fonts ship in
`editor/vendor/katex/`. CodeMirror is © Marijn Haverbeke and contributors (MIT).

## License

MIT
