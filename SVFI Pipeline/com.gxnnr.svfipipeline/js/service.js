/*
 * SVFI Pipeline Service - extension invisible (Node)
 * Arranca con After Effects y sigue funcionando aunque el panel este cerrado.
 *  - Procesa la cola de SVFI de a un trabajo (la GPU no da para mas).
 *  - Detecta el final por el codigo de salida + el video en la carpeta out/ del trabajo.
 *  - Solo entra a AE para importar un resultado; si AE esta ocupado, reintenta con espera creciente.
 */
(function () {
    var fs = require('fs');
    var path = require('path');
    var cp = require('child_process');

    var TICK_MS = 1500;
    var STABLE_MS = 3000;
    var RESULT_SETTLE_MS = 800;   // SVFI ya salio: el video final solo tiene que dejar de crecer
    var WAIT_AFTER_OK_MS = 30 * 60 * 1000;
    var WAIT_AFTER_FAIL_MS = 20 * 1000;
    var IMPORT_TIMEOUT_MS = 60 * 1000;

    var current = null;      // { id, child, pid, phase: 'running'|'adopted'|'waiting', exitCode, waitFrom, lastSize, sizeSince }
    var importing = null;    // { id, at }
    var backoff = {};        // id -> { next, tries }
    var lastError = '';
    var lastLineSaved = 0;
    var renderPoll = { busy: false, at: 0 };
    var renderSizes = {};    // id -> { size, since } para saber cuando el render dejo de crecer
    var MOV_SETTLE_MS = 300;      // .mov cerrado y sin crecer -> AE ya termino
    var OTHER_SETTLE_MS = 20000;  // otros formatos: solo se puede esperar a que deje de crecer
    var STALL_MS = 120000;        // ultimo recurso
    var POLL_GAP_MS = 700;
    var FAST_TICK_MS = 250;       // mientras AE renderiza se mira el archivo mas seguido (solo disco, no AE)
    var fastMode = false;

    // ------------------------------------------------------------------ utilidades
    function now() { return Date.now(); }

    function stamp() { return new Date().toTimeString().slice(0, 8); }

    function jobLog(job, msg) {
        try { fs.appendFileSync(path.join(job._dir, 'svfi_log.txt'), '[' + stamp() + '] ' + msg + '\n', 'utf8'); } catch (e) { }
    }

    function findJob(cfg, id) {
        var jobs = SVFI.listJobs(cfg), i;
        for (i = 0; i < jobs.length; i++) { if (jobs[i].id === id) { return jobs[i]; } }
        return null;
    }

    function update(cfg, id, patch) {
        var job = findJob(cfg, id), k;
        if (!job) { return null; }
        for (k in patch) { if (patch.hasOwnProperty(k)) { job[k] = patch[k]; } }
        SVFI.saveJob(job);
        return job;
    }

    function isAlive(pid) {
        if (!pid) { return false; }
        try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
    }

    function killTree(pid) {
        if (!pid) { return; }
        try {
            if (process.platform === 'win32') { cp.exec('taskkill /PID ' + pid + ' /T /F', { windowsHide: true }); }
            else { process.kill(pid, 'SIGTERM'); }
        } catch (e) { }
    }

    // Solo el primer nivel de out/: SVFI a veces deja su carpeta de proyecto con videos de prueba dentro
    function findVideos(dir) {
        var out = [], names, i, full, st;
        try { names = fs.readdirSync(dir); } catch (e) { return out; }
        for (i = 0; i < names.length; i++) {
            full = path.join(dir, names[i]);
            try { st = fs.statSync(full); } catch (e2) { continue; }
            if (st.isFile() && SVFI.VIDEO_EXT[path.extname(names[i]).toLowerCase()] && st.size > 0) {
                out.push({ path: full, size: st.size, mtime: st.mtime.getTime() });
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ preset por trabajo
    // Nunca se toca el preset original: cada trabajo usa su propia copia.
    function buildPreset(cfg, job) {
        var txt = fs.readFileSync(cfg.presetPath, 'utf8').replace(/^\uFEFF/, '');
        var nl = txt.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
        var lines = txt.split(/\r?\n/), i, inFps = null, tgFps = null, outIdx = -1, inIdx = -1, tgIdx = -1, m;
        for (i = 0; i < lines.length; i++) {
            if ((m = /^output_dir=/.exec(lines[i]))) { outIdx = i; }
            else if ((m = /^input_fps=(.*)$/.exec(lines[i]))) { inIdx = i; inFps = parseFloat(m[1]); }
            else if ((m = /^target_fps=(.*)$/.exec(lines[i]))) { tgIdx = i; tgFps = parseFloat(m[1]); }
        }
        var outDir = path.join(job._dir, 'out').replace(/\//g, '\\').replace(/\\/g, '\\\\');
        if (outIdx >= 0) { lines[outIdx] = 'output_dir=' + outDir; }
        else { jobLog(job, 'WARNING: output_dir not found in the preset.'); }

        // Mantiene la proporcion del preset (p.ej. 23.976 -> 191.808 = x8) pero con los fps reales de la comp
        if (job.fps && inIdx >= 0 && tgIdx >= 0 && inFps > 0 && tgFps > 0) {
            var ratio = tgFps / inFps;
            lines[inIdx] = 'input_fps=' + job.fps.toFixed(6);
            lines[tgIdx] = 'target_fps=' + (job.fps * ratio).toFixed(6);
        }
        var dst = path.join(job._dir, 'preset.ini');
        fs.writeFileSync(dst, lines.join(nl), 'utf8');
        return dst;
    }

    // ------------------------------------------------------------------ ejecucion de SVFI
    function fail(cfg, id, msg) {
        var job = update(cfg, id, { status: 'error', error: msg, finishedAt: now(), pid: null });
        if (job) { jobLog(job, 'ERROR: ' + msg); }
        current = null;
    }

    function start(cfg, job) {
        var outDir = path.join(job._dir, 'out'), preset, child, env, svfiDir;
        if (!cfg.svfiPath || !SVFI.exists(cfg.svfiPath)) { return fail(cfg, job.id, 'SVFI not found. Set the path to one_line_shot_args.exe in Settings.'); }
        if (!SVFI.exists(cfg.presetPath)) { return fail(cfg, job.id, 'Preset .ini not found: ' + cfg.presetPath); }
        if (!SVFI.exists(job.input)) { return fail(cfg, job.id, 'Rendered file not found: ' + job.input); }

        SVFI.rmrf(outDir);
        SVFI.ensureDir(outDir);
        try { preset = buildPreset(cfg, job); } catch (eP) { return fail(cfg, job.id, 'Could not prepare the preset: ' + eP.message); }

        svfiDir = path.dirname(cfg.svfiPath);
        env = {};
        for (var k in process.env) { if (process.env.hasOwnProperty(k)) { env[k] = process.env[k]; } }
        env.PATH = svfiDir + path.delimiter + (env.PATH || env.Path || '');

        var args = ['-i', job.input, '--config', preset, '-t', 'ae_task'];
        jobLog(job, 'COMMAND: "' + cfg.svfiPath + '" ' + args.map(function (a) { return /\s/.test(a) ? '"' + a + '"' : a; }).join(' '));

        try {
            child = cp.spawn(cfg.svfiPath, args, { cwd: svfiDir, env: env, windowsHide: true });
        } catch (eS) { return fail(cfg, job.id, 'Could not start SVFI: ' + eS.message); }

        current = { id: job.id, child: child, pid: child.pid, phase: 'running', exitCode: null, startedAt: now() };
        update(cfg, job.id, { status: 'processing', pid: child.pid, startedAt: current.startedAt, error: '', lastLine: 'Starting SVFI...' });

        var dir = job._dir;
        function patchDir(patch) {
            var j = SVFI.readJSON(path.join(dir, 'job.json')), k;
            if (!j || j.id !== job.id) { return; }
            j._dir = dir;
            for (k in patch) { if (patch.hasOwnProperty(k)) { j[k] = patch[k]; } }
            SVFI.saveJob(j);
        }
        function onData(d) {
            var txt = String(d);
            try { fs.appendFileSync(path.join(dir, 'svfi_log.txt'), txt, 'utf8'); } catch (e) { }
            var parts = txt.split(/[\r\n]+/).filter(function (s) { return s.replace(/\s/g, '').length > 0; });
            if (parts.length && now() - lastLineSaved > 2000 && current && current.id === job.id) {
                lastLineSaved = now();
                patchDir({ lastLine: parts[parts.length - 1].slice(0, 160) });
            }
        }
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', function (e) {
            if (current && current.id === job.id) { fail(SVFI.readConfig(), job.id, 'SVFI error: ' + e.message); }
        });
        child.on('exit', function (code) {
            if (!current || current.id !== job.id) { return; }
            current.phase = 'waiting';
            current.exitCode = code;
            current.waitFrom = now();
            var j = update(SVFI.readConfig(), job.id, { exitCode: code, pid: null, lastLine: 'SVFI finished, waiting for the output file...' });
            if (j) { jobLog(j, 'SVFI exit code: ' + code); }
        });
    }

    // Nombre limpio para el proyecto (Solid_SVFI.mov) y fuera la carpeta de proyecto que deja SVFI
    function tidyResult(job, file) {
        var dir = path.dirname(file), ext = path.extname(file), base = SVFI.sanitize(job.name) + '_SVFI';
        var dst = path.join(dir, base + ext), n = 2, names, i;
        while (SVFI.exists(dst) && dst !== file) { dst = path.join(dir, base + '_' + (n++) + ext); }
        try { if (dst !== file) { fs.renameSync(file, dst); } } catch (e) { dst = file; }
        try { names = fs.readdirSync(dir); } catch (e2) { names = []; }
        for (i = 0; i < names.length; i++) {
            if (path.join(dir, names[i]) !== dst) { SVFI.rmrf(path.join(dir, names[i])); }
        }
        return dst;
    }

    // Trabajo que quedo "processing" de una sesion anterior de AE
    function adopt(cfg, job) {
        current = { id: job.id, child: null, pid: job.pid, phase: 'adopted', exitCode: null, startedAt: job.startedAt || now() };
        jobLog(job, 'Resuming after After Effects restart (pid ' + job.pid + ').');
    }

    function monitor(cfg) {
        var job = findJob(cfg, current.id);
        if (!job) { if (current.pid) { killTree(current.pid); } current = null; return; }

        if (current.phase === 'running' || current.phase === 'adopted') {
            if (now() - current.startedAt > cfg.maxMinutes * 60000) {
                killTree(current.pid);
                return fail(cfg, job.id, 'SVFI took more than ' + cfg.maxMinutes + ' minutes. Aborted.');
            }
            if (current.phase === 'adopted' && !isAlive(current.pid)) {
                current.phase = 'waiting';
                current.waitFrom = now();
                update(cfg, job.id, { pid: null });
            }
            return;
        }

        // waiting: buscar el video final y esperar a que deje de crecer
        var vids = findVideos(path.join(job._dir, 'out'));
        if (vids.length) {
            vids.sort(function (a, b) { return b.mtime - a.mtime; });
            var v = vids[0];
            if (current.lastPath === v.path && current.lastSize === v.size) {
                if (now() - current.sizeSince >= RESULT_SETTLE_MS) {
                    var res = tidyResult(job, v.path);
                    update(cfg, job.id, { status: 'done', result: res, finishedAt: now(), lastLine: '' });
                    jobLog(job, 'Result: ' + res + ' (' + v.size + ' bytes)');
                    current = null;
                    return;
                }
            } else {
                current.lastPath = v.path;
                current.lastSize = v.size;
                current.sizeSince = now();
            }
        }
        var limit = (current.exitCode === 0 || current.exitCode === null) ? WAIT_AFTER_OK_MS : WAIT_AFTER_FAIL_MS;
        if (now() - current.waitFrom > limit) {
            fail(cfg, job.id, 'SVFI ended (exit code ' + current.exitCode + ') without producing a video. See svfi_log.txt.');
        }
    }

    // ------------------------------------------------------------------ importacion en AE
    function doImport(cfg, job) {
        importing = { id: job.id, at: now() };
        SVFI.evalHost('svfi_import', {
            file: job.result, compId: job.compId, compName: job.compName,
            layerId: job.layerId, layerIndex: job.layerIndex, layerName: job.layerName,
            inPoint: job.inPoint, deleteOriginal: cfg.deleteOriginal, folderName: 'SVFI Results',
            pending: SVFI.pendingRestores(SVFI.listJobs(cfg))
        }, function (out) {
            if (!importing || importing.id !== job.id) { return; }
            importing = null;
            var c = SVFI.readConfig();
            if (!out || (!out.ok && out.retry)) {
                var b = backoff[job.id] || { tries: 0 };
                b.tries += 1;
                b.next = now() + Math.min(60000, 3000 * Math.pow(2, Math.min(b.tries, 5)));
                backoff[job.id] = b;
                update(c, job.id, { importNote: 'After Effects is busy (dialog open?), retrying...' });
                return;
            }
            delete backoff[job.id];
            if (out.ok) {
                update(c, job.id, { status: 'imported', importedAt: now(), importNote: out.note || '', importRequested: false });
            } else {
                update(c, job.id, { status: 'error', error: 'Import failed: ' + out.error, importRequested: false });
            }
        });
    }

    // ------------------------------------------------------------------ render en AE
    // El trabajo nace en 'rendering'. Pasa a 'queued' solo cuando AE escribio render_status.json
    // (render terminado y Solo/render queue restaurados) y el archivo ya no crece.
    function checkRender(cfg, job) {
        var sp = path.join(job._dir, 'render_status.json');
        var st = SVFI.readJSON(sp);
        if (st) {
            if (!st.ok) {
                job.status = 'error'; job.error = st.error || 'After Effects render failed.'; job.finishedAt = now();
                SVFI.saveJob(job);
                jobLog(job, 'AE render: ' + job.error);
                return;
            }
            var size = -1;
            try { size = fs.statSync(job.input).size; } catch (e) { }
            if (size <= 0) {
                job.status = 'error'; job.error = 'After Effects did not produce the render file.'; job.finishedAt = now();
                SVFI.saveJob(job);
                return;
            }
            // render_status.json solo existe cuando AE ya termino y restauro todo
            delete renderSizes[job.id];
            job.status = 'queued'; job.renderedAt = now();
            SVFI.saveJob(job);
            jobLog(job, 'AE render finished: ' + job.input + ' (' + size + ' bytes)');
            return;
        }
        // Sin hablar con AE mientras renderiza: se mira el archivo.
        // Un .mov queda "cerrado" cuando AE escribe el indice (moov) al final y el archivo deja de crecer.
        var sz = -1;
        try { sz = fs.statSync(job.input).size; } catch (e2) { }
        var q = renderSizes[job.id];
        if (!q || q.size !== sz) { q = renderSizes[job.id] = { size: sz, since: now() }; }
        var stable = now() - q.since, ready;
        if (sz > 0) {
            var mv = movState(job.input);
            ready = (mv === 'complete' && stable >= MOV_SETTLE_MS) ||
                    (mv === 'unknown' && stable >= OTHER_SETTLE_MS) ||
                    stable >= STALL_MS;
        } else {
            ready = now() - (job.renderStartedAt || job.createdAt) >= STALL_MS;   // AE nunca creo el archivo (render cancelado o fallido)
        }
        if (ready && !renderPoll.busy && now() - renderPoll.at > POLL_GAP_MS) {
            renderPoll.busy = true;
            var lastOfBatch = !SVFI.listJobs(cfg).some(function (x) { return x.status === 'pendingRender'; });
            SVFI.evalHost('svfi_renderPoll', { dir: job._dir.replace(/\\/g, '/'), focus: lastOfBatch }, function (out) {
                renderPoll.busy = false;
                renderPoll.at = now();
                if (out && out.finished) {
                    var j = findJob(SVFI.readConfig(), job.id);
                    if (j && j.status === 'rendering') { checkRender(SVFI.readConfig(), j); }
                }
            });
        }
    }

    // 'complete' = todas las cajas de primer nivel cierran justo al final y hay moov
    // 'incomplete' = todavia escribiendose; 'unknown' = no parece un QuickTime/MP4
    function movState(file) {
        var fd, size, off = 0, buf = Buffer.alloc ? Buffer.alloc(16) : new Buffer(16), n, len, type, moov = false, guard = 0;
        var KNOWN = { ftyp: 1, wide: 1, mdat: 1, moov: 1, free: 1, skip: 1, uuid: 1, pnot: 1, meta: 1 };
        try {
            fd = fs.openSync(file, 'r');
            size = fs.fstatSync(fd).size;
            while (off < size && guard++ < 10000) {
                n = fs.readSync(fd, buf, 0, 16, off);
                if (n < 8) { return 'incomplete'; }
                len = buf.readUInt32BE(0);
                type = buf.toString('latin1', 4, 8);
                if (off === 0 && !KNOWN[type]) { return 'unknown'; }
                if (len === 1) {
                    if (n < 16) { return 'incomplete'; }
                    len = buf.readUInt32BE(8) * 4294967296 + buf.readUInt32BE(12);
                } else if (len === 0) {
                    return 'incomplete';          // caja abierta hasta el final: AE sigue escribiendo
                }
                if (len < 8) { return 'unknown'; }
                if (type === 'moov') { moov = true; }
                off += len;
            }
            return (off === size && moov) ? 'complete' : 'incomplete';
        } catch (e) {
            return 'unknown';
        } finally {
            try { if (fd !== undefined) { fs.closeSync(fd); } } catch (e3) { }
        }
    }

    // Renders en espera: el panel crea un trabajo 'pendingRender' por capa seleccionada y el servicio
    // los lanza uno tras otro, siempre cuando AE ya no esta renderizando.
    var renderStart = { busy: false, next: 0, tries: {} };
    function startRender(cfg, job) {
        renderStart.busy = true;
        SVFI.evalHost('svfi_render', {
            outDir: job._dir.replace(/\\/g, '/'), template: cfg.template || 'Clips RIFE',
            compId: job.compId, compName: job.compName,
            layerId: job.layerId, layerIndex: job.layerIndex, layerName: job.layerName,
            pending: SVFI.pendingRestores(SVFI.listJobs(cfg))
        }, function (out) {
            renderStart.busy = false;
            var c = SVFI.readConfig(), j = findJob(c, job.id), t;
            if (!j || j.status !== 'pendingRender') { return; }
            if (!out || (!out.ok && out.retry)) {
                t = (renderStart.tries[job.id] || 0) + 1;
                renderStart.tries[job.id] = t;
                renderStart.next = now() + Math.min(10000, 500 * t);
                return;
            }
            delete renderStart.tries[job.id];
            if (!out.ok) {
                j.status = 'error'; j.error = out.error; j.finishedAt = now();
                SVFI.saveJob(j);
                return;
            }
            j.status = 'rendering'; j.renderStartedAt = now();
            j.input = path.normalize(out.input); j.fps = out.fps; j.duration = out.duration;
            j.inPoint = out.inPoint; j.layerIndex = out.layerIndex; j.layerId = out.layerId; j.layerName = out.layerName;
            SVFI.saveJob(j);
            jobLog(j, 'AE render started: ' + j.input);
        });
    }

    // ------------------------------------------------------------------ pedidos del panel
    function archive(job) {
        // Lo importado queda referenciado en el proyecto: se conserva out/, se borra el resto
        var keepOut = job.status === 'imported' || job.status === 'done';
        var names = [], i;
        try { names = fs.readdirSync(job._dir); } catch (e) { }
        for (i = 0; i < names.length; i++) {
            if (names[i] === 'job.json' || (keepOut && names[i] === 'out')) { continue; }
            SVFI.rmrf(path.join(job._dir, names[i]));
        }
        if (!keepOut) { SVFI.rmrf(job._dir); return; }
        job.archived = true;
        SVFI.saveJob(job);
    }

    function handleRequest(cfg, job) {
        var rp = path.join(job._dir, 'request.json');
        if (!SVFI.exists(rp)) { return; }
        var r = SVFI.readJSON(rp);
        try { fs.unlinkSync(rp); } catch (e) { }
        if (!r) { return; }

        if (r.action === 'cancel') {
            if (current && current.id === job.id) {
                killTree(current.pid);
                current = null;
            }
            if (job.status === 'queued' || job.status === 'processing' || job.status === 'rendering' || job.status === 'pendingRender') {
                job.status = 'cancelled'; job.pid = null; job.finishedAt = now();
                SVFI.saveJob(job);
                jobLog(job, 'Cancelled by the user.');
            }
        } else if (r.action === 'retry') {
            if (job.status === 'error' || job.status === 'cancelled') {
                job.status = 'queued'; job.error = ''; job.result = null; job.importNote = ''; job.lastLine = '';
                SVFI.saveJob(job);
                delete backoff[job.id];
            }
        } else if (r.action === 'import') {
            if (job.status === 'done') { job.importRequested = true; SVFI.saveJob(job); delete backoff[job.id]; }
        } else if (r.action === 'archive') {
            if (job.status !== 'queued' && job.status !== 'processing' && job.status !== 'rendering' && job.status !== 'pendingRender') { archive(job); }
        }
    }

    // ------------------------------------------------------------------ bucle principal
    function tick() {
        var cfg = SVFI.readConfig(), jobs, i, j;
        lastError = '';
        if (cfg.workFolder) {
            jobs = SVFI.listJobs(cfg);
            for (i = 0; i < jobs.length; i++) { handleRequest(cfg, jobs[i]); }
            jobs = SVFI.listJobs(cfg);
            fastMode = !!(current && current.phase === 'waiting');
            var anyRendering = false;
            for (i = 0; i < jobs.length; i++) {
                if (jobs[i].status === 'rendering') { fastMode = true; anyRendering = true; checkRender(cfg, jobs[i]); }
                else if (jobs[i].status === 'pendingRender') { fastMode = true; }
            }
            jobs = SVFI.listJobs(cfg);
            anyRendering = jobs.some(function (x) { return x.status === 'rendering'; });
            if (!anyRendering && !renderStart.busy && !importing && !renderPoll.busy && now() >= renderStart.next) {
                for (i = 0; i < jobs.length; i++) {
                    if (jobs[i].status === 'pendingRender') { startRender(cfg, jobs[i]); break; }
                }
            }

            if (current) { monitor(cfg); jobs = SVFI.listJobs(cfg); }
            if (!current) {
                for (i = 0; i < jobs.length && !current; i++) {
                    if (jobs[i].status === 'processing') {
                        if (jobs[i].pid && isAlive(jobs[i].pid)) { adopt(cfg, jobs[i]); }
                        else { current = { id: jobs[i].id, pid: null, phase: 'waiting', exitCode: null, waitFrom: now(), startedAt: now() }; }
                    }
                }
                for (i = 0; i < jobs.length && !current; i++) {
                    if (jobs[i].status === 'queued') { start(cfg, jobs[i]); }
                }
            }

            if (importing && now() - importing.at > IMPORT_TIMEOUT_MS) { importing = null; }
            var aeRendering = renderStart.busy || renderPoll.busy || jobs.some(function (x) { return x.status === 'rendering'; });
            if (!importing && !aeRendering) {
                for (i = 0; i < jobs.length; i++) {
                    j = jobs[i];
                    if (j.status !== 'done' || !(cfg.autoImport || j.importRequested)) { continue; }
                    if (backoff[j.id] && now() < backoff[j.id].next) { continue; }
                    doImport(cfg, j);
                    break;
                }
            }
        }
        SVFI.writeJSON(SVFI.SERVICE_PATH, {
            service: 'SVFI Pipeline Service', version: SVFI.VERSION, beat: now(),
            current: current ? current.id : null, error: lastError
        });
    }

    function loop() {
        try { tick(); } catch (e) { lastError = String(e); try { console.error('[SVFI] ' + e.stack); } catch (e2) { } }
        setTimeout(loop, fastMode ? FAST_TICK_MS : TICK_MS);
    }

    // El lanzador SVFI_Pipeline.jsx (p.ej. desde NyaUIPanel) pide abrir el panel con este evento
    try {
        window.__adobe_cep__.addEventListener(SVFI.EVT_OPEN_PANEL, function () {
            try { window.__adobe_cep__.requestOpenExtension(SVFI.EXT_PANEL, ''); } catch (e) { }
        });
    } catch (eEv) { }

    console.log('[SVFI] service v' + SVFI.VERSION + ' data = ' + SVFI.DATA_DIR);
    setTimeout(loop, 3000);   // deja que AE termine de arrancar
})();
