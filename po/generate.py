#!/usr/bin/env python3
"""Generate .po files and compiled .mo catalogs for all supported languages.

Usage: python3 po/generate.py
Writes: po/<lang>.po and locale/<lang>/LC_MESSAGES/ufw-switcher@schneiderr.dev.mo
"""
import os
import subprocess
import sys

DOMAIN = "ufw-switcher@schneiderr.dev"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PO_DIR = os.path.join(ROOT, "po")
LOCALE_DIR = os.path.join(ROOT, "locale")

# Master msgid list — must match the strings used in src/*.js
MSGIDS = [
    "Firewall",
    "Home",
    "Office",
    "Public",
    "Edit Firewall Rules…",
    "Daemon not connected — please wait a moment",
    "Daemon unreachable: %s",
    "Failed to toggle firewall",
    "Cannot apply profile “%s”",
    "Daemon unreachable",
    "Disabled",
    "Status: %s · Profile: %s",
    "Active",
    "Inactive",
    "Allow",
    "Deny",
    "Reject",
    "Inbound",
    "Outgoing",
    "Any",
    "deny (block)",
    "allow",
    "reject",
    "on %s",
    "from %s",
    "to %s",
    "port %s",
    "Edit Rule",
    "New Rule",
    "Cancel",
    "Save",
    "Addresses and Ports (optional)",
    "Interface",
    "Source (from)",
    "Destination (to)",
    "Port",
    "Comment",
    "General",
    "Firewall active",
    "Active Profile",
    "Status (ufw)",
    "Open gufw",
    "Edit complex individual rules externally (note: applying a profile will overwrite foreign rules)",
    "Launch",
    "Could not launch gufw: %s",
    "Rule changes on the profile pages only take effect via “Apply Profile”. Every firewall change requires PolicyKit authorization.",
    "Could not enable firewall: %s",
    "Could not disable firewall: %s",
    "Active (%s)",
    "Unreachable: %s",
    "Profile “%s” applied",
    "Apply failed: %s",
    "Default Policies",
    "Incoming",
    "Rules",
    "Add Rule",
    "Apply “%s” Profile Now",
]

TRANSLATIONS = {}  # filled by po/translations_<lang>.py modules


def load_translations():
    sys.path.insert(0, PO_DIR)
    for fname in sorted(os.listdir(PO_DIR)):
        if fname.startswith("translations_") and fname.endswith(".py"):
            lang = fname[len("translations_"):-len(".py")]
            mod = __import__(fname[:-3])
            t = mod.T
            if isinstance(t, list):
                if len(t) != len(MSGIDS):
                    raise SystemExit(
                        f"{fname}: {len(t)} translations but {len(MSGIDS)} msgids")
                t = dict(zip(MSGIDS, t))
            TRANSLATIONS[lang] = t


def po_escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')


def write_po(lang, msgs):
    lines = [
        "msgid \"\"",
        "msgstr \"\"",
        "\"Project-Id-Version: gnome-ufw-switcher 1.0\\n\"",
        "\"MIME-Version: 1.0\\n\"",
        f"\"Language: {lang}\\n\"",
        "\"Content-Type: text/plain; charset=UTF-8\\n\"",
        "\"Content-Transfer-Encoding: 8bit\\n\"",
        "",
    ]
    for msgid in MSGIDS:
        lines.append(f"msgid \"{po_escape(msgid)}\"")
        trans = msgs.get(msgid, "")
        lines.append(f"msgstr \"{po_escape(trans)}\"")
        lines.append("")
    path = os.path.join(PO_DIR, f"{lang}.po")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def compile_mo(lang, po_path):
    out = os.path.join(LOCALE_DIR, lang, "LC_MESSAGES", f"{DOMAIN}.mo")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    subprocess.run(["msgfmt", po_path, "-o", out], check=True)
    return out


def main():
    load_translations()
    total = 0
    for lang, msgs in TRANSLATIONS.items():
        missing = [m for m in MSGIDS if not msgs.get(m)]
        if missing:
            print(f"  {lang}: {len(missing)} missing translation(s) — skipped entries")
        po = write_po(lang, msgs)
        mo = compile_mo(lang, po)
        total += 1
        print(f"  {lang}: {len(msgs)}/{len(MSGIDS)} strings → {os.path.relpath(mo, ROOT)}")
    print(f"Done: {total} languages compiled.")


if __name__ == "__main__":
    main()
