# gnome-ufw-switcher

A GNOME Shell extension (GNOME 50) to control the **ufw** firewall:

- **Quick Settings** (top-right system menu):
  - Toggle: firewall **on/off**
  - Menu (arrow in the toggle): switch profile — **Home / Office / Public**
  - Direct access to rule editing
- **Preferences / rule editor**: profiles with default policies
  (deny/allow/reject) and arbitrary rules (interface, source,
  destination, port, protocol, comment)
- **Secure**: every firewall change goes through a privileged D-Bus
  service with a **PolicyKit** prompt (auth_admin)
- **Translated**: follows the system language (21 languages included)

## Architecture

```
GNOME Shell (extension)          prefs (GTK4/Adw)
        │                              │
        └────── D-Bus (system) ────────┘
                     │
        org.gnome.UfwSwitcher  (ufw_switcherd.py, runs as root in the
                     │         systemd unit gnome-ufw-switcherd.service,
                     ▼         PolicyKit: org.gnome.ufw-switcher.modify)
                  ufw
```

Key properties:

- **Profile = complete state.** Applying a profile rebuilds the ufw
  configuration deterministically (`ufw --force reset` + rules +
  `enable`). Rules created manually via CLI are **overwritten** — the
  profiles in the preferences are the single source of truth.
- Profiles are stored as JSON in GSettings
  (`org.gnome.shell.extensions.ufw-switcher`) and can therefore also be
  scripted via `gsettings`.

## Installation

Requirements: GNOME 50, `ufw`, `glib-compile-schemas`, `gnome-extensions`,
`gettext` (msgfmt, for building translations).

```sh
# 1) Daemon + D-Bus + PolicyKit (one-time, root)
sudo make install-daemon

# 2) Install extension into user directory + enable
make install-user
gnome-extensions enable ufw-switcher@schneiderr.dev
```

The extension ends up in
`~/.local/share/gnome-shell/extensions/ufw-switcher@schneiderr.dev`.

## Usage

### Quick Settings
Top right, system menu → **Firewall** toggle:
- Click the icon: firewall on/off (PolicyKit password prompt)
- Click the arrow: select profile (Home/Office/Public) or
  "Edit Firewall Rules…"

### Editing rules
Via the menu or the **Firewall Rules (UFW)** app (app grid).
Per profile:
- Default policies incoming/outgoing
- Rules: allow/deny/reject, direction, interface, source,
  destination, port, protocol, comment

Rule changes become active via **"Apply Profile Now"**.

## Translations

User-facing strings are English in the source and translated via gettext.
The extension follows the system language automatically.

Included languages (21):
Czech, Danish, Dutch, Finnish, French, German, Greek, Hungarian, Italian,
Japanese, Norwegian Bokmål, Polish, Portuguese (Brazil), Romanian,
Russian, Simplified Chinese, Slovak, Spanish, Swedish, Turkish, Ukrainian.

To add or update a language:

1. Create `po/translations_<lang>.py` with a list `T` of 57 strings in
   the same order as `MSGIDS` in `po/generate.py`
   (see existing files as template).
2. Run `python3 po/generate.py` — writes `po/<lang>.po` and compiles
   `locale/<lang>/LC_MESSAGES/ufw-switcher@schneiderr.dev.mo`.
3. `make install-user`

Contributions welcome.

## Removing the password prompt (optional)

Default: `auth_admin` (password on every change). If you find that
annoying, local active users of the `wheel` group can be allowed to make
changes without a password —
`/usr/share/polkit-1/rules.d/60-ufw-switcher.rules.js`:

```js
polkit.addRule(function (action, subject) {
    if (action.id === "org.gnome.ufw-switcher.modify" &&
        subject.active && subject.local && subject.isInGroup("wheel")) {
        return polkit.Result.YES;
    }
});
```

**Warning:** then any application in your local session can reconfigure
the firewall. Use deliberately.

## Testing the daemon

```sh
dbus-send --system --print-reply \
    --dest=org.gnome.UfwSwitcher /org/gnome/UfwSwitcher \
    org.gnome.UfwSwitcher.GetStatus
```

## Uninstall

```sh
make uninstall
# Root leftovers:
sudo systemctl disable --now gnome-ufw-switcherd.service
sudo rm -rf /usr/lib/gnome-ufw-switcher \
    /usr/lib/systemd/system/gnome-ufw-switcherd.service \
    /usr/share/dbus-1/system.d/org.gnome.UfwSwitcher.conf \
    /usr/share/polkit-1/actions/org.gnome.ufw-switcher.policy
```

## Note on "Settings → Network"

GNOME Settings (`gnome-control-center`) offers **no plugin interface**
for third-party panels. The rule editor is therefore a standalone window
in the Adwaita style, reachable directly from Quick Settings and from
the app grid — functionally the equivalent of a network sub-page.

## License

GPL-2.0-or-later — see [LICENSE](LICENSE).
