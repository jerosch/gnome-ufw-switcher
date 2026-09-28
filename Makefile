# gnome-ufw-switcher — Build & Installation
#
# make install-user   → Extension nach ~/.local/share/gnome-shell/extensions (kein root)
# make install-daemon → Daemon + D-Bus + Polkit (einmalig, sudo nötig)
# make install        → beides + Extension aktivieren
# make enable / disable / uninstall

UUID       := ufw-switcher@jerosch.github.io
VERSION    := 1.0.0
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DAEMON_DIR := /usr/lib/gnome-ufw-switcher

DBUS_SYSTEM_SERVICES := /usr/share/dbus-1/system-services
DBUS_SYSTEM_D        := /usr/share/dbus-1/system.d
POLKIT_ACTIONS       := /usr/share/polkit-1/actions
SYSTEMD_SYSTEM       := /usr/lib/systemd/system
APPLICATIONS       := $(HOME)/.local/share/applications

.PHONY: all build package install install-user install-daemon enable disable uninstall clean

all: build

build:
	rm -rf build
	mkdir -p build/schemas
	cp metadata.json build/
	cp src/extension.js src/prefs.js src/stylesheet.css build/
	cp schemas/*.gschema.xml build/schemas/
	glib-compile-schemas build/schemas/
	python3 po/generate.py
	cp -r locale build/

# extensions.gnome.org expects the extension files at the root of the zip
package: build
	rm -f $(UUID).v$(VERSION).shell-extension.zip
	cd build && zip -qr ../$(UUID).v$(VERSION).shell-extension.zip \
		metadata.json extension.js prefs.js stylesheet.css schemas locale
	@echo "Release-Paket: $(UUID).v$(VERSION).shell-extension.zip"

install-user: build
	install -d "$(EXT_DIR)"
	cp -r build/. "$(EXT_DIR)/"
	install -d "$(APPLICATIONS)"
	sed 's/@UUID@/$(UUID)/g' dist/ufw-switcher-prefs.desktop.in > "$(APPLICATIONS)/ufw-switcher-prefs.desktop"
	@echo "Extension installiert nach $(EXT_DIR)"

install-daemon:
	install -d $(DAEMON_DIR)
	install -m 0755 daemon/ufw_switcherd.py $(DAEMON_DIR)/ufw_switcherd.py
	install -m 0644 daemon/org.gnome.UfwSwitcher.conf   $(DBUS_SYSTEM_D)/
	install -m 0644 daemon/org.gnome.ufw-switcher.policy $(POLKIT_ACTIONS)/
	install -m 0644 daemon/gnome-ufw-switcherd.service $(SYSTEMD_SYSTEM)/
	# D-Bus-Aktivierung entfernen (durch systemd-Unit ersetzt)
	rm -f $(DBUS_SYSTEM_SERVICES)/org.gnome.UfwSwitcher.service
	-pkill -f ufw_switcherd.py 2>/dev/null || true
	systemctl daemon-reload
	systemctl enable --now gnome-ufw-switcherd.service
	systemctl reload dbus.service 2>/dev/null || true
	@echo "Daemon installiert. Test: dbus-send --system --print-reply --dest=org.gnome.UfwSwitcher /org/gnome/UfwSwitcher org.gnome.UfwSwitcher.GetStatus"

install: install-daemon install-user
	gnome-extensions enable $(UUID) || true
	@echo "Fertig. Abmelden/Anmelden oder Shell-Neustart kann nötig sein, falls die Erweiterung nicht erscheint."

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID) || true

uninstall:
	gnome-extensions disable $(UUID) 2>/dev/null || true
	rm -rf "$(EXT_DIR)"
	rm -f "$(APPLICATIONS)/ufw-switcher-prefs.desktop"
	@echo "Extension entfernt. Daemon-Dateien (root) ggf. manuell löschen:"
	@echo "  sudo systemctl disable --now gnome-ufw-switcherd.service"
	@echo "  sudo rm -rf $(DAEMON_DIR) /usr/lib/systemd/system/gnome-ufw-switcherd.service $(DBUS_SYSTEM_D)/org.gnome.UfwSwitcher.conf $(POLKIT_ACTIONS)/org.gnome.ufw-switcher.policy"

clean:
	rm -rf build
