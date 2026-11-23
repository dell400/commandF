# Deep Find

Cmd-F for Chrome that also looks one step further. It works like Chrome's find bar, and it also finds the word:

- in pages, PDFs and images the page links to
- in scanned PDFs (pages with no text get OCR)
- in images on the page (OCR)

Everything runs on your Mac. Nothing is sent anywhere except the downloads of the linked pages themselves.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `deep-find` folder.
4. Pin the magnifier icon in the toolbar (puzzle-piece menu → pin), if you like.

## Use

1. On any web page, press **Cmd-F**. A find bar opens at the top right, like Chrome's.
   Selected text on the page fills it in.
2. Type a word or name. Matches on the page turn yellow and the count shows, for example `1/6`.
3. Press **Enter** for the next match, **Shift-Enter** for the previous one. **Cmd-G** and **Cmd-Shift-G** work too.
4. After a short pause, Deep Find also searches the links on the page (words of 3 or more letters).
   - Each link whose page or PDF contains the word becomes one stop, in page order. Matching links turn light blue.
   - At a link stop, the bar shows where the word is (for example "In linked PDF, page 2") and a line of text around it. **Open** opens the PDF at that page, or the web page with the word highlighted.
   - Images whose text contains the word are stops too.
   - While links are searched, the bar shows `↻ links 12/50`. When done, it shows how many links matched.
5. **Esc** closes the bar and leaves the last match selected.

The **≡** button opens the side panel with every result in a list.
Option-Shift-F or the toolbar icon also open the side panel.

On Chrome's own pages (`chrome://`, the Web Store) and on PDFs open in Chrome's viewer, Cmd-F opens Chrome's normal find bar. Extensions can't run there. Use Option-Shift-F for the side panel.

To get Chrome's find bar back everywhere, turn off **Use Deep Find for ⌘F** in the side panel.
To change the Option-Shift-F shortcut, open `chrome://extensions/shortcuts`.

### Options (in the side panel)

- **OCR images and scans**: turn off for a fast, text-only search.
- **Links**: how many links to search (default 50). PDF links are searched first.
- **Use Deep Find for ⌘F**: off gives you Chrome's own find bar.

### Cache

Text from each link and image is kept for 7 days, shared by the find bar and the side panel. Typing more letters, or searching the same page again, needs no new downloads.
Click **Clear cache** at the bottom of the panel if a document has changed.

## Limits

- OCR takes 1–3 seconds per scanned page. A 200-page scan takes several minutes. Click **Stop** at any time.
- Linked pages that build their text with JavaScript return little or no text.
- Only one level of links. It does not follow links on the linked pages.
- Word, Excel and zip files are skipped.
- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store.
- The find bar searches the main page, not text inside embedded frames.
- OCR can misread a letter. If a name is not found, try the last name alone.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Extension setup, permissions, shortcut |
| `background.js` | Opens the side panel; starts the offscreen worker |
| `findbar.js` | On every page: the Cmd-F find bar |
| `offscreen.html/.js` | Hidden worker page: downloads links, PDF text, OCR for the find bar |
| `content.js` | Reads the current page for the side panel |
| `engine.js` | Downloads, PDF text, OCR, matching. No `chrome.*` calls |
| `idbcache.js` | 7-day text cache in IndexedDB |
| `sidepanel.html/.css/.js` | The panel UI, cache, opening results |
| `lib/` | pdf.js 6.5.438 and Tesseract.js 7.0.0 (core 7.0.0, English data) |
| `test/` | A test page with fixtures. Not used by the extension |

## Test without installing

`test/harness.html` runs the real panel code against `test/fixtures/gov-page.html`, with a small stand-in for the `chrome.*` APIs. Serve the folder over HTTP and open it:

```bash
python3 -m http.server 8765
```

Then open `http://127.0.0.1:8765/test/harness.html` and search for `Bartholomew Quince`. Expected: 4 matches (a web page, a text PDF p.2, an image, a scanned PDF p.2).

For the find bar, open `http://127.0.0.1:8765/test/fixtures/gov-findbar.html`, press Cmd-F and type `Bartholomew Quince`. Expected: `6` stops — 2 on the page, the image, 2 PDFs and the staff page.
