# Lucas' Agent-Setup auf deinen zwei Macs

Hallo Tobi, dieser Ordner baut Lucas' Setup auf deinen beiden Macs nach. Dein Claude-Code-Agent macht fast alles selbst; du tippst Passwörter, klickst Logins durch und beantwortest ein paar Fragen.

## Was du bekommst

Ein Mac wird zum **Host**: immer an, schläft nie, kommt nach einem Neustart mit einem Handgriff von dir wieder hoch. Auf ihm läuft **orch**, ein Claude-Code-Chat, der alle anderen Agent-Sessions beobachtet, Fragen an dich sammelt und für Coding-Aufgaben eigene Worker in eigenen Git-Worktrees startet. Der andere Mac bleibt dein **Arbeits-Mac** und bleibt ruhig: kein Agent öffnet dort Browser oder Apps.

Die beiden Macs reden über Tailscale miteinander (privates Netz, auch von unterwegs). Syncthing hält über dieses Netz sechs Ordner synchron: deine Claude-Konfiguration samt Skills und Memory, die **agent-bus**-Mailbox (signierte Nachrichten zwischen den Agents beider Macs), einen Ausgangsordner `~/AgentOutbox` für fertige PDFs und Bilder, eine schreibgeschützte Kopie deines Obsidian-Vaults auf dem Host, `~/Screenshots` (deine Screenshots, damit ein in eine Host-Session gezogener Screenshot dort ankommt) und `~/AgentImages` (Bilder, die Agents auf dem Host öffnen, landen bei dir).

Vom Handy erreichst du alles über die Claude-App (Remote Control): orch selbst, und neue Sessions direkt auf dem Host. Offene Entscheidungen siehst du zusätzlich auf einer kleinen Webseite im Tailnet, und jeden Morgen um 8 Uhr kommt ein Briefing aufs Handy.

Zwei Arbeitsweisen sind in `PLAYBOOKS.md` einmal komplett durchgespielt:

1. **Coding auf dem Host.** Du sagst orch „run my-app fix-login: …“, ein Worker arbeitet auf dem Host, orch lässt die Tests laufen, lässt Claude (und optional Codex) reviewen und fragt dich, bevor irgendwas gepusht oder gemerged wird.
2. **Lose Themen, die sich selbst vorbereiten.** Zum Beispiel „mach mir aus meinem Obsidian-Vault fünf Präsentationen zu unseren Kunden“. Der Host recherchiert im Vault, baut die Decks mit dem present-Skill, rendert PDFs unsichtbar im Hintergrund und legt sie in `~/AgentOutbox`. Du liest sie per Quick Look oder auf dem Handy und gibst Feedback im Chat oder als Datei.

## Was du selbst machen musst

Nur Dinge, die ein Agent nicht kann oder nicht darf:

- Den alten Mac zurücksetzen (Einstellungen, Allgemein, Übertragen oder zurücksetzen), den Benutzer anlegen und FileVault einschalten. **Auf beiden Macs denselben Kurznamen** verwenden.
- Ein paar Zeilen mit `sudo` im Terminal ausführen (Homebrew, Energiesparen, macOS-Update); der Agent gibt sie dir fertig zum Einfügen.
- In den Systemeinstellungen unter Freigaben „Entfernte Anmeldung“ (beide) und „Bildschirmfreigabe“ (Host) einschalten.
- Logins: Claude (Abo mit Claude Code, für den Host am besten Max, weil orch und mehrere Worker parallel viel verbrauchen), GitHub (`gh auth login`), Tailscale (kostenloses Konto reicht, gleicher Account auf beiden Macs, für den Host „Key Expiry“ im Admin-Panel abschalten), optional Codex mit deinem ChatGPT-Konto.
- Optional einen Gemini-API-Key für Bildgenerierung (aistudio.google.com).
- Nach der pstack-Installation Claude einmal neu starten. pstack ist Pflicht: orch startet jeden Claude-Worker im poteto-mode und verweigert den Start ohne pstack. Welche Modelle pstack pro Rolle nimmt, steht in `~/.claude/pstack/models.md`; der Agent legt dort Lucas' Aufteilung an (Opus für Code und Urteil, Sonnet zum Durchsuchen). Ändern kannst du das jederzeit mit `/pstack:setup-pstack`.
- In der Claude-App auf dem Handy Mitteilungen erlauben, damit orchs Entscheidungen und das Morgen-Briefing ankommen.
- Falls ein Repo Docker braucht: Docker Desktop einmal öffnen und die Bedingungen akzeptieren.
- Auf dem Arbeits-Mac evtl. Festplattenvollzugriff für Syncthing (Vault unter Dokumente) und für den Screenshot-Fänger freigeben; der Agent sagt dir, wo.
- Einmal dein Host-Passwort eintippen, damit der Arbeits-Mac per SSH auf den Host darf.
- Den **present**-Skill (HTML-Präsentationen im TIKI-Stil) bekommst du direkt von Lucas; er liegt nicht in diesem öffentlichen Repo.

## Wie lange es dauert

Rechne mit einem halben Tag, davon etwa eine Stunde aktiv für dich, verteilt auf kurze Momente. Am längsten dauern das Zurücksetzen und die macOS-Updates. Der Host braucht ungefähr zwei Stunden, der Arbeits-Mac danach noch etwa eine.

## So startest du

Du fängst mit dem Host an. Die beiden Agents wechseln sich danach ein paar Mal ab, weil manche Schritte den anderen Mac brauchen (Tailscale, Syncthing, die Schlüssel für den agent-bus). Dein Agent sagt dir jeweils, wann du am anderen Mac weitermachen sollst. Auf jedem Mac:

1. macOS einrichten wie oben, dann im Terminal `xcode-select --install`.
2. Claude Code installieren: `curl -fsSL https://claude.ai/install.sh | bash`, dann `claude` starten und einloggen.
3. Diesen Prompt geben (beim Arbeits-Mac „main“ statt „host“ und `~/code/orch-kit` statt `~/orch`):

   > Clone https://github.com/cf-lucas-moskau/orch to ~/orch, then read ~/orch/docs/replicate/AGENT-SETUP.md and follow it. This Mac is the host.

Der Agent führt ein Protokoll in `~/agent-setup-log.md` und macht nach einer Unterbrechung dort weiter. `kit/check.sh host` (bzw. `main`) zeigt jederzeit, was schon steht.

## Was in diesem Ordner liegt

| Datei | Für wen | Inhalt |
| --- | --- | --- |
| `README.md` | dich | diese Übersicht |
| `AGENT-SETUP.md` | deinen Agent | alle Schritte in Reihenfolge, jeweils mit Prüfbefehl |
| `PLAYBOOKS.md` | euch beide | Coding-Worker und lose Themen, einmal durchgespielt |
| `templates/` | den Agent | `CLAUDE.md` (deine globalen Regeln), `local.md` für orch, Syncthing-Ignore für `~/.claude` |
| `kit/agent-bus/` | den Agent | die Mailbox zwischen den Macs: `bus`, Watcher, Setup, Skill |
| `kit/host-services.sh`, `kit/remote-control/` | den Agent | herdr und Remote Control per launchd, damit der Host nach einem Neustart von selbst hochkommt |
| `kit/pstack.sh` | den Agent | pstack und pstack-team-kit aus Lucas' öffentlichem Claude-Port |
| `kit/claude-settings.sh`, `kit/statusline.sh` | den Agent | Auto-Modus, Remote Control, Push-Mitteilungen und Statuszeile für unbeaufsichtigte Agents |
| `kit/media-relay/` | den Agent | Screenshots vom Arbeits-Mac in Host-Sessions, Bilder der Agents zurück auf den Arbeits-Mac |
| `kit/image-gen/` | den Agent | Bildgenerierung über Gemini |
| `kit/deck-to-pdf.mjs` | den Agent | Präsentation zu PDF, unsichtbar im Hintergrund |
| `kit/check.sh` | beide | Statusprüfung, ändert nichts |
| `INVENTORY.md` | Lucas, den Agent | jedes Teil von Lucas' Setup und ob es im Kit ist, Lucas-spezifisch oder bewusst weggelassen |

## Was bewusst fehlt

Teile von orch sind auf Lucas zugeschnitten und bleiben bei dir aus: die Evrloot-Discord-Bridge, die Leads, der Zugriff auf Lucas' Outlook-Mail und Kalender (M365) und die Evrloot-Deploys. Deine `local.md` sagt orch das. Kopiert wurden außerdem keine Schlüssel, Tokens, Kundendaten, Notizen oder Memory-Einträge von Lucas; alles Persönliche ist eine Vorlage mit Platzhaltern, die dein Agent mit deinen Angaben füllt.

## Gut zu wissen

Der Auto-Modus und die Hooks gelten auch auf deinem Arbeits-Mac, weil `~/.claude/settings.json` über Syncthing auf beiden Macs dieselbe ist. Das ist gewollt: Eine Einstellung pro Person ist einfacher als zwei, die auseinanderlaufen, und auch die agent-bus-Sessions auf dem Arbeits-Mac laufen unbeaufsichtigt. Im Auto-Modus prüft ein Klassifizierer jede Aktion, statt dich zu fragen. Die Hooks tun auf dem Arbeits-Mac nichts: orchs Feed-Hook findet dort kein `~/orch`, der Bilder-Hook keine Sender-Markierung, und der Screenshot-Hook reagiert nur auf den Temp-Pfad eines Screenshots vom anderen Mac, nie auf eigene.

FileVault und „immer an“ vertragen sich nur halb: Nach einem Stromausfall wartet der Host am FileVault-Bildschirm auf dein Passwort. Ein MacBook als Host überbrückt kurze Ausfälle mit dem Akku. Geplante Neustarts machst du mit `sudo fdesetup authrestart` (auch per SSH vom Arbeits-Mac), dann starten herdr und Remote Control von selbst.

Nach jedem Neustart des Hosts gibt es einen Handgriff für dich: dich mit herdr verbinden (`herdr --remote <host>` vom Arbeits-Mac) oder den orch-Pane per Remote Control öffnen. herdr stellt orch dann wieder her. Danach sagst du orch `restore`; es schaltet seinen Watcher wieder scharf und nimmt die unterbrochenen Sessions wieder auf. So macht es Lucas auch.

orch tut nie von sich aus etwas nach außen: kein Push, kein Merge, kein PR-Kommentar, kein Deploy, keine Mail. Das kommt immer als Entscheidung zu dir, bis du es in `local.md` ausdrücklich freischaltest.
