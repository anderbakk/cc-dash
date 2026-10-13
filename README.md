# cc-dash

A web dashboard for when you have a lot of Claude Code sessions going at once.
Every session is listed in a sidebar with its name, folder, git branch, cost and
live status. Click one and its terminal opens right in the browser. A side panel
shows the git diff, lets you browse files, and previews Markdown, HTML and images.

```
┌ sidebar ─────────────┬ terminal (the real claude CLI) ─┬ panel ───────────────┐
│ RUNNING HERE         │                                 │ Diff | Files | Links │
│ ● Fix login  $1.20   │  > fix the login bug            │ M src/auth.ts  +12 −3│
│   api · main  working│                                 │ @@ -10,6 +10,9 @@    │
│ ◐ Blog post  $0.35   │                                 │ + const token = …    │
│   blog  waiting      │                                 │                      │
│ RECENT               │                                 │                      │
│   Refactor   $4.10   │                                 │                      │
└──────────────────────┴─────────────────────────────────┴──────────────────────┘
```

Runs on Linux, macOS and Windows (native PowerShell).

## Quick start

```bash
git clone <repo> cc-dash
cd cc-dash
npm install
npm start          # opens http://127.0.0.1:7420/?token=…
```

Requires Node 20+ and Claude Code (`claude` on PATH). `git` must also be on
PATH for the diff and file panels.

On Windows, Claude Code is a native binary and does not bring Node with it, so
install Node separately — `winget install OpenJS.NodeJS.LTS` — and open a new
terminal afterwards so `node` is on PATH. Everything else is the same;
PowerShell works, Git Bash and WSL are not needed.

To see live status (working / waiting for you / your turn) in the sidebar,
install the hooks once:

```bash
npm run setup          # adds hooks + status line to ~/.claude/settings.json
npm run setup:remove   # removes them again
```

`setup` only touches its own entries, makes a backup
(`settings.json.cc-dash-backup`), and if you already have a status line it keeps
it: cc-dash's status line runs yours and shows its output.

The entries point at the full path of the node that ran `setup`, since `node`
is often missing from the PATH that hooks are started with. Run `npm run setup`
again if you move the repo or switch Node version.

## Starting without a terminal

`npm start` runs cc-dash in the terminal you start it from, and with node-pty
(always on Windows) the sessions end when that terminal closes. To run it in
the background instead:

```bash
npm run launch   # start in the background, or just open it if it already runs
npm stop         # stop it (ends its node-pty sessions; continue them with --resume)
```

`launch` runs `npm ci` first whenever `package-lock.json` has changed, and
writes the server's output to `~/.cc-dash/server.log`. Starting twice is
harmless: a second `npm start` or `launch` opens the cc-dash that is already
running.

On Windows, make Start menu shortcuts for the same two:

```bash
npm run shortcut                    # "cc-dash" and "Stop cc-dash" in the Start menu
npm run shortcut -- --autostart     # also start in the background when you log in
npm run shortcut -- --auto-update   # pull the latest version on every start
npm run shortcut:remove             # remove them again
```

With `--auto-update` (or `"autoUpdate": true` in `~/.cc-dash/config.json`),
each start runs `git pull --ff-only` first, but only when you are on the
default branch with nothing uncommitted; otherwise it says why and starts the
version you have. It only happens when cc-dash is not already running, so an
update never ends your sessions.

## Profiles

"+ New session" starts a session from a profile. Out of the box there are two:
**Claude** and **Terminal** (a plain shell, no Claude). Add your own under
`profiles` in `~/.cc-dash/config.json`; your list replaces the defaults, so
keep the two if you want them:

```json
"profiles": [
  { "name": "Claude" },
  { "name": "Terminal", "command": null },
  { "name": "Work + Claude", "shell": "pwsh", "init": "Use-WorkTenant", "tag": "WORK", "color": "red" },
  { "name": "Work", "shell": "pwsh", "init": "Use-WorkTenant", "command": null, "tag": "WORK", "color": "red" },
  { "name": "Python", "init": "source .venv/bin/activate", "command": null, "cwd": "~/src/app" }
]
```

| Field | | Default |
|---|---|---|
| `name` | shown in the UI | required |
| `shell` | shell that runs everything | `CC_DASH_SHELL`, else `powershell.exe` / `$SHELL` |
| `init` | command run in that shell first; functions from your shell profile work | none |
| `command` | the command that starts Claude; `null` gives a plain shell | `claude` |
| `env` | extra environment variables | none |
| `cwd` | folder filled in when the profile is picked | none |
| `tag` | short label on its sessions, e.g. `"PROD"` | none |
| `color` | color of the tag and a stripe on its sessions: `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `gray` or a hex code | `gray` when `tag` is set |

Changes apply right away, no restart needed. When you continue a session with
"Continue here", the profile it was started with is used again, and you can
pick another one. A plain terminal has no transcript: it shows under "Running
here" while it is open and is gone once you exit it. With a POSIX shell,
variables exported by `init` carry over into the plain shell, but functions
and aliases it defines do not.

Profiles can only be defined in the config file, not through the web UI or
API, so a page that got hold of the token cannot add a command of its own.

## How it works

```
Browser ──WebSocket──► Node server ──node-pty──► claude
   ▲                      │      (or tmux on Linux/macOS)
   └──── /api/sessions ◄──┴── reads ~/.claude/projects/*.jsonl  (titles, cost)
                              reads ~/.cc-dash/status/*.json     (hooks: live status)
```

- **The terminal is real.** What you type in the browser goes straight to
  Claude's stdin, and xterm.js draws exactly what the CLI writes out. Slash
  commands, permission prompts and everything else work as usual.
- **The session list** comes from Claude Code's own transcripts, so sessions
  you started in ordinary terminals also show up. You can continue them in
  cc-dash with one click (`claude --resume`).
- **Cost** is calculated from the token usage in the transcripts (subagents
  included) at API list prices. On a subscription it shows what the usage would
  have cost on the API.

### Terminal backends

| | Linux / macOS with tmux | Windows (or no tmux) |
|---|---|---|
| Process | private tmux server (`tmux -L cc-dash`) | node-pty directly (ConPTY) |
| Survives closing the browser | yes | yes |
| Survives restarting cc-dash | yes | no, but continue with "Continue here" (`--resume`) |

With tmux you can also attach from an ordinary terminal:
`tmux -L cc-dash attach -t cc-<id>`.

## Security

- The server listens only on `127.0.0.1`. Everything requires a token, which
  is stored in `~/.cc-dash/config.json`. Open the link that `npm start` prints
  and a cookie is set.
- Host and Origin headers are checked (against DNS rebinding and cross-site
  requests).
- File access is read-only and confined to the session's folder.
- Previewed HTML runs in a sandboxed iframe with no access to cc-dash.

Never set `HOST=0.0.0.0` on a network you don't trust. This is a shell in the
browser. For remote access, use e.g. Tailscale or an SSH tunnel.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `7420` | |
| `HOST` | `127.0.0.1` | |
| `CC_DASH_NO_OPEN` | | don't open the browser automatically (or `--no-open`) |
| `CC_DASH_HOST` | auto | `pty` forces node-pty even when tmux is available |
| `CC_DASH_SHELL` | `powershell.exe` / `$SHELL` | shell for profiles that don't set `shell` |
| `CC_DASH_CLAUDE_CMD` | `claude` | command to start |
| `CC_DASH_RECENT_DAYS` | `14` | how far back transcripts are read |
| `CC_DASH_DIR` | `~/.cc-dash` | cc-dash's own files |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | same as Claude Code |

## Tips

- **Shift+Enter** gives a new line in Claude's prompt.
- **Ctrl+.** jumps to the next session that needs you: first the ones waiting
  for permission, then finished turns you haven't looked at yet.
- Under **Files**, the arrow keys browse: ↑/↓ preview each file in turn, →
  opens a folder and ← goes back up. ⤢ gives the preview the whole panel.
- The UI is in English or Norwegian. It follows the browser language; switch
  with the button at the bottom of the sidebar.

## Known limitations

- node-pty is pinned to `1.2.0-beta.15` because it is the first version with
  prebuilt binaries for Linux and Windows. No compiler or Visual Studio Build
  Tools needed.
- Sessions in other terminals are detected through the hooks. If such a
  terminal crashes without `SessionEnd`, the session shows as open for up to
  24 hours.
