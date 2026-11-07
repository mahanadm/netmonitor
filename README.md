# Net Monitor

A small desktop app (Windows + macOS, built on Electron) that watches your internet
connection and records **disconnects**, **packet loss** and **high latency** so you have
evidence to show your ISP.

## How it works
- Every 2 s (configurable) it pings several targets in parallel (default `1.1.1.1`, `8.8.8.8`, `9.9.9.9`) using the OS `ping` command, so no admin rights are required.
- Each round is classified:
  - **Disconnect** – every target failed
  - **Packet loss** – at least half (but not all) of the targets failed
  - **High latency** – median RTT above the threshold (default 150 ms)
- An incident is recorded only after several consecutive bad rounds (default 3) and closed after 2 good ones, so one-off blips don't spam the log. Start time is the first bad round.
- Incidents are stored as JSON in the app's user-data folder; the app keeps running in the tray when the window is closed.
- Tray icon: green = online, amber = degraded, red = offline. Desktop notifications on start/end of incidents.
- When an incident starts, a traceroute to the first target is captured (`tracert` on Windows, `traceroute` on macOS) and attached to it. Click an incident row to see the hops and where the path stops responding.
- **Export CSV** from the dashboard for sharing.

## Develop
```
npm install
npm start       # run the app
npm test        # unit tests for ping parsing, incident detection, storage, CSV
npm run dist    # build installers (run on each OS: .exe on Windows, .dmg on macOS)
```

## Layout
- `src/core` – platform-independent monitoring logic (no Electron imports, fully unit-tested)
- `src/main` – Electron main process: tray, notifications, IPC, file export
- `src/renderer` – dashboard UI (plain HTML/JS, no build step)

## Roadmap ideas
Launch at login, DNS-resolution probes, gateway probe, per-incident detail view, data retention settings, code signing.
