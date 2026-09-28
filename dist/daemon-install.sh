#!/usr/bin/env bash
# Standalone installer for the UFW Switcher privileged helper daemon.
# Usage: sudo ./daemon-install.sh
#
# Installs the D-Bus helper service, its D-Bus policy, the PolicyKit
# action and the systemd unit. Does not touch the GNOME extension itself.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root: sudo ./daemon-install.sh" >&2
    exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -d /usr/lib/gnome-ufw-switcher
install -m 0755 "$DIR/ufw_switcherd.py" /usr/lib/gnome-ufw-switcher/
install -m 0644 "$DIR/org.gnome.UfwSwitcher.conf" /usr/share/dbus-1/system.d/
install -m 0644 "$DIR/org.gnome.ufw-switcher.policy" /usr/share/polkit-1/actions/
install -m 0644 "$DIR/gnome-ufw-switcherd.service" /usr/lib/systemd/system/

# Remove any legacy D-Bus activation unit (replaced by the systemd unit)
rm -f /usr/share/dbus-1/system-services/org.gnome.UfwSwitcher.service

pkill -f ufw_switcherd.py 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now gnome-ufw-switcherd.service

echo "UFW Switcher helper installed. Verify with:"
echo "  dbus-send --system --print-reply --dest=org.gnome.UfwSwitcher /org/gnome/UfwSwitcher org.gnome.UfwSwitcher.GetStatus"
