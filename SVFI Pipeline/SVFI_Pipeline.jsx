/*
 * SVFI Pipeline - lanzador
 * Abre (o trae al frente) el panel CEP de SVFI Pipeline.
 * Se puede ejecutar con File > Scripts > Run Script File o desde NyaUIPanel.
 */
(function () {
    var EVT = 'com.gxnnr.svfipipeline.openPanel';
    var MENU = 'SVFI Pipeline';

    function serviceAlive() {
        try {
            var f = new File(Folder.myDocuments.fsName + '/SVFIPipeline/service.json');
            if (!f.exists) { return false; }
            f.encoding = 'UTF-8';
            f.open('r');
            var txt = f.read();
            f.close();
            var m = /"beat"\s*:\s*(\d+)/.exec(txt);
            return !!m && (new Date().getTime() - parseFloat(m[1])) < 10000;
        } catch (e) { return false; }
    }

    // 1) Con el servicio activo: se le pide abrir el panel (si ya esta abierto, solo lo enfoca)
    if (serviceAlive()) {
        try {
            if (!ExternalObject.PlugPlugExternalObject) { new ExternalObject('lib:PlugPlugExternalObject'); }
            var ev = new CSXSEvent();
            ev.type = EVT;
            ev.data = '';
            ev.dispatch();
            return;
        } catch (e) { }
    }

    // 2) Respaldo: Window > Extensions > SVFI Pipeline
    var id = 0;
    try { id = app.findMenuCommandId(MENU); } catch (e2) { }
    if (id) { app.executeCommand(id); return; }

    alert('SVFI Pipeline is not installed.\nRun INSTALL_Windows.bat and restart After Effects.');
})();
