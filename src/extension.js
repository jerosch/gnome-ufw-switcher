import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    SystemIndicator,
    QuickMenuToggle,
} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const DBUS_NAME = 'org.gnome.UfwSwitcher';
const DBUS_PATH = '/org/gnome/UfwSwitcher';
const DBUS_IFACE = 'org.gnome.UfwSwitcher';

const MODES = [
    {id: 'home', label: 'Zuhause', icon: 'user-home-symbolic'},
    {id: 'office', label: 'Büro', icon: 'network-server-symbolic'},
    {id: 'public', label: 'Öffentlich', icon: 'network-workgroup-symbolic'},
];

function modeInfo(id) {
    return MODES.find(m => m.id === id) ?? MODES[0];
}

const FirewallIndicator = GObject.registerClass(
class FirewallIndicator extends SystemIndicator {
    _init(extension) {
        super._init();

        this._extension = extension;
        this._settings = extension.getSettings();
        this._busy = false;
        this._destroyed = false;
        this._status = {enabled: false, raw: ''};
        this._timerId = 0;

        // Panel-Icon
        this._panelIcon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'security-high-symbolic',
        });
        this.add_child(this._panelIcon);
        this.visible = true;

        // Quick-Settings-Toggle: Klick = Firewall ein/aus,
        // Menü-Pfeil = Profilwahl
        this._toggle = new QuickMenuToggle({
            toggle_mode: true,
            title: 'Firewall',
            icon_name: 'security-high-symbolic',
        });
        this.quickSettingsItems.push(this._toggle);

        this._buildMenu();

        this._toggle.connect('clicked', () => this._onToggle());
        this._toggle.menu.connect('open-state-changed', (menu, opened) => {
            if (opened)
                this.refresh();
        });

        this._settings.connect('changed::mode', () => {
            this._updateUi();
            this._updateChecks();
        });
        this._settings.connect('changed::enabled', () => this._updateUi());
        this._settings.connect('changed::refresh-interval',
            () => this._restartTimer());

        this._restartTimer();
    }

    _buildMenu() {
        const menu = this._toggle.menu;

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        menu.addMenuItem(this._statusItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._modeChecks = {};
        for (const mode of MODES) {
            const item = new PopupMenu.PopupBaseMenuItem();
            item.add_child(new St.Icon({
                icon_name: mode.icon,
                style_class: 'popup-menu-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            item.add_child(new St.Label({
                text: mode.label,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const check = new St.Icon({
                icon_name: 'object-select-symbolic',
                opacity: 0,
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(check);

            item.connect('activate', () => this.setMode(mode.id));
            this._modeChecks[mode.id] = check;
            menu.addMenuItem(item);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const editItem = new PopupMenu.PopupMenuItem('Firewall-Regeln bearbeiten…');
        editItem.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(editItem);

        this._updateChecks();
    }

    // --- DBus -----------------------------------------------------------

    _callAsync(method, params) {
        return new Promise((resolve, reject) => {
            const proxy = this._extension.dbusProxy;
            if (!proxy) {
                reject(new Error('Daemon nicht verbunden'));
                return;
            }
            proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, null,
                (p, res) => {
                    try {
                        resolve(p.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    refresh() {
        this._callAsync('GetStatus', null)
            .then(res => {
                if (this._destroyed)
                    return;
                const [json] = res.deep_unpack();
                this._status = JSON.parse(json);
                this._updateUi();
            })
            .catch(e => {
                if (this._destroyed)
                    return;
                this._status = {enabled: false, raw: ''};
                this._updateUi(`Daemon nicht erreichbar: ${e.message}`);
            });
    }

    // --- Aktionen ---------------------------------------------------------

    _onToggle() {
        if (this._busy)
            return;
        const want = this._toggle.checked;
        this._busy = true;
        this._callAsync('SetEnabled', new GLib.Variant('(b)', [want]))
            .then(() => {
                this._settings.set_boolean('enabled', want);
                this.refresh();
            })
            .catch(e => {
                // Rückgängig machen (z. B. Polkit-Abbruch)
                if (this._toggle && !this._destroyed)
                    this._toggle.checked = !want;
                this._notify('Firewall-Umschalten fehlgeschlagen', e.message);
            })
            .finally(() => {
                this._busy = false;
            });
    }

    setMode(id) {
        if (this._busy)
            return;
        this._busy = true;
        const profile = this._buildProfile(id, true);
        this._callAsync('ApplyProfile', new GLib.Variant('(s)', [profile]))
            .then(() => {
                this._settings.set_string('mode', id);
                // Modus-Auswahl impliziert Schutz: Firewall einschalten
                this._settings.set_boolean('enabled', true);
                this.refresh();
            })
            .catch(e => {
                this._notify(`Profil „${modeInfo(id).label}“ nicht anwendbar`,
                    e.message);
            })
            .finally(() => {
                this._busy = false;
            });
    }

    _buildProfile(id, forceEnabled = false) {
        let profile;
        try {
            profile = JSON.parse(this._settings.get_string(`profile-${id}`));
        } catch (e) {
            profile = {defaults: {incoming: 'deny', outgoing: 'allow'}, rules: []};
        }
        profile.enabled = forceEnabled || this._settings.get_boolean('enabled');
        return JSON.stringify(profile);
    }

    // --- UI ---------------------------------------------------------------

    _updateUi(errorNote = null) {
        if (this._destroyed)
            return;
        const enabled = !!this._status.enabled;
        const mode = modeInfo(this._settings.get_string('mode'));
        const icon = enabled ? 'security-high-symbolic' : 'security-low-symbolic';

        this._toggle.checked = enabled;
        this._toggle.icon_name = icon;
        this._panelIcon.icon_name = icon;

        if (errorNote) {
            this._toggle.subtitle = 'Daemon nicht erreichbar';
            this._statusItem.label.text = errorNote;
        } else {
            this._toggle.subtitle = enabled ? mode.label : 'Deaktiviert';
            this._statusItem.label.text =
                `Status: ${enabled ? 'Aktiv' : 'Inaktiv'} · Profil: ${mode.label}`;
        }
    }

    _updateChecks() {
        const current = this._settings.get_string('mode');
        for (const [id, check] of Object.entries(this._modeChecks))
            check.opacity = id === current ? 255 : 0;
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        const sec = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, sec, () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _notify(title, detail) {
        Main.notify(`UFW Switcher: ${title}`, detail);
    }

    vfunc_destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        // Toggle hängt im Quick-Settings-Grid, nicht in diesem Container —
        // explizit zerstören, sonst leakt er bei jedem Enable/Disable-Zyklus.
        this._toggle?.destroy();
        this._toggle = null;
        super.vfunc_destroy();
    }
});

export default class UfwSwitcherExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.dbusProxy = null;
        this._changedId = 0;
    }

    enable() {
        this._indicator = new FirewallIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
            null,
            DBUS_NAME,
            DBUS_PATH,
            DBUS_IFACE,
            null,
            (source, res) => {
                try {
                    this.dbusProxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    logError(e, 'UFW Switcher: Daemon nicht verbunden');
                    return;
                }
                this._changedId = this.dbusProxy.connect(
                    'g-signal', (proxy, signalName) => {
                        if (signalName === 'Changed')
                            this._indicator?.refresh();
                    });
                this._indicator.refresh();
            });
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;

        if (this._changedId) {
            this.dbusProxy?.disconnect(this._changedId);
            this._changedId = 0;
        }
        this.dbusProxy = null;
    }
}
