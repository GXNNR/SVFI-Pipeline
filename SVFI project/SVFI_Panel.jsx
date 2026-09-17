(function (thisObj) {
    var CARPETA_SCRIPT = File($.fileName).parent.fsName;
    var carpetaTrabajo = null;

    var carpetaConfig = new Folder(Folder.myDocuments.fsName + "/SVFIPanel");
    if (!carpetaConfig.exists) {
        carpetaConfig.create();
    }
    var archivoConfig = new File(carpetaConfig.fsName + "/config.json");

    function guardarConfig() {
        try {
            var data = { ultimaCarpeta: carpetaTrabajo };
            archivoConfig.open("w");
            archivoConfig.write(JSON.stringify(data));
            archivoConfig.close();
        } catch (e) {}
    }

    function cargarConfig() {
        try {
            if (!archivoConfig.exists) return null;
            archivoConfig.open("r");
            var contenido = archivoConfig.read();
            archivoConfig.close();
            if (!contenido) return null;
            var data = JSON.parse(contenido);
            return data.ultimaCarpeta || null;
        } catch (e) {
            return null;
        }
    }

    $.global.SVFI_taskId = null;

    function detenerWatcher() {
        if ($.global.SVFI_taskId !== null) {
            try { app.cancelTask($.global.SVFI_taskId); } catch (e) {}
            $.global.SVFI_taskId = null;
        }
    }

    function iniciarWatcher() {
        detenerWatcher();
        $.global.SVFI_watchFolder = carpetaTrabajo;
        $.global.SVFI_taskId = app.scheduleTask("$.global.SVFI_checkDone()", 2000, true);
    }

    $.global.SVFI_checkDone = function () {
        try {
            var folder = $.global.SVFI_watchFolder;
            if (!folder) return;
            var txtSalida = new File(folder + "/svfi_output.txt");
            if (txtSalida.exists) {
                if ($.global.SVFI_panelEstado) {
                    $.global.SVFI_panelEstado.text = "✅ SVFI finished! Ready to load.";
                    try { $.global.SVFI_panelEstado.notify("onDraw"); } catch (e) {}
                }
                if ($.global.SVFI_panel) {
                    try { $.global.SVFI_panel.update(); } catch (e) {}
                }
                if ($.global.SVFI_taskId !== null) {
                    try { app.cancelTask($.global.SVFI_taskId); } catch (e) {}
                    $.global.SVFI_taskId = null;
                }
            }
        } catch (e) {}
    };

    var pal = (thisObj instanceof Panel) ? thisObj : new Window("palette", "SVFI Pipeline", undefined, {resizeable:true});
    pal.orientation = "column";
    pal.alignChildren = ["fill", "top"];
    pal.spacing = 10;
    pal.margins = 15;

    var titulo = pal.add("statictext", undefined, "🎬 SVFI Pipeline");
    titulo.graphics.font = ScriptUI.newFont("Segoe UI", "BOLD", 16);

    var grupoCarpeta = pal.add("group");
    grupoCarpeta.orientation = "column";
    grupoCarpeta.alignChildren = ["fill", "top"];
    grupoCarpeta.spacing = 5;

    grupoCarpeta.add("statictext", undefined, "Working folder:");
    var campoCarpeta = grupoCarpeta.add("edittext", undefined, "");
    campoCarpeta.characters = 30;
    var btnCarpeta = grupoCarpeta.add("button", undefined, "Select Folder...");

    btnCarpeta.onClick = function () {
        var carpeta = Folder.selectDialog("Select the working folder");
        if (carpeta) {
            carpetaTrabajo = carpeta.fsName.replace(/\\/g, "/");
            campoCarpeta.text = carpetaTrabajo;
            guardarConfig();
        }
    };

    var ultimaCarpeta = cargarConfig();
    if (ultimaCarpeta) {
        var carpetaVerificada = new Folder(ultimaCarpeta);
        if (carpetaVerificada.exists) {
            carpetaTrabajo = ultimaCarpeta;
            campoCarpeta.text = ultimaCarpeta;
        } else {
            carpetaTrabajo = null;
            campoCarpeta.text = "";
        }
    }

    pal.add("panel", undefined, "").preferredSize.height = 2;

    var grupoAcciones = pal.add("group");
    grupoAcciones.orientation = "column";
    grupoAcciones.alignChildren = ["fill", "top"];
    grupoAcciones.spacing = 8;

    var btnProcesar = grupoAcciones.add("button", undefined, "▶  Render & Process");
    var btnCargar = grupoAcciones.add("button", undefined, "📥  Load Result");

    var estado = pal.add("statictext", undefined, "Ready.");
    estado.alignment = ["fill", "top"];

    $.global.SVFI_panelEstado = estado;
    $.global.SVFI_panel = pal;

    btnProcesar.onClick = function () {
        try {
            detenerWatcher();

            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) {
                alert("Select a composition in the timeline.");
                return;
            }

            if (!carpetaTrabajo) {
                alert("Please select a working folder first.");
                return;
            }

            var nombreBase = prompt("File name (without extension):", comp.name);
            if (!nombreBase) return;

            nombreBase = nombreBase.replace(/[^a-zA-Z0-9_\-]/g, "_");
            var nombreSalida = nombreBase + ".mov";
            var rutaSalida = carpetaTrabajo + "/" + nombreSalida;

            var txtSalidaViejo = new File(carpetaTrabajo + "/svfi_output.txt");
            if (txtSalidaViejo.exists) {
                try { txtSalidaViejo.remove(); } catch (e) {}
            }

            var rqItem = app.project.renderQueue.items.add(comp);

            try {
                rqItem.outputModule(1).applyTemplate("Clips RIFE");
            } catch (e) {
                alert("The 'Clips RIFE' template was not found. Make sure it exists in After Effects.");
            }

            rqItem.outputModule(1).file = new File(rutaSalida);

            estado.text = "🎬 Rendering in After Effects...";
            pal.update();
            app.project.renderQueue.render();

            var txtEntrada = new File(carpetaTrabajo + "/ae_svfi_input.txt");
            txtEntrada.open("w");
            txtEntrada.write(nombreSalida);
            txtEntrada.close();

            estado.text = "📤 Sending to SVFI...";
            pal.update();

            var txtCarpeta = new File(CARPETA_SCRIPT + "/carpeta_actual.txt");
            txtCarpeta.open("w");
            txtCarpeta.write(carpetaTrabajo);
            txtCarpeta.close();

            var rutaVbs = CARPETA_SCRIPT + "/lanzar_svfi.vbs";
            var comando = 'wscript.exe "' + rutaVbs + '"';
            system.callSystem(comando);

            estado.text = "⏳ SVFI processing in the background...";
            pal.update();
            iniciarWatcher();

        } catch (err) {
            alert("Error: " + err.toString());
            estado.text = "❌ Error. Check the console.";
        }
    };

    btnCargar.onClick = function () {
        try {
            if (!carpetaTrabajo) {
                alert("Please select a working folder first.");
                return;
            }

            var txtSalida = new File(carpetaTrabajo + "/svfi_output.txt");
            if (!txtSalida.exists) {
                alert("No result is available yet. Has SVFI finished?");
                return;
            }

            txtSalida.open("r");
            var rutaFinal = txtSalida.read();
            txtSalida.close();

            var archivoFinal = new File(rutaFinal);
            if (!archivoFinal.exists) {
                alert("The final file does not exist: " + rutaFinal);
                return;
            }

            var comp = app.project.activeItem;
            if (!comp || !(comp instanceof CompItem)) {
                alert("Open the composition where you want to place the result.");
                return;
            }

            var capaSeleccionada = null;
            if (comp.selectedLayers.length > 0) {
                capaSeleccionada = comp.selectedLayers[0];
            }

            var importOptions = new ImportOptions(archivoFinal);
            var footage = app.project.importFile(importOptions);

            var nuevaCapa = comp.layers.add(footage);

            if (capaSeleccionada) {
                nuevaCapa.startTime = capaSeleccionada.startTime;
                nuevaCapa.moveBefore(capaSeleccionada);
            } else {
                nuevaCapa.startTime = 0;
            }

            estado.text = "✅ Result loaded: " + archivoFinal.name;

        } catch (err) {
            alert("Error loading result: " + err.toString());
        }
    };

    pal.onResizing = pal.onResize = function () { this.layout.resize(); };

    if (pal instanceof Window) {
        pal.center();
        pal.show();
    } else {
        pal.layout.layout(true);
    }

})(this);