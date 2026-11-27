# SVFI Pipeline

Frame interpolation automation between After Effects and SVFI.

Select one or more layers, click **Render & Queue**, and keep working. After Effects renders only each layer's fragment, SVFI processes them in the background, and every interpolated clip is imported automatically in place of its original layer — even if the panel is closed.

## Features

- **Dockable panel** (CEP extension) with a real After Effects UI.
- **No precomp needed.** The selected layer is rendered exactly as you see it in the comp: the panel solos it temporarily and renders only its in/out range. Your Solo switches, Work Area and Render Queue are restored afterwards.
- **SVFI queue.** Render as many layers as you want in AE; SVFI processes them one by one outside AE (one at a time, so the GPU isn't overloaded).
- **Auto-import (ON/OFF).** Each result is imported above its original layer, aligned in time, and the original layer is deleted (one Ctrl+Z restores it). If the original is a parent or a track matte, it is hidden instead of deleted.
- **Auto-comp (ON/OFF).** Each imported clip is precomposed at its own frame rate. Choose **Comp only** or **Comp + fix frames**, which removes the repeated frames SVFI leaves at the start (1) and end (7) and adjusts the comp duration (both numbers editable in Settings).
- **Works with the panel closed.** A small invisible background service runs the queue and imports results. It only touches After Effects when a result is ready, and if AE is busy (a dialog is open) it simply retries later.
- **Clear errors.** If SVFI fails, the job is marked as an error with its reason and a log; it can be retried with one click.
- **Your preset is never modified.** Each job uses its own copy, with its own output folder and the comp's real frame rate (keeping your preset's multiplier, e.g. x8).
- **No Python, no .vbs, no special folder permissions.**
- **Multiple layers in one click.** They are rendered in AE one after another, and AE returns to the comp when the batch is done.
- **Launcher script.** `SVFI_Pipeline.jsx` (installed in File > Scripts) opens the panel, so it can be called from other script launchers (e.g. NyaUIPanel).

## Requirements

- Windows 10 or 11
- After Effects 2019 (16.0) or newer
- SVFI from Steam
- An output module template called **"Clips RIFE"** (or another name, set in Settings)

## Installation

1. Install SVFI from Steam and open it once.
2. Create a file named `steam_appid.txt` inside the SVFI folder with the exact content: `1692080`
3. Create the output module template in After Effects: **Edit > Templates > Output Module**. Duplicate an existing template and rename it **"Clips RIFE"**. Format: QuickTime, Codec: Animation or ProRes 422 HQ.
4. Close After Effects and run **`SVFI Pipeline/INSTALL_Windows.bat`**. Windows asks for administrator permission once: it is only used to copy the launcher `SVFI_Pipeline.jsx` into the Scripts folder of every After Effects version found.
5. Open After Effects: **Window > Extensions > SVFI Pipeline** or **File > Scripts > SVFI_Pipeline.jsx**.
6. In **Settings**, choose the work folder, the path to `one_line_shot_args.exe` and, if you want, your own preset `.ini`.

> Tip: point Settings to your own copy of the preset. Reinstalling replaces the bundled `mi_preset_svfi.ini`.

To uninstall, run `UNINSTALL_Windows.bat`.

## How to Use

1. Apply **Time Remapping** (or whatever you need) to the clip.
2. Select one or more layers and click **Render & Queue selected layers**. They are rendered in AE one after another, automatically.
3. Keep working while SVFI processes the queue. Results are named `<layer>_SVFI.mov`.
4. With **Auto-import ON**, each result replaces its layer automatically. With it OFF, press **Import** on the job when you want.

## Files

- Settings and service status: `Documents\SVFIPipeline\`
- Jobs: `<work folder>\SVFI_jobs\<job>\` — the render, the preset copy, `svfi_log.txt` and the SVFI result (`out\`).
- **Clean** removes finished jobs from the list and deletes temporary files. Imported results are kept, because your project uses them.

A complete guide is included in English and Spanish (`Complete guide SVFI Pipeline English.txt`, `Guía completa SVFI Pipeline Español.txt`).

## Debugging

With After Effects open, the panel console is at `http://localhost:8102` and the service console at `http://localhost:8103` (Chrome).
