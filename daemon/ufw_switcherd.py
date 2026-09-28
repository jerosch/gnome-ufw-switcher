#!/usr/bin/python3
"""
ufw_switcherd — privilegierter D-Bus-Dienst für die GNOME-Erweiterung
"UFW Switcher" (ufw-switcher@schneiderr.dev).

Stellt die Firewall (ufw) über den System-Bus bereit:
  org.gnome.UfwSwitcher.GetStatus()      -> s   (JSON, keine Auth)
  org.gnome.UfwSwitcher.SetEnabled(b)            (Polkit: modify)
  org.gnome.UfwSwitcher.ApplyProfile(s)          (Polkit: modify)
  org.gnome.UfwSwitcher.Changed(s)       signal

Der Dienst wird per D-Bus-Aktivierung als root gestartet. Schreibende
Methoden erfordern eine Polkit-Autorisierung (Action
org.gnome.ufw-switcher.modify, Standard: auth_admin).
"""

import json
import os
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
gi.require_version("Polkit", "1.0")
from gi.repository import Gio, GLib, Polkit  # noqa: E402

BUS_NAME = "org.gnome.UfwSwitcher"
OBJ_PATH = "/org/gnome/UfwSwitcher"
IFACE = "org.gnome.UfwSwitcher"
POLKIT_ACTION = "org.gnome.ufw-switcher.modify"
UFW_BIN = "/usr/sbin/ufw"

INTROSPECTION = """
<node>
  <interface name="org.gnome.UfwSwitcher">
    <method name="GetStatus">
      <arg name="status" type="s" direction="out"/>
    </method>
    <method name="SetEnabled">
      <arg name="enabled" type="b" direction="in"/>
    </method>
    <method name="ApplyProfile">
      <arg name="profile" type="s" direction="in"/>
    </method>
    <signal name="Changed">
      <arg name="status" type="s"/>
    </signal>
  </interface>
</node>
"""


class Error(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def run_ufw(args):
    """ufw ohne Shell aufrufen; wirft Error bei Fehlschlag."""
    try:
        proc = subprocess.run(
            [UFW_BIN, *args],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Error("org.gnome.UfwSwitcher.UfwFailed", f"ufw nicht ausführbar: {exc}")
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip()
        raise Error(
            "org.gnome.UfwSwitcher.UfwFailed",
            f"ufw {' '.join(args)} fehlgeschlagen: {msg}",
        )
    return proc


def get_status():
    proc = run_ufw(["status"])
    first = proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else ""
    enabled = first.lower().startswith("status: active")
    return {"enabled": enabled, "raw": first}


def _proc_start_time(pid):
    """starttime aus /proc/<pid>/stat (Feld 22, TOCTOU-Absicherung für Polkit)."""
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as f:
        after = f.read().rsplit(")", 1)[1].split()
    return int(after[19])


def check_authorization(conn, invocation):
    """Polkit-Check für den Aufrufer. True wenn autorisiert."""
    sender = invocation.get_sender()
    try:
        res = conn.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixUser",
            GLib.Variant("(s)", (sender,)),
            None,
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
        uid = res.unpack()[0]
        res = conn.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "GetConnectionUnixProcessID",
            GLib.Variant("(s)", (sender,)),
            None,
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )
        pid = res.unpack()[0]
        start_time = _proc_start_time(pid)
        authority = Polkit.Authority.get_sync(None)
        subject = Polkit.UnixProcess.new_for_owner(pid, start_time, uid)
        result = authority.check_authorization_sync(
            subject, POLKIT_ACTION, None,
            Polkit.CheckAuthorizationFlags.ALLOW_USER_INTERACTION, None
        )
        print(
            f"Polkit-Check: sender={sender} pid={pid} uid={uid} "
            f"start={start_time} -> authorized={result.get_is_authorized()} "
            f"dismissed={result.get_dismissed()} challenge={result.get_is_challenge()}",
            flush=True,
        )
        return result.get_is_authorized()
    except (GLib.Error, OSError, ValueError) as exc:
        print(f"Polkit-Prüfung fehlgeschlagen/abgebrochen: {exc}", flush=True)
        return False


def apply_profile(profile_json):
    """Profil (JSON) vollständig auf ufw anwenden.

    ACHTUNG: überschreibt alle bestehenden ufw-Regeln
    (ufw --force reset). Die Profile in den GNOME-Einstellungen sind
    die einzige Quelle der Wahrheit.
    """
    try:
        profile = json.loads(profile_json)
    except (ValueError, TypeError) as exc:
        raise Error("org.gnome.UfwSwitcher.BadProfile", f"Ungültiges Profil-JSON: {exc}")

    defaults = profile.get("defaults", {})
    incoming = defaults.get("incoming", "deny")
    outgoing = defaults.get("outgoing", "allow")
    if incoming not in ("deny", "allow", "reject"):
        raise Error("org.gnome.UfwSwitcher.BadProfile", f"Ungültige eingehende Richtlinie: {incoming}")
    if outgoing not in ("deny", "allow"):
        raise Error("org.gnome.UfwSwitcher.BadProfile", f"Ungültige ausgehende Richtlinie: {outgoing}")

    # Regel-Argumente vorab validieren, damit ein Fehler nicht halb
    # angewendet wird.
    rule_args = []
    for rule in profile.get("rules", []):
        action = rule.get("action", "allow")
        if action not in ("allow", "deny", "reject"):
            raise Error("org.gnome.UfwSwitcher.BadProfile", f"Ungültige Aktion: {action}")
        direction = rule.get("direction", "in")
        if direction not in ("in", "out"):
            raise Error("org.gnome.UfwSwitcher.BadProfile", f"Ungültige Richtung: {direction}")
        proto = rule.get("proto", "")
        if proto not in ("", "tcp", "udp"):
            raise Error("org.gnome.UfwSwitcher.BadProfile", f"Ungültiges Protokoll: {proto}")
        for field in ("interface", "from", "to", "port", "comment"):
            if not isinstance(rule.get(field, ""), str):
                raise Error("org.gnome.UfwSwitcher.BadProfile", f"{field} muss ein String sein")

        # Reihenfolge laut ufw(8):
        # allow|deny|reject [in|out [on IFACE]] [proto P] [from SRC [port P]]
        #                   [to DST [port P]] [comment TEXT]
        args = [action]
        args.append(direction)
        if rule.get("interface"):
            args += ["on", rule["interface"].strip()]
        if proto:
            args += ["proto", proto]
        args += ["from", rule.get("from", "").strip() or "any"]
        if rule.get("port"):
            args += ["port", rule["port"].strip()]
        args += ["to", rule.get("to", "").strip() or "any"]
        comment = rule.get("comment", "").strip()
        if comment:
            args += ["comment", comment]
        rule_args.append(args)

    # Alles zurücksetzen, dann deterministisch neu aufbauen.
    run_ufw(["--force", "reset"])
    run_ufw(["default", incoming, "incoming"])
    run_ufw(["default", outgoing, "outgoing"])
    for args in rule_args:
        run_ufw(args)

    if profile.get("enabled", True):
        run_ufw(["--force", "enable"])
    else:
        run_ufw(["disable"])


class Service:
    def __init__(self):
        self.loop = GLib.MainLoop()
        # Bei D-Bus-Aktivierung gehört der Name dem Starter-Connection —
        # diesen verwenden, nicht eine frische SYSTEM-Verbindung.
        if os.environ.get("DBUS_STARTER_BUS_TYPE") == "system":
            self.conn = Gio.bus_get_sync(Gio.BusType.STARTER, None)
        else:
            self.conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
            # Manueller Start: Name explizit übernehmen
            Gio.bus_own_name(
                Gio.BusType.SYSTEM, BUS_NAME,
                Gio.BusNameOwnerFlags.REPLACE, None, None, None
            )
        node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        self.conn.register_object(
            OBJ_PATH, node.interfaces[0], self._handle_call, None
        )

    def _reply(self, invocation, variant):
        invocation.return_value(variant)

    def _fail(self, invocation, code, message):
        invocation.return_dbus_error(code, message)

    def _emit_changed(self):
        try:
            status = json.dumps(get_status())
            self.conn.emit_signal(None, OBJ_PATH, IFACE, "Changed", GLib.Variant("(s)", (status,)))
        except Error as exc:
            print(f"Status nach Änderung nicht lesbar: {exc}", flush=True)

    def _handle_call(self, conn, sender, path, iface, method, params, invocation):
        try:
            if method == "GetStatus":
                self._reply(
                    invocation,
                    GLib.Variant("(s)", (json.dumps(get_status()),)),
                )
            elif method == "SetEnabled":
                (enabled,) = params.unpack()
                if not check_authorization(conn, invocation):
                    self._fail(
                        invocation,
                        "org.gnome.UfwSwitcher.NotAuthorized",
                        "Autorisierung verweigert oder abgebrochen.",
                    )
                    return
                run_ufw(["--force", "enable"] if enabled else ["disable"])
                self._emit_changed()
                self._reply(invocation, None)
            elif method == "ApplyProfile":
                (profile,) = params.unpack()
                if not check_authorization(conn, invocation):
                    self._fail(
                        invocation,
                        "org.gnome.UfwSwitcher.NotAuthorized",
                        "Autorisierung verweigert oder abgebrochen.",
                    )
                    return
                apply_profile(profile)
                self._emit_changed()
                self._reply(invocation, None)
            else:
                self._fail(
                    invocation,
                    "org.freedesktop.DBus.Error.UnknownMethod",
                    f"Unbekannte Methode: {method}",
                )
        except Error as exc:
            self._fail(invocation, exc.code, str(exc))
        except Exception as exc:  # noqa: BLE001
            self._fail(invocation, "org.gnome.UfwSwitcher.InternalError", str(exc))

    def run(self):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, self.loop.quit)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 2, self.loop.quit)
        self.loop.run()


def main():
    try:
        service = Service()
    except GLib.Error as exc:
        print(f"Kann D-Bus-Namen nicht registrieren: {exc.message}", file=sys.stderr)
        return 1
    service.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
