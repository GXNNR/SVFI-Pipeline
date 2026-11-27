/*
 * SVFI Pipeline - utilidades compartidas por el panel y el servicio (Node + CEP)
 *
 * Reparto de escritura (un solo dueno por archivo, sin choques):
 *   config.json       -> lo escribe el panel, el servicio solo lo lee
 *   service.json      -> lo escribe el servicio (latido + estado)
 *   jobs/<id>/job.json-> lo crea el panel; despues solo lo modifica el servicio
 *   jobs/<id>/request.json -> lo escribe el panel (cancelar, reintentar, importar, limpiar); el servicio lo consume y lo borra
 */
var SVFI = (function () {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');

    var VERSION = '2.0.0';
    var EXT_PANEL = 'com.gxnnr.svfipipeline.panel';
    var EXT_SERVICE = 'com.gxnnr.svfipipeline.service';
    var EVT_OPEN_PANEL = 'com.gxnnr.svfipipeline.openPanel';
    var JOBS_FOLDER = 'SVFI_jobs';
    var VIDEO_EXT = { '.mov': 1, '.mp4': 1, '.avi': 1, '.mkv': 1 };

    function exists(p) { try { return !!p && fs.existsSync(p); } catch (e) { return false; } }

    // Sin { recursive } para que funcione tambien con el Node 8 de CEP 9
    function ensureDir(p) {
        if (exists(p)) { return p; }
        ensureDir(path.dirname(p));
        try { fs.mkdirSync(p); } catch (e) { if (!exists(p)) { throw e; } }
        return p;
    }

    function sysPath(type) {
        try {
            var p = decodeURI(window.__adobe_cep__.getSystemPath(type));
            p = (process.platform === 'win32') ? p.replace('file:///', '') : p.replace('file://', '');
            return path.normalize(p);
        } catch (e) { return null; }
    }

    function documentsDir() {
        var d = sysPath('myDocuments');
        if (d && exists(d)) { return d; }
        return path.join(os.homedir(), 'Documents');
    }

    var EXT_DIR = sysPath('extension') || path.join(__dirname, '..');
    var DATA_DIR = ensureDir(path.join(documentsDir(), 'SVFIPipeline'));
    var CONFIG_PATH = path.join(DATA_DIR, 'config.json');
    var SERVICE_PATH = path.join(DATA_DIR, 'service.json');
    var BUNDLED_PRESET = path.join(EXT_DIR, 'preset', 'mi_preset_svfi.ini');

    function readJSON(p) {
        try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
    }

    // Escritura atomica: tmp + rename (si Windows bloquea el rename, escribe directo)
    function writeJSON(p, obj) {
        var txt = JSON.stringify(obj, null, 2);
        var tmp = p + '.tmp';
        try {
            fs.writeFileSync(tmp, txt, 'utf8');
            fs.renameSync(tmp, p);
        } catch (e) {
            try { fs.writeFileSync(p, txt, 'utf8'); } catch (e2) { }
            try { fs.unlinkSync(tmp); } catch (e3) { }
        }
    }

    function defaults() {
        return {
            workFolder: '',
            svfiPath: '',
            presetPath: BUNDLED_PRESET,
            template: 'Clips RIFE',
            autoImport: true,
            deleteOriginal: true,
            maxMinutes: 120
        };
    }

    function readConfig() {
        var c = defaults(), saved = readJSON(CONFIG_PATH), k;
        if (saved) { for (k in saved) { if (saved.hasOwnProperty(k) && c.hasOwnProperty(k)) { c[k] = saved[k]; } } }
        else {
            // Migracion desde el panel ScriptUI anterior (Documents/SVFIPanel/config.json)
            var old = readJSON(path.join(documentsDir(), 'SVFIPanel', 'config.json'));
            if (old && old.ultimaCarpeta) { c.workFolder = path.normalize(old.ultimaCarpeta); }
            var sv = 'D:\\SteamLibrary\\steamapps\\common\\SVFI\\one_line_shot_args.exe';
            if (exists(sv)) { c.svfiPath = sv; }
        }
        if (!c.presetPath || !exists(c.presetPath)) { c.presetPath = BUNDLED_PRESET; }
        return c;
    }

    function writeConfig(patch) {
        var c = readConfig(), k;
        for (k in patch) { if (patch.hasOwnProperty(k)) { c[k] = patch[k]; } }
        writeJSON(CONFIG_PATH, c);
        return c;
    }

    function jobsDir(cfg) { return cfg.workFolder ? path.join(cfg.workFolder, JOBS_FOLDER) : null; }

    function listJobs(cfg) {
        var root = jobsDir(cfg), out = [], names, i, j;
        if (!root || !exists(root)) { return out; }
        try { names = fs.readdirSync(root); } catch (e) { return out; }
        for (i = 0; i < names.length; i++) {
            j = readJSON(path.join(root, names[i], 'job.json'));
            if (j && j.id) { j._dir = path.join(root, names[i]); out.push(j); }
        }
        out.sort(function (a, b) { return a.createdAt - b.createdAt; });
        return out;
    }

    function saveJob(job) {
        var copy = {}, k;
        for (k in job) { if (job.hasOwnProperty(k) && k.charAt(0) !== '_') { copy[k] = job[k]; } }
        writeJSON(path.join(job._dir, 'job.json'), copy);
    }

    function newJobId() {
        var d = new Date();
        function p2(n) { return (n < 10 ? '0' : '') + n; }
        return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' +
            p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-' +
            Math.random().toString(36).slice(2, 6);
    }

    function sanitize(name) {
        var s = String(name || 'clip').replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
        return s.slice(0, 60) || 'clip';
    }

    function request(job, action) {
        writeJSON(path.join(job._dir, 'request.json'), { action: action, at: Date.now() });
    }

    // Llama a una funcion de host.jsx con un objeto como argumento; cb(resultadoParseado, textoCrudo)
    function evalHost(fn, args, cb) {
        var script = fn + '(' + JSON.stringify(JSON.stringify(args || {})) + ')';
        window.__adobe_cep__.evalScript(script, function (res) {
            var out = null;
            try { out = JSON.parse(res); } catch (e) { }
            if (cb) { cb(out, res); }
        });
    }

    function serviceStatus() {
        var s = readJSON(SERVICE_PATH);
        if (!s || !s.beat) { return { alive: false }; }
        s.alive = (Date.now() - s.beat) < 10000;
        return s;
    }

    // Trabajos cuyo render termino pero a los que AE todavia no les quito el item de la render queue
    function pendingRestores(jobs) {
        var out = [], i;
        for (i = 0; i < jobs.length; i++) {
            if (exists(path.join(jobs[i]._dir, 'render_state.json')) && exists(path.join(jobs[i]._dir, 'render_status.json'))) {
                out.push(jobs[i]._dir.replace(/\\/g, '/'));
            }
        }
        return out;
    }

    function rmrf(p) {
        var st, names, i;
        try { st = fs.lstatSync(p); } catch (e) { return; }
        if (st.isDirectory()) {
            try { names = fs.readdirSync(p); } catch (e2) { names = []; }
            for (i = 0; i < names.length; i++) { rmrf(path.join(p, names[i])); }
            try { fs.rmdirSync(p); } catch (e3) { }
        } else {
            try { fs.unlinkSync(p); } catch (e4) { }
        }
    }

    return {
        VERSION: VERSION, EXT_PANEL: EXT_PANEL, EXT_SERVICE: EXT_SERVICE, EVT_OPEN_PANEL: EVT_OPEN_PANEL,
        VIDEO_EXT: VIDEO_EXT, DATA_DIR: DATA_DIR, EXT_DIR: EXT_DIR, BUNDLED_PRESET: BUNDLED_PRESET,
        CONFIG_PATH: CONFIG_PATH, SERVICE_PATH: SERVICE_PATH,
        exists: exists, ensureDir: ensureDir, readJSON: readJSON, writeJSON: writeJSON, rmrf: rmrf,
        readConfig: readConfig, writeConfig: writeConfig, jobsDir: jobsDir, listJobs: listJobs,
        saveJob: saveJob, newJobId: newJobId, sanitize: sanitize, request: request,
        evalHost: evalHost, serviceStatus: serviceStatus, pendingRestores: pendingRestores
    };
})();
