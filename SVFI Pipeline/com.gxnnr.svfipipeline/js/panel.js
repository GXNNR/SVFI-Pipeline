/*
 * SVFI Pipeline - panel
 * Solo habla con AE cuando pulsas "Render & Queue". La cola se refresca leyendo archivos con Node:
 * no hay app.scheduleTask ni temporizadores dentro de After Effects.
 */
(function () {
    var path = require('path');
    var cp = require('child_process');

    var $ = function (id) { return document.getElementById(id); };
    var cfg = SVFI.readConfig();
    var rendering = false;
    var lastQueueHtml = '';
    var serviceKick = 0;

    $('ver').textContent = 'v' + SVFI.VERSION;

    // ------------------------------------------------------------------ mensajes
    var msgTimer = null;
    function msg(text, kind) {
        var m = $('msg');
        m.textContent = text;
        m.className = 'msg' + (kind === 'info' ? ' info' : '');
        clearTimeout(msgTimer);
        if (kind === 'info') { msgTimer = setTimeout(function () { m.className = 'msg hidden'; }, 6000); }
    }
    function clearMsg() { $('msg').className = 'msg hidden'; }

    // ------------------------------------------------------------------ ajustes
    function fillSettings() {
        $('workFolder').value = cfg.workFolder || '';
        $('svfiPath').value = cfg.svfiPath || '';
        $('presetPath').value = cfg.presetPath || '';
        $('template').value = cfg.template || '';
        $('deleteOriginal').checked = !!cfg.deleteOriginal;
        $('maxMinutes').value = cfg.maxMinutes;
        $('autoImport').checked = !!cfg.autoImport;
        $('autoState').textContent = cfg.autoImport ? 'ON' : 'OFF';
        $('autoState').className = cfg.autoImport ? '' : 'off';
        if (!cfg.workFolder || !cfg.svfiPath) { $('settings').open = true; }
    }

    function save(patch) { cfg = SVFI.writeConfig(patch); fillSettings(); }

    function pick(field) {
        var isDir = field === 'workFolder';
        var types = field === 'svfiPath' ? ['exe'] : (field === 'presetPath' ? ['ini'] : []);
        var start = cfg[field] ? (isDir ? cfg[field] : path.dirname(cfg[field])) : '';
        var fsx = window.cep && window.cep.fs, r;
        if (!fsx) { return; }
        r = fsx.showOpenDialogEx
            ? fsx.showOpenDialogEx(false, isDir, 'Select ' + field, start, types)
            : fsx.showOpenDialog(false, isDir, 'Select ' + field, start, types);
        if (r && r.data && r.data.length && r.data[0]) {
            var p = {};
            p[field] = path.normalize(r.data[0]);
            save(p);
        }
    }

    var pickBtns = document.querySelectorAll('[data-pick]');
    for (var i = 0; i < pickBtns.length; i++) {
        pickBtns[i].addEventListener('click', function () { pick(this.getAttribute('data-pick')); });
    }
    $('template').addEventListener('change', function () { save({ template: this.value.trim() || 'Clips RIFE' }); });
    $('deleteOriginal').addEventListener('change', function () { save({ deleteOriginal: this.checked }); });
    $('maxMinutes').addEventListener('change', function () {
        var v = parseInt(this.value, 10);
        save({ maxMinutes: isNaN(v) ? 120 : Math.max(5, Math.min(1440, v)) });
    });
    $('autoImport').addEventListener('change', function () { save({ autoImport: this.checked }); });

    // ------------------------------------------------------------------ render
    function validate() {
        if (!cfg.workFolder || !SVFI.exists(cfg.workFolder)) { return 'Choose a work folder in Settings.'; }
        if (!cfg.svfiPath || !SVFI.exists(cfg.svfiPath)) { return 'Set the SVFI path (one_line_shot_args.exe) in Settings.'; }
        if (!SVFI.exists(cfg.presetPath)) { return 'The preset .ini was not found. Check Settings.'; }
        return null;
    }

    function setBtn(text, disabled) {
        $('btnRender').disabled = disabled;
        $('btnRender').querySelector('span').textContent = text;
    }
    var BTN_IDLE = 'Render & Queue selected layers';

    // Un clic: lee las capas seleccionadas y crea un trabajo por capa.
    // El servicio las renderiza en AE una tras otra y cada una pasa a SVFI al terminar.
    $('btnRender').addEventListener('click', function () {
        if (rendering) { return; }
        cfg = SVFI.readConfig();
        var problem = validate();
        if (problem) { $('settings').open = true; return msg(problem); }
        clearMsg();
        rendering = true;
        setBtn('Reading selection...', true);

        SVFI.evalHost('svfi_selection', {}, function (out, raw) {
            rendering = false;
            setBtn(BTN_IDLE, false);
            if (!out || !out.ok) { return msg(out ? out.error : ('After Effects did not answer: ' + raw)); }
            if (!out.layers.length) { return msg('Nothing to render: ' + out.skipped.join(', ')); }

            var t = Date.now(), i, L, id, dir;
            for (i = 0; i < out.layers.length; i++) {
                L = out.layers[i];
                id = SVFI.newJobId();
                dir = path.join(SVFI.jobsDir(cfg), id);
                try { SVFI.ensureDir(dir); } catch (e) { return msg('Could not create the job folder: ' + e.message); }
                SVFI.saveJob({
                    _dir: dir, id: id, name: L.layerName, status: 'pendingRender', createdAt: t + i,
                    compId: out.compId, compName: out.compName,
                    layerId: L.layerId, layerIndex: L.layerIndex, layerName: L.layerName
                });
            }
            var txt = out.layers.length === 1 ? ('"' + out.layers[0].layerName + '" queued.') : (out.layers.length + ' layers queued.');
            if (out.skipped.length) { txt += ' Skipped: ' + out.skipped.join(', '); }
            msg(txt, 'info');
            refresh();
        });
    });

    // ------------------------------------------------------------------ cola
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function elapsed(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        var m = Math.floor(s / 60);
        return m ? (m + 'm ' + (s % 60) + 's') : (s + 's');
    }

    var LABEL = { pendingRender: 'Waiting AE', rendering: 'AE render', queued: 'Queued', processing: 'SVFI', done: 'Ready', imported: 'Imported', error: 'Error', cancelled: 'Cancelled' };

    function jobHtml(j, pos) {
        var sub = '', acts = [], cls = 'job-sub';
        if (j.status === 'pendingRender') { sub = 'Waiting for After Effects'; acts.push(['cancel', 'Cancel']); }
        else if (j.status === 'rendering') { sub = 'Rendering in After Effects (' + elapsed(Date.now() - (j.renderStartedAt || j.createdAt)) + ')'; }
        else if (j.status === 'queued') { sub = pos === 1 ? 'Next in line' : ('Position ' + pos + ' in the queue'); acts.push(['cancel', 'Cancel']); }
        else if (j.status === 'processing') {
            sub = elapsed(Date.now() - (j.startedAt || Date.now())) + (j.lastLine ? '  ·  ' + j.lastLine : '');
            acts.push(['cancel', 'Cancel']);
        }
        else if (j.status === 'done') {
            sub = j.importNote || (cfg.autoImport ? 'Importing...' : 'Ready to import');
            acts.push(['import', 'Import']);
        }
        else if (j.status === 'imported') { sub = j.importNote || ('In ' + j.compName); }
        else if (j.status === 'error') { sub = j.error || 'Unknown error'; cls += ' err'; acts.push(['retry', 'Retry']); }
        if (j.status !== 'queued' && j.status !== 'processing' && j.status !== 'rendering' && j.status !== 'pendingRender') { acts.push(['archive', 'Remove']); }
        acts.push(['log', 'Log']);

        var h = '<div class="job" data-id="' + esc(j.id) + '">' +
            '<div class="job-top"><span class="job-name" title="' + esc(j.compName + ' > ' + j.layerName) + '">' + esc(j.name) + '</span>' +
            '<span class="badge ' + j.status + '">' + (LABEL[j.status] || j.status) + '</span></div>' +
            '<div class="' + cls + '" title="' + esc(sub) + '">' + esc(sub) + '</div><div class="job-actions">';
        for (var i = 0; i < acts.length; i++) {
            h += '<button class="ghost small" data-act="' + acts[i][0] + '">' + acts[i][1] + '</button>';
        }
        return h + '</div></div>';
    }

    var jobsById = {};

    function refresh() {
        cfg = SVFI.readConfig();
        var st = SVFI.serviceStatus();
        $('svc').className = 'svc ' + (st.alive ? 'ok' : 'bad');
        $('svcText').textContent = st.alive ? 'Service running' : 'Service not detected';

        // Si el servicio no responde, se le pide a CEP que lo abra (como mucho cada 15 s)
        if (!st.alive && Date.now() - serviceKick > 15000) {
            serviceKick = Date.now();
            try { window.__adobe_cep__.requestOpenExtension(SVFI.EXT_SERVICE, ''); } catch (e) { }
        }

        var jobs = SVFI.listJobs(cfg).filter(function (j) { return !j.archived; });
        jobsById = {};
        var html = '', pos = 0;
        for (var i = 0; i < jobs.length; i++) {
            jobsById[jobs[i].id] = jobs[i];
            if (jobs[i].status === 'queued') { pos++; }
            html += jobHtml(jobs[i], pos);
        }
        // Mientras AE renderiza no se le puede preguntar la seleccion (daria el error de dialogo modal)
        var aeJobs = jobs.filter(function (j) {
            return j.status === 'pendingRender' ||
                (j.status === 'rendering' && !SVFI.exists(path.join(j._dir, 'render_status.json')));
        }).length;
        fastRefresh = aeJobs > 0 || jobs.some(function (j) { return j.status === 'rendering'; });
        if (!rendering) {
            if (aeJobs) { setBtn('After Effects is rendering' + (aeJobs > 1 ? ' (' + aeJobs + ' left)' : '') + '...', true); }
            else { setBtn(BTN_IDLE, false); }
        }
        if (!jobs.length) { html = '<div class="empty">Select one or more layers and press Render &amp; Queue.</div>'; }
        if (html !== lastQueueHtml) { $('queue').innerHTML = html; lastQueueHtml = html; }
    }

    function openPath(p) {
        if (!p) { return; }
        try {
            if (process.platform === 'win32') { cp.exec('start "" "' + p + '"', { windowsHide: true }); }
            else { cp.exec('open "' + p + '"'); }
        } catch (e) { }
    }

    $('queue').addEventListener('click', function (ev) {
        var b = ev.target.closest('button[data-act]');
        if (!b) { return; }
        var id = b.closest('.job').getAttribute('data-id');
        var j = jobsById[id];
        if (!j) { return; }
        var act = b.getAttribute('data-act');
        if (act === 'log') { return openPath(path.join(j._dir, 'svfi_log.txt')); }
        SVFI.request(j, act);
        b.disabled = true;
    });

    $('btnClean').addEventListener('click', function () {
        var n = 0;
        for (var id in jobsById) {
            var j = jobsById[id];
            if (j.status === 'imported' || j.status === 'cancelled' || j.status === 'error') { SVFI.request(j, 'archive'); n++; }
        }
        msg(n ? ('Cleaning ' + n + ' finished job(s).') : 'Nothing to clean.', 'info');
    });

    $('btnOpenFolder').addEventListener('click', function () {
        if (cfg.workFolder) { openPath(cfg.workFolder); } else { $('settings').open = true; }
    });

    // ------------------------------------------------------------------ arranque
    var fastRefresh = false;
    function refreshLoop() {
        try { refresh(); } catch (e) { }
        setTimeout(refreshLoop, (fastRefresh || rendering) ? 250 : 1000);
    }
    fillSettings();
    refreshLoop();
})();
