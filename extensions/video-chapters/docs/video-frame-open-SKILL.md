---
name: video-frame-open
description: |
  Locate a moment in a local video using natural language, extract that frame with ffmpeg,
  and open it in the Windows default image viewer. For when the user explicitly asks to
  "open" or "show" a frame, not when they just want a description or inline thumbnail in chat.
priority: 50
metadata:
  openclaw:
    emoji: 🎬
    primaryEnv: 'VIDEO_CHAPTERS_FFMPEG_PATH'
---

# Open a Video Keyframe (video-frame-open)

Find a moment in an already-indexed video using natural language, extract that instant as a
still image, and pop it open on this machine with the OS's default viewer.

## When to use this skill

Only use this flow when the user **explicitly asks to open/pop up/view the frame on its own**
(e.g. "open this frame", "show me that moment", "export this as an image"). If the user is
just asking whether a video contains some moment, answer with `video_chapters_search`'s text
result and inline thumbnail — don't use this. Popping open a native viewer window is an
intrusive action; don't do it unless the user asked for it.

## Steps

### Step 1: locate the moment with video_chapters_search

Call the `video_chapters_search` tool with `query` set to the user's natural-language
description of the moment.

- If the user named a specific video file, pass it as the `video` parameter — the result
  won't include a video path in this case, since you already have it (it's the one the user
  gave you).
- If no specific file was named, omit `video` and search across the whole library — each
  match in the result then carries its own `video` field with that match's file path.

Each match has `start` (seconds, float), `end`, `title`, `desc`, and `score`. **Take only the
single highest-scoring match** and extract from that one — don't extract multiple frames,
don't build a montage/composite of several moments, and don't open multiple windows per
request. One request, one frame, one window.

### Step 2: extract that instant with ffmpeg

Use **exactly** this ffmpeg path and this output directory — don't substitute a different
location, a temp folder you find yourself, or a folder under the user's own document/video
directories:

```
C:\Users\HCKTest\video_chapters-arm64\ffmpeg\ffmpeg.exe
```

Run this via the `exec` tool (PowerShell), unmodified except for the two substitutions noted
below:

```powershell
$outDir = "$env:TEMP\video-chapters-skill"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ("frame_{0}.jpg" -f (Get-Date -Format "yyyyMMdd_HHmmss"))
& "C:\Users\HCKTest\video_chapters-arm64\ffmpeg\ffmpeg.exe" -y -ss <start_seconds> -i "<absolute_video_path>" -frames:v 1 "$outFile"
```

Substitute `<start_seconds>` with the `start` value from step 1, and `<absolute_video_path>`
with that match's video path. After running, verify `$outFile` actually exists — ffmpeg does
not always return a non-zero exit code on failure. If extraction failed, say so plainly rather
than pretending it succeeded.

### Step 3: open it with the default app — and stop there

```powershell
Start-Process "$outFile"
```

This opens the file with whatever the OS has associated as the default image viewer (usually
Photos) — you don't need to name a specific program, and don't launch `explorer.exe` as well;
`Start-Process` on the file itself is the only command this step needs.

**This is the last action.** After `Start-Process` succeeds, tell the user in one sentence
that the frame is open — do not also try to show, embed, or attach the image inside your
chat reply (no markdown image syntax, no attachment tool, nothing that references
`$outFile`'s path as something for the chat UI to preview). `$outFile` lives under `$env:TEMP`,
which is outside the Control UI's allowed local-media directories, so any attempt to preview
it inline will fail with "Outside allowed folders" — that failure is not a sign anything above
went wrong, it means this step tried to do something it shouldn't. The popup window already
is the deliverable.

## Notes

- **Verify ffmpeg.exe actually exists before every call** (`Test-Path "C:\Users\HCKTest\video_chapters-arm64\ffmpeg\ffmpeg.exe"`). If it doesn't, tell the user the path is wrong rather than continuing blindly.
- **Don't clean up old files** in `$env:TEMP\video-chapters-skill` — that isn't this skill's job. Leftover screenshots don't break anything; let the user or the OS's own temp-file policy handle cleanup.
- This flow is **independent of the frames `video_chapters_search` auto-extracts for chat**: the tool's own frames exist to show thumbnails inline in chat; this skill extracts its own frame purely for the local popup, and neither reuses nor depends on the other's output.
- Follow steps 1-3 exactly as written. Don't improvise an alternative ffmpeg discovery method (e.g. searching for `ffmpeg.exe` elsewhere, or a Python/`imageio_ffmpeg` lookup) — the path above is already known-correct for this deployment.
