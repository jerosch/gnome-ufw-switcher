import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

const DBUS_NAME = 'org.gnome.UfwSwitcher';
const DBUS_PATH = '/org/gnome/UfwSwitcher';
const DBUS_IFACE = 'org.gnome.UfwSwitcher';

const MODES = [
    {id: 'home', label: 'Zuhause', icon: 'user-home-symbolic'},
    {id: 'office', label: 'Büro', icon: 'network-server-symbolic'},
    {id: 'public', label: 'Öffentlich', icon: 'network-workgroup-symbolic'},
];

const ACTIONS = [
    ['allow', 'Allow — erlauben'],
    ['deny', 'Deny — blockieren'],
    ['reject', 'Reject — ablehnen'],
];
const DIRECTIONS = [
    ['in', 'Eingehend'],
    ['out', 'Ausgehend'],
];
const PROTOS = [
    ['', 'Beliebig'],
    ['tcp', 'TCP'],
    ['udp', 'UDP'],
];
const POLICY_IN = [
    ['deny', 'deny — blockieren'],
    ['allow', 'allow — erlauben'],
    ['reject', 'reject — ablehnen'],
];
const POLICY_OUT = [
    ['allow', 'allow — erlauben'],
    ['deny', 'deny — blockieren'],
];

// --- Hilfsfunktionen -----------------------------------------------------

function combo(entries, value) {
    const row = new Adw.ComboRow({
        model: new Gtk.StringList({strings: entries.map(e => e[1])}),
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
    const parts = [act, r.direction === 'out' ? 'ausgehend' : 'eingehend'];
    if (r.interface)
        parts.push(`auf ${r.interface}`);
    if (r.from)
        parts.push(`von ${r.from}`);
    if (r.to)
        parts.push(`nach ${r.to}`);
    if (r.proto)
        parts.push(r.proto.toUpperCase());
    if (r.port)
        parts.push(`Port ${r.port}`);
    return parts.join(' · ');
}

// --- Regel-Dialog ----------------------------------------------------------

const RuleDialog = GObject.registerClass(
class RuleDialog extends Adw.Dialog {
    _init({existing = null, onSave}) {
        super._init({
            title: existing ? 'Regel bearbeiten' : 'Neue Regel',
            contentWidth: 480,
            contentHeight: 520,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();

        const cancel = new Gtk.Button({label: 'Abbrechen'});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        const save = new Gtk.Button({
            label: 'Speichern',
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

        const g2 = new Adw.PreferencesGroup({title: 'Adressen und Ports (optional)'});
        this._iface = new Adw.EntryRow({
            title: 'Interface',
            text: existing?.interface ?? '',
        });
        this._from = new Adw.EntryRow({
            title: 'Quelle (from)',
            text: existing?.from ?? '',
        });
        this._to = new Adw.EntryRow({
            title: 'Ziel (to)',
            text: existing?.to ?? '',
        });
        this._port = new Adw.EntryRow({
            title: 'Port',
            text: existing?.port ?? '',
        });
        g2.add(this._iface);
        g2.add(this._from);
        g2.add(this._to);
        g2.add(this._port);
        page.add(g2);

        const g3 = new Adw.PreferencesGroup();
        this._comment = new Adw.EntryRow({
            title: 'Kommentar',
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

// --- Hauptsseite -----------------------------------------------------------

export default class UfwSwitcherPrefs {
    constructor(metadata) {
        this.metadata = metadata;

        // Schema liegt im Extension-Verzeichnis (gschemas.compiled) und ist
        // dem prefs-Prozess nicht automatisch bekannt — explizit laden.
        const schemaId = metadata['settings-schema'];
        const schemaDir = metadata.dir?.get_child('schemas');
        let schema = null;
        if (schemaDir) {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir.get_path(), Gio.SettingsSchemaSource.get_default(), false);
            schema = source.lookup(schemaId, false);
        }
        if (!schema)
            throw new Error(`GSettings-Schema ${schemaId} nicht gefunden`);
        this._settings = new Gio.Settings({settings_schema: schema});
    }

    fillPreferencesWindow(window) {
        const settings = this._settings;
        window.set_default_size(640, 720);

    // --- DBus-Proxy ---
    let proxy = null;
    Gio.DBusProxy.new_for_bus(
        Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
        DBUS_NAME, DBUS_PATH, DBUS_IFACE, null,
        (src, res) => {
            try {
                proxy = Gio.DBusProxy.new_for_bus_finish(res);
                refreshStatus();
            } catch (e) {
                logError(e, 'UFW Switcher prefs: Daemon nicht erreichbar');
            }
        });

    function dbusCall(method, params) {
        return new Promise((resolve, reject) => {
            if (!proxy) {
                reject(new Error('Daemon nicht verbunden — bitte kurz warten'));
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

    // --- Seite: Allgemein ---
    const generalPage = new Adw.PreferencesPage({
        title: 'Allgemein',
        icon_name: 'security-high-symbolic',
    });

    const fwGroup = new Adw.PreferencesGroup({title: 'Firewall'});

    let syncing = false;

    const enabledRow = new Adw.SwitchRow({
        title: 'Firewall aktiv',
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
                toast(`Konnte Firewall nicht ${want ? 'aktivieren' : 'deaktivieren'}: ${e.message}`, true);
            });
    });
    fwGroup.add(enabledRow);

    const modeRow = combo(
        MODES.map(m => [m.id, m.label]),
        settings.get_string('mode'));
    modeRow.title = 'Aktives Profil';
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
        title: 'Status (ufw)',
        subtitle: '—',
    });
    fwGroup.add(statusRow);

    if (GLib.find_program_in_path('gufw')) {
        const gufwRow = new Adw.ActionRow({
            title: 'gufw öffnen',
            subtitle: 'Komplexe Einzelregeln extern bearbeiten (Achtung: beim nächsten Profilanwenden werden fremde Regeln überschrieben)',
        });
        const gufwBtn = new Gtk.Button({
            label: 'Starten',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        gufwBtn.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['gufw'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                toast(`gufw konnte nicht gestartet werden: ${e.message}`, true);
            }
        });
        gufwRow.add_suffix(gufwBtn);
        fwGroup.add(gufwRow);
    }

    generalPage.add(fwGroup);

    const hintGroup = new Adw.PreferencesGroup();
    hintGroup.add(new Adw.ActionRow({
        subtitle: 'Regel-Änderungen auf den Profil-Seiten werden erst über „Profil anwenden“ wirksam. Jede Änderung an der Firewall erfordert eine Polkit-Autorisierung.',
    }));
    generalPage.add(hintGroup);

    function refreshStatus() {
        dbusCall('GetStatus', null)
            .then(res => {
                const [json] = res.deep_unpack();
                const st = JSON.parse(json);
                statusRow.subtitle = st.enabled
                    ? `Aktiv (${st.raw})`
                    : 'Inaktiv';
                syncing = true;
                enabledRow.active = st.enabled;
                syncing = false;
            })
            .catch(e => {
                statusRow.subtitle = `Nicht erreichbar: ${e.message}`;
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
                toast(`Profil „${label}“ angewendet`);
                refreshStatus();
            })
            .catch(e => {
                toast(`Anwenden fehlgeschlagen: ${e.message}`, true);
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

    // --- Seiten: Profile ---
    for (const mode of MODES) {
        const page = new Adw.PreferencesPage({
            title: mode.label,
            icon_name: mode.icon,
        });

        const profile = loadProfile(settings, mode.id);

        const defaultsGroup = new Adw.PreferencesGroup({
            title: 'Standard-Richtlinien',
        });
        const inCombo = combo(POLICY_IN, profile.defaults.incoming);
        inCombo.title = 'Eingehend';
        inCombo.connect('notify::selected-item', () => {
            const p = loadProfile(settings, mode.id);
            p.defaults.incoming = comboVal(inCombo);
            saveProfile(settings, mode.id, p);
        });
        const outCombo = combo(POLICY_OUT, profile.defaults.outgoing);
        outCombo.title = 'Ausgehend';
        outCombo.connect('notify::selected-item', () => {
            const p = loadProfile(settings, mode.id);
            p.defaults.outgoing = comboVal(outCombo);
            saveProfile(settings, mode.id, p);
        });
        defaultsGroup.add(inCombo);
        defaultsGroup.add(outCombo);
        page.add(defaultsGroup);

        const rulesGroup = new Adw.PreferencesGroup({title: 'Regeln'});
        const addButton = new Gtk.Button({
            label: 'Regel hinzufügen',
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
            label: `Profil „${mode.label}“ jetzt anwenden`,
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
