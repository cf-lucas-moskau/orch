#!/usr/bin/env python3
"""Generate or edit image assets with Codex's built-in image_gen tool (ChatGPT plan, no cost per image).

Usage:
  python3 generate.py "prompt" -o out.png
  python3 generate.py "prompt" -o out.png --aspect 16:9 --size 2K
  python3 generate.py "make the sky red" -o out.png -i input.png   # edit mode

Codex returns about 1254 px squares and takes no size; --aspect goes into the prompt, and --size/--aspect scale
the result to fixed pixels (1:1 at 1K is 1024 x 1024, 2K and 4K twice and 4 times).
--model is accepted for old callers and ignored. Codex only, no paid image API.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile

AT_1K = {"1:1": (1024, 1024), "2:3": (848, 1264), "3:2": (1264, 848), "3:4": (896, 1200), "4:3": (1200, 896),
         "4:5": (928, 1152), "5:4": (1152, 928), "9:16": (768, 1376), "16:9": (1376, 768), "21:9": (1584, 672)}


def critique(out):
    """Lucas, 2026-11-14: every generated image in a repo with an art critic passes it by default.
    Runs tools/art/critic/critic.ts when the output lands inside such a repo (evrloot-next).
    EVR_CRITIC=off skips it, only for tools that run the critic themselves (candidates.ts)."""
    if os.environ.get("EVR_CRITIC", "").lower() == "off":
        return
    d = os.path.dirname(os.path.abspath(out))
    try:
        root = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        return
    critic = os.path.join(root, "tools/art/critic/critic.ts") if root else ""
    if not critic or not os.path.exists(critic):
        return
    print(f"critic: checking {out} (EVR_CRITIC=off skips)", file=sys.stderr)
    r = subprocess.run(["node", critic, os.path.abspath(out)], cwd=root)
    if r.returncode != 0:
        sys.exit(f"critic: REJECT or error for {out} (exit {r.returncode}); see its .critic.md. Fix or regenerate, never ship it.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("prompt")
    p.add_argument("-o", "--out", required=True, help="output file (.png or .jpg)")
    p.add_argument("--model", default=None, help="ignored (Codex only)")
    p.add_argument("--aspect", default=None, help="1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9")
    p.add_argument("--size", default=None, help="1K, 2K or 4K: scale the result to that size")
    p.add_argument("-i", "--input", action="append", default=[], help="input image(s) for editing/reference, repeatable")
    args = p.parse_args()
    if args.aspect and args.aspect not in AT_1K:
        sys.exit(f"error: --aspect {args.aspect}: one of {', '.join(AT_1K)}")
    if args.size and args.size.upper() not in ("1K", "2K", "4K"):
        sys.exit("error: --size 1K, 2K or 4K")
    if not shutil.which("codex"):
        sys.exit("error: codex CLI not found (npm i -g @openai/codex, then codex login)")
    inputs = [os.path.abspath(i) for i in args.input]
    for i in inputs:
        if not os.path.exists(i):
            sys.exit(f"error: input {i} not found")

    aspect = args.aspect or "1:1"
    what = "an edit of the first attached image (the others are references)" if inputs else "a new image"
    prompt = (f"Use your built-in image generation tool (no code, no drawing script, no other image tool) to make exactly "
              f"one image: {what}, aspect ratio {aspect}, at the highest resolution the tool offers. Save it as out.png in "
              f"the current directory and reply with its path only. The image: {args.prompt}")
    cmd = ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-s", "workspace-write"]
    for i in inputs:
        cmd += ["-i", i]
    cmd.append("-")

    tmp = tempfile.mkdtemp(prefix="image-gen-")
    try:
        try:
            r = subprocess.run(cmd, cwd=tmp, input=prompt, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired:
            sys.exit("error: codex took over 10 minutes; retry")
        got = os.path.join(tmp, "out.png")
        if not os.path.exists(got):
            sys.exit(f"error: no image from codex (exit {r.returncode}): {(r.stderr or r.stdout)[-1500:]}")
        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        sips = ["sips"]
        if args.size or args.aspect:
            w, h = AT_1K[aspect]
            k = {"1K": 1, "2K": 2, "4K": 4}[(args.size or "1K").upper()]
            sips += ["-z", str(h * k), str(w * k)]
        if out.lower().endswith((".jpg", ".jpeg")):
            sips += ["-s", "format", "jpeg"]
        if len(sips) > 1:
            s = subprocess.run(sips + [got, "--out", out], capture_output=True, text=True)
            if s.returncode != 0:
                sys.exit(f"error: sips failed: {s.stderr[-500:]}")
        else:
            shutil.copyfile(got, out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(args.out)
    critique(args.out)


if __name__ == "__main__":
    main()
