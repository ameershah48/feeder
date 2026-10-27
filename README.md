# Feeder

Scan from your **HP ScanJet Pro 2000** straight into a web page, like the HP Scan app.
Press **Scan** and each page appears in the browser as it comes out of the feeder. You can
reorder, rotate and delete pages, then press **Identify cards** to look each trading card up with the
[TCGSDK scanner API](https://tcgsdk.com/docs/scanner-scan).

## Requirements

- macOS, with the scanner connected by USB
- Node.js 20 or newer
- Xcode Command Line Tools, used to compile the small native helper (`xcode-select --install`)
- HP's scanner driver. It's already installed if **Image Capture** or **HP Easy Scan** can see the scanner.

## Run it

```sh
npm start
```

Then open <http://localhost:3000>.

The first `npm start` compiles `bin/scanhelper` from `native/scanhelper.swift`, which takes a few seconds.
No `npm install` is needed because the app has no dependencies.

## Identifying cards

1. Create an API token at <https://tcgsdk.com/settings/api-tokens>.
2. Copy `.env.example` to `.env`, set `TCGSDK_API_KEY=<your token>` and restart Feeder.
3. Set **Page size** to **Trading card** and scan your cards one-sided.
4. Optionally pick the card game next to the button, then press **Identify cards**.

Feeder sends the pages one at a time. Each result appears under its thumbnail, and the viewer lists up to five
possible matches with set, number, rarity and price. The scanner API is in beta, so treat its answers as suggestions.

- With nothing selected, the button checks every page that has no answer yet. Select pages to check them again.
- TCGSDK allows 10 scans a minute and 100 a day. Feeder waits out the per-minute limit by itself and stops
  when the daily limit is reached.
- The **Trading card** size scans a 63 × 88 mm card with a margin, so a crooked card isn't cut off.
  On the ScanJet Pro 2000 that uses the A7 page size (74 × 105 mm).
- Short answers are saved in `scans/pages.json`. The full API responses are kept in `scans/matches/` for troubleshooting.

## How it works

Browsers can't talk to scanners directly, so the app has three parts:

```
Browser (public/)  ⇄  Node server (server.js)  ⇄  bin/scanhelper (Swift + ImageCaptureCore)  ⇄  scanner
     live updates over SSE      spawns the helper, reads JSON lines        Apple's native scanning API
```

- **`native/scanhelper.swift`** uses Apple's ImageCaptureCore framework, the same one Image Capture uses.
  It finds the scanner, opens a session, sets up the document feeder, scans, and reports each page as a JSON line.
- **`server.js`** runs the helper, moves each finished page into `scans/`, creates a thumbnail with `sips`,
  sends pages to TCGSDK when you identify cards, and pushes updates to the browser with Server-Sent Events.
- **`public/`** is the UI.

Scans are kept in `scans/` (`pages.json` stores the page order), so they're still there after a restart.

## Settings

| Env var     | Default     | Purpose |
|-------------|-------------|---------|
| `PORT`      | `3000`      | HTTP port |
| `HOST`      | `127.0.0.1` | Interface to listen on. `HOST=0.0.0.0` lets you open the app from your phone, but **anyone on your network can then see your scans** because there is no login. |
| `SCANS_DIR` | `./scans`   | Where pages are stored |
| `TCGSDK_API_KEY` | (none) | TCGSDK API token, needed for **Identify cards**. Put it in `.env`. |
| `TCGSDK_API_URL` | `https://tcgsdk.com/api` | TCGSDK API base URL |

## Troubleshooting

- **"No scanner found"**: check the USB cable and power, then open **Image Capture**. If the scanner
  doesn't show up there either, install HP Easy Scan from hp.com.
- **"In use by another app"**: quit HP Easy Scan or Image Capture. Only one app can use the scanner at a time.
- **"TCGSDK did not accept the API token"**: check `TCGSDK_API_KEY` in `.env`, then restart Feeder.
- **Inspect what the driver supports** (resolutions, duplex, paper sizes, whether paper is loaded):

  ```sh
  npm run scanner-info
  ```

- You can also run the helper by hand:

  ```sh
  ./bin/scanhelper list
  ./bin/scanhelper scan --out /tmp/test --resolution 300 --mode color --duplex
  ```
