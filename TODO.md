# TODO

Prioritert etter verdi i daglig bruk.

## Nå

- [x] **Sesjoner som bruker flere mapper.** Finn mappene en sesjon har skrevet til
      eller jobbet i utenfor startmappen (fra verktøykallene i transkriptet), og vis
      dem under Diff og Filer. Mapper som ikke er git-repo viser filene Claude har
      endret i sesjonen.

## Snart

- [ ] **Autostart på Windows.** Med node-pty dør alle sesjoner når cc-dash stopper.
      `npm run install-service` som registrerer en planlagt oppgave ved pålogging
      (`--no-open`), og `npm run uninstall-service`.
- [ ] **Tester.** `test/folders.test.js` er på plass (og `npm test` virker igjen). Dekk transkript-
      parsing (kostnad, tittel, mapper), `safeResolve` og `setup.js`.
- [ ] **Riktig hint ved opptatt port.** Feilmeldingen foreslår `PORT=7421 npm start`,
      som ikke virker i PowerShell.
- [ ] **Eget token for forhåndsvisning.** `/raw/<token>/…` bruker hovedtokenet, og
      forhåndsvist HTML kan kjøre skript og lese sin egen URL. Bruk et token som bare
      gir lesetilgang til filer.

## Senere

- [ ] Rydd opp i / avslutt flere sesjoner samtidig.
- [ ] Filtrer sidebaren per prosjekt.
- [ ] Kostnad per dag og per prosjekt.
- [ ] Engelsk UI (README sier «Norwegian for now»).
- [ ] Ekstern tilgang via Tailscale (`HOST=<tailscale-ip>`), lagt på is.
