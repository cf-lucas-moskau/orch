#!/usr/bin/env python3
"""UserPromptSubmit hook: map media paths pasted from the main Mac to their Syncthing copy.

Dragging a screenshot from the main Mac into a herdr pane of the agent host pastes a
main-Mac path, usually a /var/folders/.../NSIRD_screencaptureui_* temp file. The main
Mac saves screenshots to ~/Screenshots, which Syncthing mirrors to the host, so the
same file name is looked up there.

Only two kinds of path count as pasted, and never one inside a URL:
- another user session's temp folder (/var/folders, outside this Mac's own $TMPDIR):
  the hook waits up to REMOTE_PATHS_WAIT seconds for the synced copy, and says so when
  none arrives;
- a path under the home folder (same user name on both Macs): looked up once, no wait,
  and silent when there is no copy, because it may be a file the prompt asks to create.
Anything else (/tmp/report.pdf, https://x.com/a.png) is left alone.
"""
import json
import os
import re
import sys
import time

SYNC_DIR = os.environ.get("REMOTE_PATHS_DIR", os.path.expanduser("~/Screenshots"))
WAIT_S = float(os.environ.get("REMOTE_PATHS_WAIT", "20"))
HOME = os.environ.get("REMOTE_PATHS_HOME", os.path.expanduser("~"))
TMP_ROOT = os.environ.get("REMOTE_PATHS_TMPDIR", os.environ.get("TMPDIR", ""))
MEDIA = {".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".tiff", ".pdf", ".mov", ".mp4"}
# A bare path starts a token: not after a word character, ':', '/', '.', '~' or '@', so URL paths never match.
PATH_RE = re.compile(r"""'(/[^']+)'|"(/[^"]+)"|(?<![\w:/.~@-])(/(?:\\.|[^\s'"\\])+)""")


def own_temp(path):
    # $TMPDIR is /var/folders/<xx>/<hash>/T/; its parent is this user's session folder.
    root = os.path.dirname(os.path.dirname(TMP_ROOT.rstrip("/"))) if TMP_ROOT else ""
    return bool(root) and path.startswith(root + "/")


def pasted_paths(prompt):
    """(path, wait) for each candidate: wait is True for another Mac's temp file."""
    for quoted1, quoted2, bare in PATH_RE.findall(prompt):
        path = quoted1 or quoted2 or re.sub(r"\\(.)", r"\1", bare).rstrip(".,;:)")
        if "://" in path or os.path.splitext(path)[1].lower() not in MEDIA or os.path.exists(path):
            continue
        if path.startswith(HOME.rstrip("/") + "/"):
            yield path, False
        elif path.startswith(("/var/folders/", "/private/var/folders/")) and not own_temp(path):
            yield path, True


def resolve(candidates):
    pending = {p: os.path.join(SYNC_DIR, os.path.basename(p)) for p in candidates}
    found = {}
    deadline = time.monotonic() + (WAIT_S if any(candidates.values()) else 0)
    while True:
        for p, local in list(pending.items()):
            if os.path.exists(local):
                found[p] = pending.pop(p)
        if not pending or time.monotonic() >= deadline:
            return found, [p for p in pending if candidates[p]]
        time.sleep(0.2)


def main():
    prompt = json.load(sys.stdin).get("prompt", "")
    found, missing = resolve(dict(pasted_paths(prompt)))
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
