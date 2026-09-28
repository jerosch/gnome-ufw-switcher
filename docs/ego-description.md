# Description for extensions.gnome.org upload form

**UFW Switcher** controls the ufw firewall from GNOME Quick Settings: toggle it on/off and switch between location profiles (Home, Office, Public), with a full rule editor in Preferences. Translated into 21 languages.

**Note:** Firewall changes are routed over D-Bus to a small PolicyKit-guarded helper service (`org.gnome.UfwSwitcher`). Per extensions.gnome.org packaging rules the helper is not part of this zip — install it once from the [GitHub release](https://github.com/jerosch/gnome-ufw-switcher/releases) (versioned daemon tarball with `daemon-install.sh`) or from the repository via `sudo make install-daemon`. Without the helper the toggle reports "Daemon unreachable".

Every firewall change requires an explicit PolicyKit authorization. GPL-2.0-or-later.
