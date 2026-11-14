#!/usr/bin/env python3
"""UserPromptSubmit hook: map media paths pasted from the main Mac to their Syncthing copy.

Dragging a screenshot from the main Mac into a herdr pane of the agent host pastes a
main-Mac path (often a /var/folders/.../NSIRD_screencaptureui_* temp file). The main
Mac saves screenshots to ~/Screenshots, which Syncthing mirrors to the host, so the
same file name is looked up there. Does nothing when no pasted media path is missing.
"""
import json
import os
import re
import sys
import time

SYNC_DIR = os.environ.get("REMOTE_PATHS_DIR", os.path.expanduser("~/Screenshots"))
WAIT_S = float(os.environ.get("REMOTE_PATHS_WAIT", "20"))
MEDIA = {".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".tiff", ".pdf", ".mov", ".mp4"}
PATH_RE = re.compile(r"""'(/[^']+)'|"(/[^"]+)"|(/(?:\\.|[^\s'"\\])+)""")


def pasted_paths(prompt):
    for quoted1, quoted2, bare in PATH_RE.findall(prompt):
        path = quoted1 or quoted2 or re.sub(r"\\(.)", r"\1", bare).rstrip(".,;:)")
        if os.path.splitext(path)[1].lower() in MEDIA and not os.path.exists(path):
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
    prompt = json.load(sys.stdin).get("prompt", "")
    found, missing = resolve(dict.fromkeys(pasted_paths(prompt)))
    lines = [
        f"Pasted path {p} is on the user's main Mac. The synced copy here is {local}. Read that file instead."
        for p, local in found.items()
    ] + [
        f"Pasted path {p} is on the user's main Mac and no synced copy named {os.path.basename(p)} "
        f"reached {SYNC_DIR}. Tell the user instead of guessing."
        for p in missing
    ]
    if lines:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n".join(lines),
        }}))


main()
