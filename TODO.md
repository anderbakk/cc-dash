# TODO

Prioritised by value in daily use.

## Now

- [x] **Sessions that use several folders.** Find the folders a session has written
      to or worked in outside its start folder (from the tool calls in the transcript),
      and show them under Diff and Files. Folders that are not git repos show the files
      Claude changed in the session.
- [x] **English UI.** The UI is available in English and Norwegian; the language
      follows the browser and can be switched in the sidebar footer.
- [x] **Skipper.** One session that runs the others through cc-dash's MCP tools:
      tasks with worktrees, events typed in when it is idle, PR status via gh/az.
- [ ] **Fleet view.** A panel with every task: story, phase, PR, crew state, and
      buttons to open the crew or the PR.
- [ ] **Skipper: away mode.** Let it answer the crew more freely while you are
      away, and give a digest when you are back (like firstmate's `/afk`).
- [ ] **Story status from the tracker.** Show the work item / issue state next to
      the task, not only the PR state.

## Soon

- [ ] **Autostart on Windows.** With node-pty, every session dies when cc-dash stops.
      `npm run install-service` that registers a scheduled task at logon
      (`--no-open`), and `npm run uninstall-service`.
- [ ] **Tests.** `test/folders.test.js` is in place (and `npm test` works again). Cover
      transcript parsing (cost, title, folders), `safeResolve` and `setup.js`.
- [ ] **Correct hint when the port is taken.** The error message suggests
      `PORT=7421 npm start`, which does not work in PowerShell.
- [ ] **Separate token for previews.** `/raw/<token>/…` uses the main token, and
      previewed HTML can run scripts and read its own URL. Use a token that only
      grants read access to files.

## Later

- [ ] Clean up / end several sessions at once.
- [ ] Filter the sidebar per project.
- [ ] Cost per day and per project.
- [ ] Translate server error messages, so they follow the UI language too.
- [ ] Remote access via Tailscale (`HOST=<tailscale-ip>`), on hold.
