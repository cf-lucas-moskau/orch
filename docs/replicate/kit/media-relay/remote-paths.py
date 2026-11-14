#!/usr/bin/env python3
"""UserPromptSubmit hook: map a screenshot dragged in from the main Mac to its Syncthing copy.

Dragging a screenshot's floating thumbnail from the main Mac into a herdr pane of the agent
host pastes macOS's temp path for it:
    /var/folders/<xx>/<id>/T/TemporaryItems/NSIRD_screencaptureui_<id>/<name>.png
The main Mac's screenshot catcher copies the file to ~/Screenshots, which Syncthing mirrors
to the host, so the same file name is looked up there.

That exact pattern is the only thing this hook acts on. A path whose NSIRD folder exists on
this Mac is this Mac's own screenshot and left alone. Every other path, URL or output target
is ignored, so nothing else ever waits.
"""
import json
import os
import re
import sys
import time

SYNC_DIR = os.environ.get("REMOTE_PATHS_DIR", os.path.expanduser("~/Screenshots"))
WAIT_S = float(os.environ.get("REMOTE_PATHS_WAIT", "20"))
# Paths as a terminal pastes them, the same parsing as the hook this one is based on: '...', "..." or bare
# with backslash-escaped spaces. A bare path also keeps U+202F (narrow no-break space, in English macOS
# screenshot names), which \s would otherwise end it at.
PATH_RE = re.compile(r"""'(/[^']+)'|"(/[^"]+)"|(/(?:\\.| |[^\s'"\\])+)""")
# The only paths acted on: a file directly inside a screenshot's temp folder.
SHOT = re.compile(r"(?:/private)?/var/folders/[^/]+/[^/]+/T/TemporaryItems/NSIRD_screencaptureui_[^/]+/[^/]+")


def pasted_shots(prompt):
    for quoted1, quoted2, bare in PATH_RE.findall(prompt):
        path = quoted1 or quoted2 or re.sub(r"\\(.)", r"\1", bare).rstrip(".,;:)")
        if SHOT.fullmatch(path) and not os.path.exists(path) and not os.path.isdir(os.path.dirname(path)):
            yield path


def resolve(paths):
    pending = {p: os.path.join(SYNC_DIR, os.path.basename(p)) for p in paths}
    found = {}
    deadline = time.monotonic() + WAIT_S
    while True:
        for p, local in list(pending.items()):
            if os.path.exists(local):
                found[p] = pending.pop(p)
        if not pending or time.monotonic() >= deadline:
            return found, list(pending)
        time.sleep(0.2)


def main():
    shots = list(dict.fromkeys(pasted_shots(json.load(sys.stdin).get("prompt", ""))))
    if not shots:
        return
    found, missing = resolve(shots)
    lines = [
        f"Pasted path {p} is a screenshot on the user's main Mac. The synced copy here is {local}. Read that file instead."
        for p, local in found.items()
    ] + [
        f"Pasted path {p} is a screenshot on the user's main Mac and no synced copy named {os.path.basename(p)} "
        f"reached {SYNC_DIR}. Tell the user instead of guessing."
        for p in missing
    ]
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "\n".join(lines),
    }}))


main()
