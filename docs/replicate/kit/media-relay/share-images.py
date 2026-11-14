#!/usr/bin/env python3
"""PostToolUse hook (Read): copy images agents open on the agent host into ~/AgentImages.

The user follows host sessions from the main Mac, where host paths don't exist.
Syncthing mirrors ~/AgentImages to main at the same path, so the copy's path opens
on both Macs. Runs only where ~/.config/agent-images/sender exists (the host);
this file syncs to main with ~/.claude and does nothing there.

A copy is named <name>-<first 10 hex of its sha256><ext>: the same image always lands
on the same path, two different images never share one, and parallel workers cannot
overwrite each other (the copy is written to a private temp file, then hard-linked into
place, which fails instead of replacing). Copies older than 14 days go, checked at most
once an hour.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

HOME = os.path.expanduser("~")
SHARED = os.environ.get("AGENT_IMAGES_DIR", os.path.join(HOME, "AgentImages"))
MARKER = os.environ.get("AGENT_IMAGES_MARKER", os.path.join(HOME, ".config/agent-images/sender"))
# Paths that already exist on the main Mac.
VISIBLE = [SHARED, os.path.join(HOME, "Screenshots"), os.path.join(HOME, "agent-bus"), os.path.join(HOME, "AgentOutbox")]
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tiff", ".pdf", ".svg"}
KEEP_DAYS = 14
PRUNE_EVERY_S = 3600


def prune():
    stamp = os.path.join(SHARED, ".pruned")
    try:
        if time.time() - os.path.getmtime(stamp) < PRUNE_EVERY_S:
            return
    except OSError:
        pass
    with open(stamp, "a"):
        os.utime(stamp)
    cutoff = time.time() - KEEP_DAYS * 86400
    for f in os.listdir(SHARED):
        p = os.path.join(SHARED, f)
        try:
            if not f.startswith(".") and os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:10]


def share(src):
    base, ext = os.path.splitext(os.path.basename(src))
    dest = os.path.join(SHARED, f"{base}-{digest(src)}{ext}")
    if not os.path.exists(dest):
        fd, tmp = tempfile.mkstemp(prefix=".part-", dir=SHARED)
        try:
            with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
                shutil.copyfileobj(inp, out)
            shutil.copystat(src, tmp)
            try:
                os.link(tmp, dest)
            except FileExistsError:
                pass  # another worker placed the same image first
        finally:
            os.unlink(tmp)
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
    ignore = os.path.join(SHARED, ".stignore")
    if not os.path.exists(ignore):
        with open(ignore, "w") as f:
            f.write(".part-*\n.pruned\n")
    dest = share(src)
    prune()
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": f"The user follows this session from the main Mac, where {src} does not exist. "
                             f"A synced copy is at {dest}, which opens there. Whenever you show or mention "
                             f"this image to the user, give that path.",
    }}))


main()
