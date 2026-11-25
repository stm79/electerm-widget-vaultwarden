# Vaultwarden für electerm

Holt Benutzer und Passwort für SSH-, RDP- und Telnet-Lesezeichen aus Vaultwarden (oder Bitwarden).
Im Lesezeichen steht dann kein Passwort mehr, nur noch „Passwort-Manager verwenden“.

Das Widget spricht nicht selbst mit dem Server, sondern über die offizielle Bitwarden-CLI `bw`.
Die übernimmt Anmeldung, Verschlüsselung und Abgleich.

## Voraussetzungen

- **electerm 5.9 oder neuer.** Ab dieser Version gibt es die Passwort-Manager-Schnittstelle für Widgets.
- **Bitwarden-CLI `bw`:**
  - Windows: `winget install Bitwarden.CLI`, danach electerm neu starten, damit `bw` im PATH ist.
  - Linux: die einzelne Datei herunterladen, nicht das Snap-Paket (siehe unten).
  - Liegt `bw` woanders, gibst du den Pfad im Feld „Bitwarden-CLI“ an.

### Linux

`bw` installieren:

```
cd /tmp
curl -L -o bw.zip "https://vault.bitwarden.com/download/?app=cli&platform=linux"
unzip bw.zip && chmod +x bw
mkdir -p ~/.local/bin && mv bw ~/.local/bin/
~/.local/bin/bw --version
```

Alternativ: `npm install -g @bitwarden/cli`.

Darauf solltest du achten:

- **Kein Snap:** Snap-Programme dürfen nicht in versteckte Ordner im Home schreiben. Das Widget legt die
  Daten der CLI aber in `~/.electerm-vaultwarden/bw/` ab.
- **Vollen Pfad eintragen:** Aus dem Startmenü oder als AppImage gestartet, kennt electerm oft dein PATH
  nicht. Trag im Feld „Bitwarden-CLI“ den vollen Pfad ein, z. B. `/home/<du>/.local/bin/bw`.

## Installieren

electerm (ab 5.9) → Widgets → **Importieren** → `stm79/electerm-widget-vaultwarden` eingeben.

Alternativ einen lokalen Ordner mit diesem Inhalt importieren.
Für ein Update: erneut importieren und das Überschreiben bestätigen.

## Einrichten

1. Widget **Vaultwarden** öffnen.
2. Server (z. B. `https://vault.example.com`), E-Mail und Master-Passwort eintragen.
3. **Entsperren / suchen** drücken.

Zur Zwei-Faktor-Anmeldung:

- Hat das Konto Zwei-Faktor-Anmeldung mit einer Authenticator-App, gib beim ersten Mal den Code mit ein.
- Einfacher ist der API-Schlüssel:
  - Du findest ihn in Vaultwarden unter Einstellungen → Sicherheit → Schlüssel → API-Schlüssel anzeigen.
  - Mit `client_id` und `client_secret` braucht die Anmeldung keinen 2FA-Code und keine Bestätigung als neues Gerät.
  - Das Master-Passwort ist trotzdem nötig, zum Entsperren.

Nach dem Entsperren zeigt das Widget, wie viele Logins es kennt.

Der Sitzungsschlüssel liegt nur im Arbeitsspeicher. Nach jedem Start von electerm entsperrst du deshalb
einmal im Widget mit dem Master-Passwort, auch wenn du den API-Schlüssel nutzt.

## Lesezeichen

Im Lesezeichen (SSH, RDP, Telnet, …):

- **Passwort-Manager verwenden** einschalten.
- Das Passwortfeld leer lassen.

Beim Verbinden sucht das Widget den passenden Eintrag über die **URI** des Eintrags. Diese URIs passen:

| URI im Vaultwarden-Eintrag | passt zu |
|---|---|
| `ssh://server:22`, `ssh://server` | SSH auf `server`, Port 22 |
| `server:2222` | jedes Protokoll auf `server`, Port 2222 |
| `server` | jedes Protokoll auf `server` |
| `rdp://10.0.0.5` | RDP auf `10.0.0.5` |

So entscheidet das Widget:

- **Ein passender Eintrag:** Er wird direkt genommen.
- **Mehrere passende Einträge:**
  - Steht im Lesezeichen ein Benutzer, nimmt das Widget den Eintrag mit diesem Benutzer.
  - Sonst fragt electerm, welcher Eintrag es sein soll.
- **Nur über den Namen oder eine `https://`-URI auf denselben Host gefunden:** Der Eintrag wird nur zur
  Auswahl angeboten, nie automatisch genommen. Das ist meistens das Web-Login.
- **Nichts gefunden:** Es kommt die normale Passwortabfrage. Hat die Anmeldung geklappt, bietet electerm an,
  den Login als neuen Eintrag zu speichern (URI z. B. `ssh://server:22`, Notiz „Angelegt von electerm“).
- **Gespeichertes Passwort stimmt nicht mehr:** Du tippst das neue ein. Danach bietet electerm an, den
  Eintrag zu aktualisieren.

Die Liste der Einträge gleicht das Widget höchstens alle 10 Minuten mit dem Server ab, beim Entsperren und
beim Klick auf „Synchronisieren“ sofort. Ohne Netz arbeitet es mit der lokalen Kopie der CLI.

## Suchen im Widget

Unter **Suche** kannst du nach Name, Benutzer oder Adresse suchen. Zu jedem Treffer:

- **SSH** / **RDP** öffnet die Verbindung direkt.
- **Passwort kopieren** legt das Passwort in die Zwischenablage. Nach 30 Sekunden wird es dort wieder gelöscht.
- **Details** zeigt den Eintrag; das Passwort ist verdeckt.

**Sperren** sperrt den Tresor und löscht den Sitzungsschlüssel.

## Was wo liegt

- **Master-Passwort und `client_secret`:**
  - Werden nie gespeichert.
  - Gehen nur als Umgebungsvariable an `bw`, nie als Befehlszeilenargument.
- **`~/.electerm-vaultwarden/bw/`:** Daten der CLI (der verschlüsselte Tresor). Das ist ein eigener Ordner,
  eine sonst benutzte `bw`-Anmeldung bleibt unberührt.
- **`~/.electerm-vaultwarden/settings.json`:** Pfad zu `bw`.
- **Sitzungsschlüssel:** nur im Arbeitsspeicher, nie auf der Platte. Eine `session.dat` aus Version 0.1.0
  löscht das Widget beim nächsten Entsperren.
- **Im Speicher von electerm:** die Liste der Einträge ohne Passwörter. Ein Passwort holt das Widget erst,
  wenn eine Verbindung es braucht.
- **Verbindungsverlauf:** Verbindungen, die das Widget öffnet, landen nicht darin. Das regelt electerm selbst.

## Tests

```
node --test test/*.test.js
```

Die Tests laufen gegen eine Attrappe der CLI (`test/fake-bw.js`), nicht gegen einen echten Server.
