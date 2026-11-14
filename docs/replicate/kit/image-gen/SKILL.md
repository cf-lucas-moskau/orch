---
name: image-gen
description: Generate or edit image assets with Google Gemini (Nano Banana Pro / Nano Banana 2). Use whenever an image asset is needed - presentation slide visuals, hero images, illustrations, icons, mockups, photo edits. Also for editing existing images (style transfer, object changes, upscaling a look).
---

# Image asset generation via Gemini

Generates images with the Nano Banana model family through the owner's Gemini API key (stored in `.env` next to this file as `GEMINI_API_KEY=...`, never print it).

## How to generate

```bash
python3 ~/.claude/skills/image-gen/generate.py "PROMPT" -o out.png [--model pro|fast|lite] [--aspect 16:9] [--size 2K] [-i input.png]
```

- Prints the output path on success.
- `-i` (repeatable) switches to edit/reference mode: the prompt describes what to do with the input image(s).
- Save assets next to the artifact that uses them (e.g. the presentation's folder), temp experiments in the scratchpad.

## Model choice

| Flag | Model | Use for |
|------|-------|---------|
| `pro` (default) | gemini-3-pro-image (Nano Banana Pro) | final assets, anything with rendered text, complex scenes |
| `fast` | gemini-3.1-flash-image (Nano Banana 2) | good quality, much faster and cheaper; iteration |
| `lite` | gemini-3.1-flash-lite-image (Nano Banana 2 Lite) | quick drafts, layout placeholders |

Iterate with `fast`, render the final pick with `pro`.

## Prompting rules

- Describe scene, style, lighting, composition and mood in full sentences; the models reward detailed prose over keyword lists.
- Always state the intended use ("hero image for a slide", "small monochrome icon") so scale and detail fit.
- For slide assets: clean, reduced, generous negative space, light background, the brand accent color sparingly, no gradients-and-glow AI look.
- Leave text out of the image unless it is wanted; if text is needed, quote the exact wording in the prompt (Pro renders text reliably).
- Set `--aspect` to the placement (16:9 full-bleed slide, 4:3 split column, 1:1 icon/card). Use `--size 2K` for full-bleed slide backgrounds.

## Workflow

1. Generate to a file.
2. View the result (Read the image) before using or showing it: check it matches the request and has no artifacts.
3. If off, refine the prompt or edit with `-i` instead of regenerating from scratch.
4. Embed in HTML via relative path, or as base64 data URI when the file must be self-contained.

## Failure modes

- HTTP 429: rate/quota hit, wait and retry or drop to `fast`/`lite`.
- "no image in response": usually a safety block; rephrase the prompt.
- The key stays in `.env` in this directory, out of logs, HTML and commits.
