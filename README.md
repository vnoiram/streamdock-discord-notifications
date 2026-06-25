# streamdock-discord-notifications

Mirabox Stream Dock JavaScript/HTML plugin for displaying Discord DM previews from Windows notifications.

This plugin must not read Discord DMs directly through Discord user or bot APIs. It should consume notification data exposed by a local Windows helper using `UserNotificationListener`.

## Version

Current version: `0.2.0`.

Notable `0.2.0` updates:

- Added `npm run clean` for removing generated `dist/` output.
- Added `npm run release:zip` as the standard release entry point.
- Release zips now include the manifest version in the filename.

Initial actions:

- Show latest Discord DM sender
- Show notification body preview when Windows exposes it
- Show permission or unavailable state when notification access is missing
- Browse notification history with a knob
- Clear displayed history
- Filter by sender/body text
- Monitor another notification app by display-name substring, such as Slack or Teams
- Optional sender-only filter and helper-side history persistence
- Sender picker in the Property Inspector: refresh known senders from helper history, then choose a sender and use exact or contains matching.
- Per-action sender filters: place multiple `Sender DM` actions and assign each key to a different sender.
- Per-sender read state: pressing `Clear` with a sender filter marks only that sender's visible history as read.
- Sender-filtered history browsing: knob rotation walks the history that matches the current action's sender/body filter.
- Temporary preview: set `Temp preview` seconds to briefly show message text after a new notification, then fall back to the selected privacy mode.
- Visual alert: matching actions switch their key image to an unread/new state. `Alert sec` controls how long the stronger new-message color is kept.
- Per-action visual styling: set normal/fresh background colors, foreground color, label, and sublabel for each notification rule.
- Per-action title prefix, regex filter, quiet hours, and auto-read timer.
- History storage controls: `Store max` controls helper-side persisted history count and `Save path` can override the helper history JSON path. Empty path uses the helper default under `%LOCALAPPDATA%\StreamDock\`.
- Property Inspector `Copy` / `Paste` for duplicating both global notification settings and per-action filters between keys.
- Privacy modes: preview, sender-only, count-only
- Diagnostics action

Default helper endpoint:

```text
ws://127.0.0.1:41921
```

Expected helper messages:

- Dock to helper: `{ "command": "subscribe", "app": "Discord" }` and `{ "command": "latest", "app": "Discord" }`. `app` may be another Windows notification app display-name substring.
- Helper to Dock: `{ "event": "notification", "sender": "...", "body": "...", "preview": true }`.
- Helper to Dock: `{ "event": "permission", "status": "granted" }` or `{ "event": "permission", "status": "denied" }`.

## Repository Layout

- `manifest.json`: Stream Dock plugin manifest.
- `plugin.html` / `plugin.js`: Stream Dock runtime plugin.
- `property-inspector.*`: Stream Dock settings UI.
- `icons/`: plugin icon assets.
- `scripts/package-plugin.js`: creates a distributable `.sdPlugin` directory.
- `helper/`: Windows notification listener helper.

## Stream Dock Plugin

Package this repository root as the plugin directory, or copy these files into a Stream Dock plugin folder:

- `manifest.json`
- `plugin.html`
- `plugin.js`
- `property-inspector.html`
- `property-inspector.js`
- `property-inspector.css`
- `icons/`

The plugin defaults to `ws://127.0.0.1:41921`, which maps to the helper's `http://127.0.0.1:41921/` WebSocket listener.

Build a distributable plugin folder:

```bash
npm run package
```

Clean build output:

```bash
npm run clean
```

The output is written under `dist/`.

Create a release zip on Windows/PowerShell:

```powershell
npm run release:zip
```

## Helper

The Windows helper lives in `helper/` and is a .NET Windows console app.

### Build

Prerequisites:

- Windows 10 or later.
- .NET SDK 8 or later.

Build:

```powershell
dotnet build helper\DiscordNotificationHelper.csproj -c Release
```

Run from source:

```powershell
dotnet run --project helper\DiscordNotificationHelper.csproj
```

Run with a log file:

```powershell
dotnet run --project helper\DiscordNotificationHelper.csproj -- --log-file "$env:TEMP\streamdock-discord.log"
```

It listens on `http://127.0.0.1:41921/` for WebSocket upgrades, requests Windows notification listener access, and filters toast notifications whose app display name contains the configured app name. History is persisted under `%LOCALAPPDATA%\StreamDock\discord-notifications-history.json` by default. The Stream Dock Property Inspector can send a runtime `configure` command to change the history file and maximum retained items.

Per-action `Regex` is matched against sender and body text. `Quiet start` / `Quiet end` suppress unread/visual increments during that local time window while still keeping history. `Auto read` clears the unread count after the configured number of seconds.

The first run may prompt for Windows notification access. If access is denied, enable notification listener access in Windows privacy/settings and restart the helper.

## Local Checks

JavaScript and manifest checks:

```bash
npm run check
```

Helper build, on Windows with .NET:

```powershell
npm run build:helper
```

Install the published helper into Windows startup:

```powershell
.\scripts\install-startup.ps1
```
