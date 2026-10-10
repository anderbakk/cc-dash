# cc-dash

A web dashboard for when you have a lot of Claude Code sessions going at once.
Every session is listed in a sidebar with its name, folder, git branch, cost and
live status. Click one and its terminal opens right in the browser. A side panel
shows the git diff, lets you browse files, and previews Markdown, HTML and images.

```
┌ sidebar ─────────────┬ terminal (the real claude CLI) ─┬ panel ───────────────┐
│ RUNNING HERE         │                                 │ Diff | Files | Prev. │
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

Requires Node 20+ and Claude Code (`claude` on PATH).

To see live status (working / waiting for you / your turn) in the sidebar,
install the hooks once:

```bash
npm run setup          # adds hooks + status line to ~/.claude/settings.json
npm run setup:remove   # removes them again
```

`setup` only touches its own entries, makes a backup
(`settings.json.cc-dash-backup`), and if you already have a status line it keeps
it: cc-dash's status line runs yours and shows its output.

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
| `CC_DASH_SHELL` | `powershell.exe` / `$SHELL` | shell that starts claude |
| `CC_DASH_CLAUDE_CMD` | `claude` | command to start |
| `CC_DASH_RECENT_DAYS` | `14` | how far back transcripts are read |
| `CC_DASH_DIR` | `~/.cc-dash` | cc-dash's own files |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | same as Claude Code |

## Tips

- **Shift+Enter** gives a new line in Claude's prompt.
- The UI is in Norwegian for now.

## Known limitations

- node-pty is pinned to `1.2.0-beta.15` because it is the first version with
  prebuilt binaries for Linux and Windows. No compiler or Visual Studio Build
  Tools needed.
- Sessions in other terminals are detected through the hooks. If such a
  terminal crashes without `SessionEnd`, the session shows as open for up to
  24 hours.
