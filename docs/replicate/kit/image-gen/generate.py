#!/usr/bin/env python3
"""Generate or edit image assets via the Gemini image models (Nano Banana family).

Usage:
  python3 generate.py "prompt" -o out.png
  python3 generate.py "prompt" -o out.png --model fast --aspect 16:9 --size 2K
  python3 generate.py "make the sky red" -o out.png -i input.png   # edit mode

Models:
  pro  -> gemini-3-pro-image        (Nano Banana Pro, best quality, default)
  fast -> gemini-3.1-flash-image    (Nano Banana 2, near-pro, much faster)
  lite -> gemini-3.1-flash-lite-image (Nano Banana 2 Lite, drafts)

API key: GEMINI_API_KEY env var, or .env next to this script.
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.request

MODELS = {
    "pro": "gemini-3-pro-image",
    "fast": "gemini-3.1-flash-image",
    "lite": "gemini-3.1-flash-lite-image",
}


def load_key():
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit("error: GEMINI_API_KEY not set and no .env found")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("prompt")
    p.add_argument("-o", "--out", required=True, help="output file (.png)")
    p.add_argument("--model", default="pro", help="pro | fast | lite | full model name")
    p.add_argument("--aspect", default=None, help="e.g. 1:1, 16:9, 4:3, 9:16, 21:9")
    p.add_argument("--size", default=None, help="1K, 2K or 4K (pro only)")
    p.add_argument("-i", "--input", action="append", default=[],
                   help="input image(s) for editing/reference, repeatable")
    args = p.parse_args()

    model = MODELS.get(args.model, args.model)
    key = load_key()

    parts = [{"text": args.prompt}]
    for path in args.input:
        mime = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as f:
            parts.append({"inline_data": {
                "mime_type": mime,
                "data": base64.b64encode(f.read()).decode(),
            }})

    image_config = {}
    if args.aspect:
        image_config["aspectRatio"] = args.aspect
    if args.size:
        image_config["imageSize"] = args.size

    gen_config = {"responseModalities": ["TEXT", "IMAGE"]}
    if image_config:
        gen_config["imageConfig"] = image_config

    body = json.dumps({
        "contents": [{"parts": parts}],
        "generationConfig": gen_config,
    }).encode()

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-goog-api-key": key,
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"error: HTTP {e.code}: {e.read().decode()[:2000]}")

    for part in data.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        blob = part.get("inlineData") or part.get("inline_data")
        if blob:
            with open(args.out, "wb") as f:
                f.write(base64.b64decode(blob["data"]))
            print(args.out)
            return
    sys.exit("error: no image in response: " + json.dumps(data)[:2000])


if __name__ == "__main__":
    main()
