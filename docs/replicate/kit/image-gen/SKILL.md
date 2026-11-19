---
name: image-gen
description: Generate or edit image assets with Codex's built-in image tool (ChatGPT plan, no cost per image). Use whenever an image asset is needed - presentation slide visuals, hero images, illustrations, icons, mockups, photo edits, game art. Also for editing existing images (style transfer, object changes, upscaling a look).
---

# Image asset generation via Codex

Every image goes through Codex's built-in `image_gen` tool on the owner's ChatGPT plan: no API key, no cost per image. Codex only, never a paid image API.

## How to generate

```bash
python3 ~/.claude/skills/image-gen/generate.py "PROMPT" -o out.png [--aspect 16:9] [--size 2K] [-i input.png]
```

- Prints the output path on success. Takes about 1 to 2 minutes per image; run several in parallel (background) for candidates.
- `-i` (repeatable) switches to edit/reference mode: the prompt describes what to do with the first input image; further inputs are references.
- `--aspect` goes into the prompt and the result is scaled to it; `--size 1K|2K|4K` scales to that size (Codex itself returns about 1254 px, so 2K and 4K are upscales, not more detail).
- `--model` is ignored (kept so old callers don't break).
- Save assets next to the artifact that uses them (e.g. the presentation's folder), temp experiments in the scratchpad.
- Needs the `codex` CLI logged in (`codex login`). For calls from code, `codex exec --skip-git-repo-check --ephemeral -s workspace-write [-i img] -` with the prompt on stdin, in an empty temp folder, asking it to save `out.png` there.

## Prompting rules

- Describe scene, style, lighting, composition and mood in full sentences; detailed prose beats keyword lists.
- Always state the intended use ("hero image for a slide", "small monochrome icon") so scale and detail fit.
- For slide assets: clean, reduced, generous negative space, light background, the brand accent color sparingly, no gradients-and-glow AI look.
- Avoid in-image text unless explicitly wanted; if text is needed, quote the exact wording in the prompt.
- Watch colour on edits: Codex drifts slightly warmer than the source, and can mirror a garment's sides. Say "keep the exact colours and which side each part is on" when it matters.

## Workflow

1. Generate to a file.
2. ALWAYS view the result (Read the image) before using or showing it - check it matches the request and has no artifacts.
3. If off, refine the prompt or edit with `-i` instead of regenerating from scratch.
4. Embed in HTML via relative path, or as base64 data URI when the file must be self-contained (artifacts).

## Failure modes

- "no image from codex": print shows codex's tail. Usually a refusal (rephrase) or a logged-out CLI (`codex login`).
- Timeout after 10 minutes: retry.

## Critic gate (evrloot-next and any repo with tools/art/critic)
When the output lands inside a repo that has `tools/art/critic/critic.ts`, generate.py runs that critic on the image right after saving it and exits non-zero on a reject (the report is the `.critic.md` beside the image). A rejected image is never shipped: repair it with an `-i` edit or regenerate. `EVR_CRITIC=off` skips the check; only tools that run the critic themselves (world-kit's ledger, candidates.ts) set it.
