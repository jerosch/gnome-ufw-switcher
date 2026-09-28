import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {bindtextdomain, dgettext} from 'gettext';

const DBUS_NAME = 'org.gnome.UfwSwitcher';
const DBUS_PATH = '/org/gnome/UfwSwitcher';
const DBUS_IFACE = 'org.gnome.UfwSwitcher';
const DOMAIN = 'ufw-switcher@schneiderr.dev';

function _(msgid) {
    return dgettext(DOMAIN, msgid);
}

const MODES = [
    {id: 'home', label: 'Home', icon: 'user-home-symbolic'},
    {id: 'office', label: 'Office', icon: 'network-server-symbolic'},
    {id: 'public', label: 'Public', icon: 'network-workgroup-symbolic'},
];

// [value, msgid] — translated at display time
const ACTIONS = [
    ['allow', 'Allow'],
    ['deny', 'Deny'],
    ['reject', 'Reject'],
];
const DIRECTIONS = [
    ['in', 'Inbound'],
    ['out', 'Outgoing'],
];
const PROTOS = [
    ['', 'Any'],
    ['tcp', 'TCP'],
    ['udp', 'UDP'],
];
const POLICY_IN = [
    ['deny', 'deny (block)'],
    ['allow', 'allow'],
    ['reject', 'reject'],
];
const POLICY_OUT = [
    ['allow', 'allow'],
    ['deny', 'deny (block)'],
];

// --- Helpers ---------------------------------------------------------------

function combo(entries, value) {
    const row = new Adw.ComboRow({
        model: new Gtk.StringList({strings: entries.map(e => _(e[1]))}),
    });
    const idx = entries.findIndex(e => e[0] === value);
    row.selected = Math.max(0, idx);
    row._entries = entries;
    return row;
}

function comboVal(row) {
    return row._entries[row.selected][0];
}

function loadProfile(settings, mode) {
    try {
        const p = JSON.parse(settings.get_string(`profile-${mode}`));
        if (!p.defaults)
            p.defaults = {incoming: 'deny', outgoing: 'allow'};
        if (!Array.isArray(p.rules))
            p.rules = [];
        return p;
    } catch (e) {
        return {defaults: {incoming: 'deny', outgoing: 'allow'}, rules: []};
    }
}

function saveProfile(settings, mode, profile) {
    settings.set_string(`profile-${mode}`, JSON.stringify(profile));
}

function formatRule(r) {
    const act = {allow: 'Allow', deny: 'Deny', reject: 'Reject'}[r.action] ?? r.action;
    const parts = [act, r.direction === 'out' ? _('Outgoing') : _('Inbound')];
    if (r.interface)
        parts.push(_('on %s').format(r.interface));
    if (r.from)
        parts.push(_('from %s').format(r.from));
    if (r.to)
        parts.push(_('to %s').format(r.to));
    if (r.proto)
        parts.push(r.proto.toUpperCase());
    if (r.port)
        parts.push(_('port %s').format(r.port));
    return parts.join(' · ');
}

// --- Rule dialog -------------------------------------------------------------

const RuleDialog = GObject.registerClass(
class RuleDialog extends Adw.Dialog {
    _init({existing = null, onSave}) {
        super._init({
            title: existing ? _('Edit Rule') : _('New Rule'),
            contentWidth: 480,
            contentHeight: 520,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();

        const cancel = new Gtk.Button({label: _('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        const save = new Gtk.Button({
            label: _('Save'),
            css_classes: ['suggested-action'],
        });
        save.connect('clicked', () => {
            onSave(this._collect());
            this.close();
        });
        header.pack_end(save);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();

        const g1 = new Adw.PreferencesGroup();
        this._action = combo(ACTIONS, existing?.action ?? 'allow');
        this._direction = combo(DIRECTIONS, existing?.direction ?? 'in');
        this._proto = combo(PROTOS, existing?.proto ?? '');
        g1.add(this._action);
        g1.add(this._direction);
        g1.add(this._proto);
        page.add(g1);

        const g2 = new Adw.PreferencesGroup({title: _('Addresses and Ports (optional)')});
        this._iface = new Adw.EntryRow({
            title: _('Interface'),
            text: existing?.interface ?? '',
        });
        this._from = new Adw.EntryRow({
            title: _('Source (from)'),
            text: existing?.from ?? '',
        });
        this._to = new Adw.EntryRow({
            title: _('Destination (to)'),
            text: existing?.to ?? '',
        });
        this._port = new Adw.EntryRow({
            title: _('Port'),
            text: existing?.port ?? '',
        });
        g2.add(this._iface);
        g2.add(this._from);
        g2.add(this._to);
        g2.add(this._port);
        page.add(g2);

        const g3 = new Adw.PreferencesGroup();
        this._comment = new Adw.EntryRow({
            title: _('Comment'),
            text: existing?.comment ?? '',
        });
        g3.add(this._comment);
        page.add(g3);

        toolbar.content = page;
        this.set_content(toolbar);
    }

    _collect() {
        return {
            action: comboVal(this._action),
            direction: comboVal(this._direction),
            interface: this._iface.text.trim(),
            from: this._from.text.trim(),
            to: this._to.text.trim(),
            proto: comboVal(this._proto),
            port: this._port.text.trim(),
            comment: this._comment.text.trim(),
        };
    }
});

// --- Main window ---------------------------------------------------------------

export default class UfwSwitcherPrefs {
    constructor(metadata) {
        this.metadata = metadata;

        // The schema lives in the extension directory and is not known to
        // the prefs process automatically — load it explicitly. Same for
        // the gettext locale directory.
        const schemaId = metadata['settings-schema'];
        const extDir = metadata.dir;
        const schemaDir = extDir?.get_child('schemas');
        let schema = null;
        if (schemaDir) {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir.get_path(), Gio.SettingsSchemaSource.get_default(), false);
            schema = source.lookup(schemaId, false);
        }
        if (!schema)
            throw new Error(`GSettings schema ${schemaId} not found`);
        this._settings = new Gio.Settings({settings_schema: schema});

        const localeDir = extDir?.get_child('locale');
        if (localeDir?.query_exists(null))
            bindtextdomain(DOMAIN, localeDir.get_path());
    }

    fillPreferencesWindow(window) {
        const settings = this._settings;
        window.set_default_size(640, 720);

        // --- DBus proxy ---
        let proxy = null;
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            DBUS_NAME, DBUS_PATH, DBUS_IFACE, null,
            (src, res) => {
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    refreshStatus();
                } catch (e) {
                    logError(e, 'UFW Switcher prefs: daemon unreachable');
                }
            });

        function dbusCall(method, params) {
            return new Promise((resolve, reject) => {
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

        function toast(msg, error = false) {
            const t = new Adw.Toast({
                title: msg,
                timeout: error ? 6 : 3,
            });
            window.add_toast(t);
        }

        // --- General page ---
        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'security-high-symbolic',
        });

        const fwGroup = new Adw.PreferencesGroup({title: _('Firewall')});

        let syncing = false;

        const enabledRow = new Adw.SwitchRow({
            title: _('Firewall active'),
            active: settings.get_boolean('enabled'),
        });
        enabledRow.connect('notify::active', () => {
            if (syncing)
                return;
            const want = enabledRow.active;
            dbusCall('SetEnabled', new GLib.Variant('(b)', [want]))
                .then(() => {
                    settings.set_boolean('enabled', want);
                    refreshStatus();
                })
                .catch(e => {
                    syncing = true;
                    enabledRow.active = !want;
                    syncing = false;
                    toast(want
                        ? _('Could not enable firewall: %s').format(e.message)
                        : _('Could not disable firewall: %s').format(e.message), true);
                });
        });
        fwGroup.add(enabledRow);

        const modeRow = combo(
            MODES.map(m => [m.id, m.label]),
            settings.get_string('mode'));
        modeRow.title = _('Active Profile');
        modeRow.connect('notify::selected-item', () => {
            if (syncing)
                return;
            const id = comboVal(modeRow);
            if (id === settings.get_string('mode'))
                return;
            applyProfile(id);
        });
        fwGroup.add(modeRow);

        const statusRow = new Adw.ActionRow({
            title: _('Status (ufw)'),
            subtitle: '—',
        });
        fwGroup.add(statusRow);

        if (GLib.find_program_in_path('gufw')) {
            const gufwRow = new Adw.ActionRow({
                title: _('Open gufw'),
                subtitle: _('Edit complex individual rules externally (note: applying a profile will overwrite foreign rules)'),
            });
            const gufwBtn = new Gtk.Button({
                label: _('Launch'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            gufwBtn.connect('clicked', () => {
                try {
                    Gio.Subprocess.new(['gufw'], Gio.SubprocessFlags.NONE);
                } catch (e) {
                    toast(_('Could not launch gufw: %s').format(e.message), true);
                }
            });
            gufwRow.add_suffix(gufwBtn);
            fwGroup.add(gufwRow);
        }

        generalPage.add(fwGroup);

        const hintGroup = new Adw.PreferencesGroup();
        hintGroup.add(new Adw.ActionRow({
            subtitle: _('Rule changes on the profile pages only take effect via “Apply Profile”. Every firewall change requires PolicyKit authorization.'),
        }));
        generalPage.add(hintGroup);

        function refreshStatus() {
            dbusCall('GetStatus', null)
                .then(res => {
                    const [json] = res.deep_unpack();
                    const st = JSON.parse(json);
                    statusRow.subtitle = st.enabled
                        ? _('Active (%s)').format(st.raw)
                        : _('Inactive');
                    syncing = true;
                    enabledRow.active = st.enabled;
                    syncing = false;
                })
                .catch(e => {
                    statusRow.subtitle = _('Unreachable: %s').format(e.message);
                });
        }

        function applyProfile(modeId) {
            const profile = loadProfile(settings, modeId);
            profile.enabled = enabledRow.active;
            dbusCall('ApplyProfile', new GLib.Variant('(s)', [JSON.stringify(profile)]))
                .then(() => {
                    settings.set_string('mode', modeId);
                    settings.set_boolean('enabled', profile.enabled);
                    const label = MODES.find(m => m.id === modeId)?.label ?? modeId;
                    toast(_('Profile “%s” applied').format(_(label)));
                    refreshStatus();
                })
                .catch(e => {
                    toast(_('Apply failed: %s').format(e.message), true);
                    refreshStatus();
                });
        }

        settings.connect('changed::mode', () => {
            syncing = true;
            modeRow.selected = Math.max(0,
                MODES.findIndex(m => m.id === settings.get_string('mode')));
            syncing = false;
        });

        window.add(generalPage);

        // --- Profile pages ---
        for (const mode of MODES) {
            const page = new Adw.PreferencesPage({
                title: _(mode.label),
                icon_name: mode.icon,
            });

            const profile = loadProfile(settings, mode.id);

            const defaultsGroup = new Adw.PreferencesGroup({
                title: _('Default Policies'),
            });
            const inCombo = combo(POLICY_IN, profile.defaults.incoming);
            inCombo.title = _('Incoming');
            inCombo.connect('notify::selected-item', () => {
                const p = loadProfile(settings, mode.id);
                p.defaults.incoming = comboVal(inCombo);
                saveProfile(settings, mode.id, p);
            });
            const outCombo = combo(POLICY_OUT, profile.defaults.outgoing);
            outCombo.title = _('Outgoing');
            outCombo.connect('notify::selected-item', () => {
                const p = loadProfile(settings, mode.id);
                p.defaults.outgoing = comboVal(outCombo);
                saveProfile(settings, mode.id, p);
            });
            defaultsGroup.add(inCombo);
            defaultsGroup.add(outCombo);
            page.add(defaultsGroup);

            const rulesGroup = new Adw.PreferencesGroup({title: _('Rules')});
            const addButton = new Gtk.Button({
                label: _('Add Rule'),
                halign: Gtk.Align.END,
                css_classes: ['pill'],
            });
            addButton.add_css_class('flat');
            rulesGroup.header_suffix = addButton;
            page.add(rulesGroup);

            function rebuildRules() {
                const p = loadProfile(settings, mode.id);
                const toRemove = [];
                let child = rulesGroup.get_first_child();
                while (child) {
                    if (child instanceof Adw.ActionRow)
                        toRemove.push(child);
                    child = child.get_next_sibling();
                }
                for (const row of toRemove)
                    rulesGroup.remove(row);

                p.rules.forEach((rule, index) => {
                    const row = new Adw.ActionRow({
                        title: formatRule(rule),
                        subtitle: rule.comment || null,
                    });

                    const editBtn = new Gtk.Button({
                        icon_name: 'document-edit-symbolic',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat', 'circular'],
                    });
                    editBtn.connect('clicked', () => {
                        new RuleDialog({
                            existing: rule,
                            onSave: newRule => {
                                const pp = loadProfile(settings, mode.id);
                                pp.rules[index] = newRule;
                                saveProfile(settings, mode.id, pp);
                                rebuildRules();
                            },
                        }).present(window);
                    });
                    row.add_suffix(editBtn);

                    const delBtn = new Gtk.Button({
                        icon_name: 'user-trash-symbolic',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat', 'circular', 'destructive-action'],
                    });
                    delBtn.connect('clicked', () => {
                        const pp = loadProfile(settings, mode.id);
                        pp.rules.splice(index, 1);
                        saveProfile(settings, mode.id, pp);
                        rebuildRules();
                    });
                    row.add_suffix(delBtn);

                    rulesGroup.add(row);
                });
            }
            rebuildRules();

            addButton.connect('clicked', () => {
                new RuleDialog({
                    existing: null,
                    onSave: newRule => {
                        const pp = loadProfile(settings, mode.id);
                        pp.rules.push(newRule);
                        saveProfile(settings, mode.id, pp);
                        rebuildRules();
                    },
                }).present(window);
            });

            const applyGroup = new Adw.PreferencesGroup();
            const applyBtn = new Gtk.Button({
                label: _('Apply “%s” Profile Now').format(_(mode.label)),
                halign: Gtk.Align.CENTER,
                css_classes: ['suggested-action', 'pill'],
            });
            applyBtn.connect('clicked', () => applyProfile(mode.id));
            applyGroup.add(applyBtn);
            page.add(applyGroup);

            window.add(page);
        }

        refreshStatus();
    }
}
