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
SHOT_RE = re.compile(
    r"(?<![\w/])(?:/private)?/var/folders/[^/\s'\"]+/[^/\s'\"]+/T/TemporaryItems/"
    r"NSIRD_screencaptureui_[^/\s'\"]+/(?:\\.|[^/\s'\"\\])+"
)


def pasted_shots(prompt):
    for m in SHOT_RE.findall(prompt):
        path = re.sub(r"\\(.)", r"\1", m).rstrip(".,;:)")
        if not os.path.exists(path) and not os.path.isdir(os.path.dirname(path)):
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
