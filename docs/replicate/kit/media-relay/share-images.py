#!/usr/bin/env python3
"""PostToolUse hook (Read): copy images agents open on the agent host into ~/AgentImages.

The user follows host sessions from the main Mac, where host paths don't exist.
Syncthing mirrors ~/AgentImages to main at the same path, so the copy's path opens
on both Macs. Runs only where ~/.config/agent-images/sender exists (the host);
this file syncs to main with ~/.claude and does nothing there.
"""
import filecmp
import json
import os
import shutil
import sys
import time

HOME = os.path.expanduser("~")
SHARED = os.environ.get("AGENT_IMAGES_DIR", os.path.join(HOME, "AgentImages"))
MARKER = os.environ.get("AGENT_IMAGES_MARKER", os.path.join(HOME, ".config/agent-images/sender"))
# Paths that already exist on the main Mac.
VISIBLE = [SHARED, os.path.join(HOME, "Screenshots"), os.path.join(HOME, "agent-bus"), os.path.join(HOME, "AgentOutbox")]
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tiff", ".pdf", ".svg"}
KEEP_DAYS = 14


def prune():
    cutoff = time.time() - KEEP_DAYS * 86400
    for f in os.listdir(SHARED):
        p = os.path.join(SHARED, f)
        if not f.startswith(".") and os.path.isfile(p) and os.path.getmtime(p) < cutoff:
            os.remove(p)


def share(src):
    base, ext = os.path.splitext(os.path.basename(src))
    dest, n = os.path.join(SHARED, base + ext), 2
    while os.path.exists(dest) and not filecmp.cmp(src, dest, shallow=False):
        dest, n = os.path.join(SHARED, f"{base}-{n}{ext}"), n + 1
    if not os.path.exists(dest):
        shutil.copy2(src, dest)
    os.utime(dest)
    return dest


def main():
    if not os.path.exists(MARKER):
        return
    data = json.load(sys.stdin)
    src = os.path.realpath(os.path.expanduser((data.get("tool_input") or {}).get("file_path", "")))
    if os.path.splitext(src)[1].lower() not in IMAGES or not os.path.isfile(src):
        return
    if any(src.startswith(os.path.realpath(v) + os.sep) for v in VISIBLE):
        return
    os.makedirs(SHARED, exist_ok=True)
    dest = share(src)
    prune()
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": f"The user follows this session from the main Mac, where {src} does not exist. "
                             f"A synced copy is at {dest}, which opens there. Whenever you show or mention "
                             f"this image to the user, give that path.",
    }}))


main()
