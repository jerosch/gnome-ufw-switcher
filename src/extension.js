import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    SystemIndicator,
    QuickMenuToggle,
} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const DBUS_NAME = 'org.gnome.UfwSwitcher';
const DBUS_PATH = '/org/gnome/UfwSwitcher';
const DBUS_IFACE = 'org.gnome.UfwSwitcher';

// Last evaluated network. Module-level so it survives enable/disable
// cycles: GNOME re-enables every extension on each screen unlock, and
// the same network must not notify again after an unlock.
let lastNetworkKey = null;

const MODES = [
    {id: 'home', label: 'Home', icon: 'user-home-symbolic'},
    {id: 'office', label: 'Office', icon: 'network-server-symbolic'},
    {id: 'public', label: 'Public', icon: 'network-workgroup-symbolic'},
];

function modeInfo(id) {
    return MODES.find(m => m.id === id) ?? MODES[0];
}

const FirewallIndicator = GObject.registerClass(
class FirewallIndicator extends SystemIndicator {
    _init(extension, settings) {
        super._init();

        this._extension = extension;
        this._settings = settings;
        this._busy = false;
        this._destroyed = false;
        this._status = {enabled: false, raw: ''};

        // Panel icon
        this._panelIcon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'security-high-symbolic',
        });
        this.add_child(this._panelIcon);
        this.visible = true;

        // Quick settings toggle: click = firewall on/off,
        // menu arrow = profile selection
        this._toggle = new QuickMenuToggle({
            toggle_mode: true,
            title: _('Firewall'),
            icon_name: 'security-high-symbolic',
        });
        this.quickSettingsItems.push(this._toggle);

        this._buildMenu();
        this._updateUi();
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
                text: _(mode.label),
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

        const editItem = new PopupMenu.PopupMenuItem(_('Edit Firewall Rules…'));
        editItem.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(editItem);

        this._updateChecks();
    }

    // --- DBus -----------------------------------------------------------

    _callAsync(method, params) {
        return new Promise((resolve, reject) => {
            const proxy = this._extension.dbusProxy;
            if (!proxy) {
                reject(new Error(_('Daemon not connected — please wait a moment')));
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
                this._updateUi(_('Daemon unreachable: %s').format(e.message));
            });
    }

    // --- Actions ----------------------------------------------------------

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
                // Revert (e.g. PolicyKit cancelled)
                if (this._toggle && !this._destroyed)
                    this._toggle.checked = !want;
                this._notify(_('Failed to toggle firewall'), e.message);
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
                // Selecting a mode implies protection: turn firewall on
                this._settings.set_boolean('enabled', true);
                this.refresh();
            })
            .catch(e => {
                this._notify(_('Cannot apply profile “%s”')
                    .format(_(modeInfo(id).label)), e.message);
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
            this._toggle.subtitle = _('Daemon unreachable');
            this._statusItem.label.text = errorNote;
        } else {
            this._toggle.subtitle = enabled
                ? _(mode.label)
                : _('Disabled');
            this._statusItem.label.text = _('Status: %s · Profile: %s').format(
                enabled ? _('Active') : _('Inactive'), _(mode.label));
        }
    }

    _updateChecks() {
        const current = this._settings.get_string('mode');
        for (const [id, check] of Object.entries(this._modeChecks))
            check.opacity = id === current ? 255 : 0;
    }

    _notify(title, detail) {
        Main.notify(`UFW Switcher: ${title}`, detail);
    }

    vfunc_destroy() {
        this._destroyed = true;
        // The toggle lives in the quick settings grid, not in this
        // container — destroy it explicitly or it leaks on every
        // enable/disable cycle.
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
        this._enabled = false;
        this._settings = null;
        this._timerId = 0;
        this._modeChangedId = 0;
        this._enabledChangedId = 0;
        this._refreshChangedId = 0;
        this._toggleClickedId = 0;
        this._menuOpenedId = 0;
        this._autoSwitchSettingId = 0;
        this._nmClient = null;
        this._nmAddedId = 0;
        this._nmRemovedId = 0;
        this._autoSwitchDebounceId = 0;
        this._confirmCheckId = 0;
    }

    enable() {
        this._enabled = true;
        this._settings = this.getSettings();
        this._indicator = new FirewallIndicator(this, this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._modeChangedId = this._settings.connect('changed::mode', () => {
            this._indicator?._updateUi();
            this._indicator?._updateChecks();
        });
        this._enabledChangedId = this._settings.connect('changed::enabled',
            () => this._indicator?._updateUi());
        this._refreshChangedId = this._settings.connect('changed::refresh-interval',
            () => this._restartTimer());
        this._toggleClickedId = this._indicator._toggle.connect('clicked',
            () => this._indicator?._onToggle());
        this._menuOpenedId = this._indicator._toggle.menu.connect(
            'open-state-changed', (menu, opened) => {
                if (opened)
                    this._indicator?.refresh();
            });
        this._restartTimer();

        this._autoSwitchSettingId = this._settings.connect('changed::auto-switch',
            () => this._syncAutoSwitch());
        this._syncAutoSwitch();

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
            null,
            DBUS_NAME,
            DBUS_PATH,
            DBUS_IFACE,
            null,
            (source, res) => {
                // Extension may have been disabled while connecting
                if (!this._enabled)
                    return;
                try {
                    this.dbusProxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch (e) {
                    logError(e, 'UFW Switcher: daemon not connected');
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

    // --- Network auto-switch -------------------------------------------

    _syncAutoSwitch() {
        const want = this._settings.get_boolean('auto-switch');
        if (want && !this._nmClient) {
            this._setupNetworkMonitor().catch(e =>
                logError(e, 'UFW Switcher: network monitor setup failed'));
        } else if (!want) {
            this._teardownNetworkMonitor();
        }
    }

    async _setupNetworkMonitor() {
        let NM;
        try {
            NM = (await import('gi://NM?version=1.0')).default;
        } catch (e) {
            logError(e, 'UFW Switcher: NetworkManager not available');
            return;
        }
        // Extension may have been disabled while importing
        if (!this._enabled || this._nmClient)
            return;
        try {
            this._nmClient = NM.Client.new(null);
        } catch (e) {
            logError(e, 'UFW Switcher: cannot connect to NetworkManager');
            return;
        }
        // NMClient signals: 'active-connection-added'/'-removed' fire when
        // an active connection appears/disappears. (The plain
        // 'connection-added'/'-removed' signals are about saved connection
        // PROFILES, not active connections, and never fire on network
        // switches.)
        this._nmAddedId = this._nmClient.connect('active-connection-added',
            () => this._onNetworkChanged());
        this._nmRemovedId = this._nmClient.connect('active-connection-removed',
            () => this._onNetworkChanged());
        this._onNetworkChanged();
    }

    _teardownNetworkMonitor() {
        if (this._autoSwitchDebounceId) {
            GLib.source_remove(this._autoSwitchDebounceId);
            this._autoSwitchDebounceId = 0;
        }
        if (this._confirmCheckId) {
            GLib.source_remove(this._confirmCheckId);
            this._confirmCheckId = 0;
        }
        if (this._nmClient) {
            this._nmClient.disconnect(this._nmAddedId);
            this._nmClient.disconnect(this._nmRemovedId);
            this._nmClient = null;
        }
        this._nmAddedId = 0;
        this._nmRemovedId = 0;
    }

    // Current primary network: the connection carrying the default route
    // (has an IPv4 gateway). Ties broken by Wi-Fi over wired. VPN and
    // bridges are ignored.
    _currentNetwork() {
        if (!this._nmClient)
            return null;
        const active = this._nmClient.get_active_connections() || [];
        let best = null;
        let bestGw = false;
        let bestWifi = false;
        for (const ac of active) {
            const conn = ac.get_connection();
            if (!conn)
                continue;
            const sConn = conn.get_setting_connection();
            if (!sConn)
                continue;
            const type = sConn.get_connection_type();
            const isWifi = type === '802-11-wireless';
            if (!isWifi && type !== '802-3-ethernet')
                continue;
            let name = sConn.get_id();
            if (isWifi) {
                const sWifi = conn.get_setting_wireless();
                const ssid = sWifi?.get_ssid();
                const bytes = ssid?.get_data();
                if (bytes && bytes.length)
                    name = new TextDecoder().decode(bytes);
            }
            const ip4 = ac.get_ip4_config();
            const hasGw = !!(ip4 && ip4.get_gateway());
            if (!best ||
                (hasGw && !bestGw) ||
                (hasGw === bestGw && isWifi && !bestWifi)) {
                best = {uuid: sConn.get_uuid(), name};
                bestGw = hasGw;
                bestWifi = isWifi;
            }
        }
        return best;
    }

    _onNetworkChanged() {
        if (this._autoSwitchDebounceId)
            GLib.source_remove(this._autoSwitchDebounceId);
        this._autoSwitchDebounceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 2, () => {
                this._autoSwitchDebounceId = 0;
                this._applyNetworkProfile();
                // IP config and gateway can arrive late after DHCP; verify
                // the pick once more shortly after. The network-key guard
                // makes the re-check a no-op when nothing changed.
                if (this._confirmCheckId)
                    GLib.source_remove(this._confirmCheckId);
                this._confirmCheckId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, 6, () => {
                        this._confirmCheckId = 0;
                        this._applyNetworkProfile();
                        return GLib.SOURCE_REMOVE;
                    });
                return GLib.SOURCE_REMOVE;
            });
    }

    _applyNetworkProfile() {
        const net = this._currentNetwork();
        // No network: leave the firewall as it is
        if (!net)
            return;

        let map = {};
        try {
            map = JSON.parse(this._settings.get_string('network-map'));
        } catch (e) {
            map = {};
        }
        const mapped = map[net.uuid];
        const target = mapped ?? 'public';
        const current = this._settings.get_string('mode');
        const isNewNetwork = net.uuid !== lastNetworkKey;
        lastNetworkKey = net.uuid;
        log(`UFW Switcher auto-switch: network="${net.name}" ` +
            `mapped=${mapped ?? 'none'} target=${target} current=${current}`);

        // With auto-switch on, the network mapping is authoritative:
        // a manual override is re-applied on the next network event.
        const switched = target !== current;
        if (switched)
            this._indicator?.setMode(target);
        if (switched || (isNewNetwork && !mapped)) {
            Main.notify('UFW Switcher',
                mapped
                    ? _('Profile switched to %s (network: %s)').format(
                        _(modeInfo(target).label), net.name)
                    : _('Unknown network “%s” — switched to Public. Map it in Preferences.')
                        .format(net.name));
        }
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        const sec = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, sec, () => {
                this._indicator?.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        this._enabled = false;

        if (this._autoSwitchSettingId) {
            this._settings?.disconnect(this._autoSwitchSettingId);
            this._autoSwitchSettingId = 0;
        }
        this._teardownNetworkMonitor();

        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settings) {
            this._settings.disconnect(this._modeChangedId);
            this._settings.disconnect(this._enabledChangedId);
            this._settings.disconnect(this._refreshChangedId);
            this._modeChangedId = 0;
            this._enabledChangedId = 0;
            this._refreshChangedId = 0;
        }
        if (this._indicator) {
            this._indicator._toggle?.disconnect(this._toggleClickedId);
            this._indicator._toggle?.menu?.disconnect(this._menuOpenedId);
            this._toggleClickedId = 0;
            this._menuOpenedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;

        if (this._changedId) {
            this.dbusProxy?.disconnect(this._changedId);
            this._changedId = 0;
        }
        this.dbusProxy = null;
    }
}
