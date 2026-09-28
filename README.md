# gnome-ufw-switcher

GNOME-Shell-Erweiterung (GNOME 50) zur Steuerung der **ufw**-Firewall:

- **Quick Settings** (Systemmenü oben rechts):
  - Toggle: Firewall **ein/aus**
  - Menü (Pfeil im Toggle): Profil wechseln — **Zuhause / Büro / Öffentlich**
  - Direktzugriff auf die Regel-Bearbeitung
- **Einstellungen / Regel-Editor**: Profile mit Standard-Richtlinien
  (deny/allow/reject) und beliebigen Regeln (Interface, Quelle, Ziel,
  Port, Protokoll, Kommentar)
- **Sicher**: Jede Änderung an der Firewall läuft über einen privilegierten
  D-Bus-Dienst mit **Polkit-Abfrage** (auth_admin)

## Architektur

```
GNOME Shell (Extension)          prefs (GTK4/Adw)
        │                              │
        └────── D-Bus (System) ────────┘
                     │
        org.gnome.UfwSwitcher  (ufw_switcherd.py, läuft als root in
                     │         systemd-Unit gnome-ufw-switcherd.service,
                     ▼         Polkit: org.gnome.ufw-switcher.modify)
                  ufw
```

Wichtige Eigenschaften:

- **Profil = vollständiger Zustand.** Beim Anwenden eines Profils wird die
  ufw-Konfiguration deterministisch neu aufgebaut
  (`ufw --force reset` + Regeln + `enable`). Manuell per CLI angelegte
  Regeln werden dabei **überschrieben** — die Profile in den Einstellungen
  sind die einzige Quelle der Wahrheit.
- Profile liegen als JSON in GSettings
  (`org.gnome.shell.extensions.ufw-switcher`), sind also auch per
  `gsettings` skriptbar.

## Installation

Voraussetzungen: GNOME 50, `ufw`, `glib-compile-schemas`, `gnome-extensions`.

```sh
# 1) Daemon + D-Bus + Polkit (einmalig, root)
sudo make install-daemon

# 2) Extension ins User-Verzeichnis + aktivieren
make install-user
gnome-extensions enable ufw-switcher@schneiderr.dev
```

Die Extension liegt danach unter
`~/.local/share/gnome-shell/extensions/ufw-switcher@schneiderr.dev`.

## Verwendung

### Quick Settings
Oben rechts auf das Systemmenü → **Firewall**-Toggle:
- Klick auf das Icon: Firewall ein/aus (Polkit-Passwortabfrage)
- Klick auf den Pfeil: Profil auswählen (Zuhause/Büro/Öffentlich) oder
  „Firewall-Regeln bearbeiten…“

### Regeln bearbeiten
Über das Menü oder die App **Firewall-Regeln (UFW)** (App-Grid).
Pro Profil einstellbar:
- Standard-Richtlinien eingehend/ausgehend
- Regeln: allow/deny/reject, Richtung, Interface, Quelle, Ziel,
  Port, Protokoll, Kommentar

Regel-Änderungen werden über **„Profil jetzt anwenden“** aktiv.

## Passwortabfrage entschärfen (optional)

Standard: `auth_admin` (Passwort bei jeder Änderung). Wer das als
nervig empfindet, kann lokalen aktiven Nutzern der Gruppe `wheel`
änderungen ohne Passwort erlauben —
`/usr/share/polkit-1/rules.d/60-ufw-switcher.rules.js`:

```js
polkit.addRule(function (action, subject) {
    if (action.id === "org.gnome.ufw-switcher.modify" &&
        subject.active && subject.local && subject.isInGroup("wheel")) {
        return polkit.Result.YES;
    }
});
```

**Achtung:** Dann kann jede Anwendung in deiner lokalen Sitzung die
Firewall umkonfigurieren. Bewusst einsetzen.

## Testen des Daemons

```sh
sudo dbus-send --system --print-reply \
    --dest=org.gnome.UfwSwitcher /org/gnome/UfwSwitcher \
    org.gnome.UfwSwitcher.GetStatus
```

## Deinstallation

```sh
make uninstall
# Root-Reste:
sudo rm -rf /usr/lib/gnome-ufw-switcher \
    /usr/share/dbus-1/system-services/org.gnome.UfwSwitcher.service \
    /usr/share/dbus-1/system.d/org.gnome.UfwSwitcher.conf \
    /usr/share/polkit-1/actions/org.gnome.ufw-switcher.policy
```

## Hinweis zu „Einstellungen → Netzwerk“

Die GNOME-Einstellungen (`gnome-control-center`) bieten **keine
Plugin-Schnittstelle** für Fremd-Panels. Der Regel-Editor ist deshalb eine
eigene, im Adwaita-Stil gehaltene Fenster-App, die direkt aus den
Quick Settings und aus dem App-Grid erreichbar ist — funktional das
Äquivalent eines Netzwerk-Unterpunkts.

## Lizenz

GPL-2.0-or-later — siehe [LICENSE](LICENSE).
