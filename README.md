# SVFI Pipeline

Complete frame interpolation automation between After Effects and SVFI.

A panel inside After Effects that renders, launches SVFI in the background, waits for it to finish, and reimports the processed clip automatically aligned. All with two clicks, without freezing the program, and without touching the command line.

## Features

- Render and process with a single button. Select the composition, click, and the system does the rest.
- Does not freeze After Effects. While SVFI processes, you can keep working normally.
- Automatic task completion detection. The panel notifies you when SVFI finishes, so you don't have to watch it.
- Aligned reimport. The processed clip appears right above the layer you had selected, aligned to the same start point.
- Folder memory. Remembers the last work folder you used.
- Automatic migration. Move to another PC or folder with a single .bat file.
- Temporary file cleanup. One click and it removes everything no longer needed.
- Diagnostic logs. If something fails, the .txt files tell you exactly where.

## Requirements

- Windows 10 or 11
- After Effects CC 2018 or higher
- Python 3.8+ (with "Add to PATH" checked during installation)
- SVFI from Steam
- "Clips RIFE" template created in your After Effects

## Installation

1. Install Python from python.org and check the "Add Python to PATH" option.
2. Install SVFI from Steam and open it once.
3. Create a file named `steam_appid.txt` inside the SVFI folder with the exact content: `1692080`
4. Create the "Clips RIFE" template in After Effects. Go to Edit > Templates > Output Module Templates. Duplicate an existing template and rename it to "Clips RIFE". Format: QuickTime, Codec: Animation or ProRes 422 HQ.
5. Copy the project folder wherever you want.
6. Run `Config.bat` and press Enter on the 3 prompts.
7. Open After Effects and load `SVFI_Panel.jsx` from File > Scripts > Run Script File.

## How to Use

1. Open the SVFI Pipeline panel in After Effects.
2. Click "Select Folder..." and choose where you want the temporary files.
3. Select the layer you want to process in the timeline.
4. Click "Render and Process" and type a name for the file.
5. Keep working in After Effects normally while SVFI processes.
6. When the panel says "SVFI finished, ready to load", select the original layer and click "Load Result".
7. The processed clip appears aligned right above the original layer.

## Project Files

- SVFI_Panel.jsx: After Effects panel
- svfi_orquestador.py: Python orchestrator
- lanzar_svfi.vbs: VBS launcher (does not freeze AE)
- config.txt: SVFI and preset paths
- mi_preset_svfi.ini: SVFI configuration
- Config.bat: Automatic migration
- Clean.bat: Temporary file cleanup
- LICENSE: GPL v3
- README.md: This file
- COMPLETE GUIDE SVFI PIPELINE ENGLISH.txt: Complete guide in English
- GUIA COMPLETA SVFI PIPELINE ESPANOL.txt: Complete guide in Spanish

## Manual Changes (only if necessary)

- After Effects template: if you use a template other than "Clips RIFE", edit SVFI_Panel.jsx and search for applyTemplate.
- Paths: handled automatically by Config.bat. Manual editing only if it fails.
- SVFI preset: to change the preset, generate a new one from the SVFI GUI and replace mi_preset_svfi.ini.

For more details, see the complete guides in Spanish and English included in the project.

## Troubleshooting

Problem: The panel says "Template Clips RIFE not found".
Solution: Create the template in After Effects or change the name in SVFI_Panel.jsx.

Problem: After Effects freezes during rendering.
Solution: Verify that SVFI_Panel.jsx calls wscript.exe and not cmd or start.

Problem: SVFI does not process and the log says "File does not exist".
Solution: Run Config.bat to regenerate the paths.

Problem: A path is not found.
Solution: Run Config.bat. If it fails, edit config.txt and lanzar_svfi.vbs manually.

Problem: The watcher does not detect SVFI completion.
Solution: Verify that svfi_output.txt exists in the work folder. Close After Effects and reopen it.

More details in the complete guides.

## Contributions

This project is free software under the GNU General Public License v3.0. This means:

- You can use, modify, and distribute the software freely.
- You can make your own improvements.
- You cannot close the source. If you distribute a modified version, it must remain GPL v3.

If you find a bug or want to propose an improvement, open an issue or send a pull request.

## License

This project is licensed under the GNU General Public License v3.0. See the LICENSE file for details.

Copyright (C) 2026 [GXNNR]

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.