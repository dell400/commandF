# Deep Find

A Chrome side panel that finds a word or name in places Cmd-F misses:

- text on the current page
- text inside images on the page (OCR)
- pages, PDFs and images the page links to, one level deep
- scanned PDFs (pages with no text get OCR)

Everything runs on your Mac. Nothing is sent anywhere except the downloads of the linked pages themselves.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `deep-find` folder.
4. Pin the magnifier icon in the toolbar (puzzle-piece menu → pin), if you like.

## Use

1. Go to the page you want to search, for example a gov page that lists meeting minutes.
2. Press **Cmd-F**. Deep Find opens in the side panel instead of Chrome's find bar.
   Option-Shift-F and the toolbar icon also open it. Selected text on the page fills the search box.
3. Type the name and press **Return**.
4. Results appear as they are found. Click one to go there:
   - text on this page: Chrome selects it
   - an image on this page: Chrome scrolls to it and outlines it
   - a linked PDF: opens at the right page
   - a linked web page: opens and highlights the name

On Chrome's own pages (`chrome://`, the Web Store) and on PDFs open in Chrome's viewer, Cmd-F still opens Chrome's find bar. Use Option-Shift-F there.

To get Chrome's find bar back everywhere, turn off **⌘F opens Deep Find** in the panel.
To change the Option-Shift-F shortcut, open `chrome://extensions/shortcuts`.

### Options

- **OCR images and scans**: turn off for a fast, text-only search.
- **Links**: how many links to search (default 50). PDF links are searched first.
  If the page has more links, the status line says so. Raise the number and search again.

### Cache

Text from each link and image is kept for 7 days. A second search of the same page takes well under a second.
Click **Clear cache** at the bottom of the panel if a document has changed.

## Limits

- OCR takes 1–3 seconds per scanned page. A 200-page scan takes several minutes. Click **Stop** at any time.
- Linked pages that build their text with JavaScript return little or no text.
- Only one level of links. It does not follow links on the linked pages.
- Word, Excel and zip files are skipped.
- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store.
- OCR can misread a letter. If a name is not found, try the last name alone.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension setup, permissions, shortcut |
| `background.js` | Opens the side panel |
| `content.js` | Reads the current page: text, images, links |
| `hotkey.js` | On every page: sends Cmd-F to Deep Find |
| `engine.js` | Downloads, PDF text, OCR, matching. No `chrome.*` calls |
| `sidepanel.html/.css/.js` | The panel UI, cache, opening results |
| `lib/` | pdf.js 6.5.438 and Tesseract.js 7.0.0 (core 7.0.0, English data) |
| `test/` | A test page with fixtures. Not used by the extension |

## Test without installing

`test/harness.html` runs the real panel code against `test/fixtures/gov-page.html`, with a small stand-in for the `chrome.*` APIs. Serve the folder over HTTP and open it:

```bash
python3 -m http.server 8765
```

Then open `http://127.0.0.1:8765/test/harness.html` and search for `Bartholomew Quince`. Expected: 4 matches (a web page, a text PDF p.2, an image, a scanned PDF p.2).
