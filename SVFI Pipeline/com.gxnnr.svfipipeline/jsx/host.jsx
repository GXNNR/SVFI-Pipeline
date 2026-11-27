/*
 * SVFI Pipeline - lado After Effects (ExtendScript, ES3)
 * Lo cargan el panel y el servicio, cada uno en su propio motor.
 * Solo se ejecuta cuando el panel pulsa un boton o el servicio tiene un resultado listo.
 */

function svfi__q(s) {
    return '"' + String(s)
        .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
}

function svfi__str(v) {
    var t = typeof v, i, parts;
    if (v === null || v === undefined) { return 'null'; }
    if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
    if (t === 'boolean') { return v ? 'true' : 'false'; }
    if (t === 'string') { return svfi__q(v); }
    if (v instanceof Array) {
        parts = [];
        for (i = 0; i < v.length; i++) { parts.push(svfi__str(v[i])); }
        return '[' + parts.join(',') + ']';
    }
    parts = [];
    for (i in v) {
        if (v.hasOwnProperty(i)) { parts.push(svfi__q(i) + ':' + svfi__str(v[i])); }
    }
    return '{' + parts.join(',') + '}';
}

function svfi__parse(s) { return eval('(' + s + ')'); }

function svfi__safeName(n) {
    var s = String(n || 'clip').replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
    return s.substring(0, 60) || 'clip';
}

function svfi__layerId(L) {
    var id = null;
    try { id = L.id; } catch (e) { }
    return (typeof id === 'number') ? id : null;
}

// ------------------------------------------------------------------ archivos de estado
function svfi__writeFile(path, txt) {
    var f = new File(path);
    f.encoding = 'UTF-8';
    if (!f.open('w')) { return false; }
    f.write(txt);
    f.close();
    return true;
}

function svfi__readFile(path) {
    var f = new File(path), t;
    if (!f.exists) { return null; }
    f.encoding = 'UTF-8';
    if (!f.open('r')) { return null; }
    t = f.read();
    f.close();
    return t;
}

// ------------------------------------------------------------------ seleccion
// Lee las capas seleccionadas (rapido, no renderiza). El panel crea un trabajo por capa
// y el servicio las renderiza una tras otra.
function svfi_selection() {
    var comp = app.project.activeItem, sel, i, L, layers = [], skipped = [];
    if (app.project.renderQueue.rendering) { return svfi__str({ ok: false, error: 'After Effects is rendering. Wait a moment.' }); }
    if (!(comp instanceof CompItem)) { return svfi__str({ ok: false, error: 'Open a composition and select the layers to process.' }); }
    sel = comp.selectedLayers;
    if (!sel.length) { return svfi__str({ ok: false, error: 'Select one or more layers.' }); }
    for (i = 0; i < sel.length; i++) {
        L = sel[i];
        if (!(L instanceof AVLayer)) { skipped.push(L.name + ' (no image)'); continue; }
        if (!L.enabled) { skipped.push(L.name + ' (hidden)'); continue; }
        if (Math.min(L.outPoint, comp.duration) - Math.max(L.inPoint, 0) < comp.frameDuration) { skipped.push(L.name + ' (outside comp time)'); continue; }
        layers.push({ layerId: svfi__layerId(L), layerIndex: L.index, layerName: L.name });
    }
    layers.sort(function (x, y) { return x.layerIndex - y.layerIndex; });
    return svfi__str({ ok: true, compId: comp.id, compName: comp.name, layers: layers, skipped: skipped });
}

// ------------------------------------------------------------------ render
// Renderiza una capa tal como se ve en la comp:
// Solo temporal + rango del render = in/out de la capa. El Work Area no se toca.
// Usa renderAsync() (no bloquea la interfaz de AE). Cuando el servicio ve el archivo terminado,
// llama a svfi_renderPoll -> svfi__finish(): restaura todo y escribe render_status.json.
function svfi_render(argsStr) {
    var a, comp, L, fd, start, end, idx, n, i, X, s;
    var solo = [], rqFlags = [], rq, rqItem = null, om, outPath = null, err = null, state, async = false;
    try { a = svfi__parse(argsStr); } catch (eA) { return svfi__str({ ok: false, error: 'Bad arguments.' }); }

    rq = app.project.renderQueue;
    if (rq.rendering) { return svfi__str({ ok: false, retry: true, error: 'After Effects is already rendering.' }); }
    svfi__finishPending(a.pending);

    comp = svfi__findComp(a.compId, a.compName);
    if (!comp) { return svfi__str({ ok: false, error: 'Composition not found.' }); }
    L = svfi__findLayer(comp, a);
    if (!L) { return svfi__str({ ok: false, error: 'Layer "' + a.layerName + '" not found.' }); }
    if (!(L instanceof AVLayer)) { return svfi__str({ ok: false, error: 'The layer has no image (camera, light or null?).' }); }
    if (!L.enabled) { return svfi__str({ ok: false, error: 'The layer is hidden (video switch off).' }); }

    fd = comp.frameDuration;
    // Rango en frames enteros de la comp. Los tiempos en segundos (p.ej. 48 f a 23.976 = 2.0020020...)
    // no son exactos: si quedan una milesima antes, AE renderiza un frame de mas (negro, sin la capa)
    // al inicio o al final, y SVFI lo interpola como un fundido.
    var sf = Math.round(Math.max(L.inPoint, 0) / fd);
    var ef = Math.round(Math.min(L.outPoint, comp.duration) / fd);
    if (ef - sf < 1) { return svfi__str({ ok: false, error: 'The layer is outside the composition time range.' }); }
    start = sf * fd;
    end = ef * fd;

    idx = L.index;
    n = comp.numLayers;

    app.beginUndoGroup('SVFI Pipeline: render');
    try {
        for (i = 1; i <= n; i++) {
            s = null;
            X = comp.layer(i);
            try { s = X.solo; } catch (eS) { }
            if (typeof s === 'boolean') { solo.push({ i: i, id: svfi__layerId(X), v: s }); }
        }
        for (i = 0; i < solo.length; i++) {
            X = comp.layer(solo[i].i);
            try { if (X.solo !== (solo[i].i === idx)) { X.solo = (solo[i].i === idx); } } catch (eS2) { }
        }

        // Que el render no se lleve otros items que el usuario tenga en cola
        for (i = 1; i <= rq.numItems; i++) {
            X = rq.item(i);
            if (X.status === RQItemStatus.QUEUED) {
                try { X.render = false; rqFlags.push(i); } catch (eR) { }
            }
        }

        rqItem = rq.items.add(comp);
        // Un poco hacia dentro del primer y del ultimo frame, para que AE no redondee hacia afuera
        rqItem.timeSpanStart = start + fd * 0.01;
        rqItem.timeSpanDuration = (end - start) - fd * 0.02;
        om = rqItem.outputModule(1);
        try { om.applyTemplate(a.template); }
        catch (eT) { throw new Error('Output module template "' + a.template + '" not found. Create it in Edit > Templates > Output Module.'); }
        om.file = new File(a.outDir + '/' + svfi__safeName(L.name) + '.mov');
        outPath = om.file.fsName;

        state = { compId: comp.id, solo: solo, rqFlags: rqFlags, outPath: outPath };
        if (!svfi__writeFile(a.outDir + '/render_state.json', svfi__str(state))) {
            throw new Error('Could not write to the job folder: ' + a.outDir);
        }
    } catch (e) {
        err = e.message || e.toString();
    }
    app.endUndoGroup();

    if (err) {
        try { if (rqItem) { rqItem.remove(); } } catch (eRm) { }
        svfi__restore(comp, solo, rqFlags);
        try { new File(a.outDir + '/render_state.json').remove(); } catch (eDel) { }
        return svfi__str({ ok: false, error: err });
    }

    var dir = a.outDir;
    // Sin onStatusChanged: AE lo intenta ejecutar mientras sigue en modo render (modal) y lo rechaza.
    // El final del render lo detecta el servicio leyendo el archivo; despues llama a svfi_renderPoll.
    try {
        if (typeof rq.renderAsync === 'function') { rq.renderAsync(); async = true; }
    } catch (eAs) { async = false; }
    if (!async) {
        // AE sin renderAsync: render bloqueante como en la version anterior
        try { rq.render(); } catch (eRn) { }
        try { svfi__finish(dir, false); } catch (eFin2) { }
    }

    return svfi__str({
        ok: true, async: async, input: outPath,
        compId: comp.id, compName: comp.name,
        layerId: svfi__layerId(L), layerIndex: idx, layerName: L.name,
        inPoint: start, duration: end - start, fps: comp.frameRate
    });
}

function svfi__restore(comp, solo, rqFlags) {
    var i, X, rq = app.project.renderQueue;
    for (i = 0; i < rqFlags.length; i++) {
        try { if (rqFlags[i] <= rq.numItems) { rq.item(rqFlags[i]).render = true; } } catch (eF) { }
    }
    if (!comp) { return; }
    for (i = 0; i < solo.length; i++) {
        try {
            X = null;
            if (solo[i].i <= comp.numLayers) { X = comp.layer(solo[i].i); }
            if (X && solo[i].id !== null && svfi__layerId(X) !== solo[i].id) { X = null; }
            if (X && X.solo !== solo[i].v) { X.solo = solo[i].v; }
        } catch (eS) { }
    }
}

function svfi__findRqItem(outPath) {
    var rq = app.project.renderQueue, i, it, f;
    for (i = rq.numItems; i >= 1; i--) {
        it = rq.item(i);
        try { f = it.outputModule(1).file; } catch (e) { f = null; }
        if (f && f.fsName === outPath) { return it; }
    }
    return null;
}

// Termina un render. Primero escribe render_status.json (solo E/S de archivos, para que el servicio
// nunca tenga que preguntarle nada a AE). Luego restaura Solo y render queue.
// Desde el callback de AE (render recien terminado) no se quita el item de la render queue:
// eso queda pendiente y lo completa la siguiente llamada normal (otro render o una importacion).
// Devuelve false si el render todavia no termino.
function svfi__finish(dir, fromCallback, focus) {
    var txt = svfi__readFile(dir + '/render_state.json'), state, it, st, ok, error = '', done = true, comp, i, X;
    if (txt === null) { return true; }
    state = svfi__parse(txt);
    if (!fromCallback && app.project.renderQueue.rendering) { return false; }
    it = svfi__findRqItem(state.outPath);
    st = it ? it.status : null;
    if (st === RQItemStatus.RENDERING || st === RQItemStatus.QUEUED) { return false; }

    if (!state.statusWritten) {
        ok = (st === RQItemStatus.DONE || it === null) && new File(state.outPath).exists;
        if (!ok) { error = (st === RQItemStatus.USER_STOPPED) ? 'Render stopped in After Effects.' : 'After Effects render failed.'; }
        svfi__writeFile(dir + '/render_status.json', svfi__str({ ok: ok, error: error, at: new Date().getTime() }));
        state.statusWritten = true;
    }

    comp = svfi__findComp(state.compId, null);
    app.beginUndoGroup('SVFI Pipeline: restore');
    svfi__restore(comp, state.solo || [], state.rqFlags || []);
    if (!fromCallback) { try { if (it) { it.remove(); it = null; } } catch (eRm) { } }
    app.endUndoGroup();

    // Al terminar el ultimo render del lote, volver de la Render Queue a la comp
    if (focus && comp) { try { comp.openInViewer(); } catch (eV) { } }

    // Comprobar que todo quedo como estaba
    if (it) { done = false; }
    if (comp) {
        for (i = 0; i < (state.solo || []).length; i++) {
            try {
                X = comp.layer(state.solo[i].i);
                if (X && X.solo !== state.solo[i].v && (state.solo[i].id === null || svfi__layerId(X) === state.solo[i].id)) { done = false; }
            } catch (eChk) { }
        }
    }
    if (done) { try { new File(dir + '/render_state.json').remove(); } catch (eDel) { } }
    else { svfi__writeFile(dir + '/render_state.json', svfi__str(state)); }
    return true;
}

// Completa restauraciones pendientes (solo se llama cuando AE no esta renderizando)
function svfi__finishPending(list) {
    var i;
    if (!list || app.project.renderQueue.rendering) { return; }
    for (i = 0; i < list.length; i++) { try { svfi__finish(list[i], false); } catch (e) { } }
}

// Respaldo del servicio: solo se usa si el callback de AE nunca llego (ver service.js)
function svfi_renderPoll(argsStr) {
    var a;
    try { a = svfi__parse(argsStr); } catch (eA) { return svfi__str({ ok: false }); }
    try { return svfi__str({ ok: true, finished: svfi__finish(a.dir, false, a.focus === true) }); }
    catch (e) { return svfi__str({ ok: false, error: e.toString() }); }
}

// ------------------------------------------------------------------ importacion
function svfi__findComp(id, name) {
    var i, it, byName = null;
    for (i = 1; i <= app.project.numItems; i++) {
        it = app.project.item(i);
        if (!(it instanceof CompItem)) { continue; }
        if (it.id === id) { return it; }
        if (!byName && it.name === name) { byName = it; }
    }
    return byName;
}

function svfi__findLayer(comp, a) {
    var i, L;
    if (a.layerId !== null && a.layerId !== undefined) {
        for (i = 1; i <= comp.numLayers; i++) {
            if (svfi__layerId(comp.layer(i)) === a.layerId) { return comp.layer(i); }
        }
    }
    if (a.layerIndex >= 1 && a.layerIndex <= comp.numLayers) {
        L = comp.layer(a.layerIndex);
        if (L.name === a.layerName) { return L; }
    }
    for (i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === a.layerName) { return comp.layer(i); }
    }
    return null;
}

function svfi__findFolder(name) {
    var i, it;
    for (i = 1; i <= app.project.numItems; i++) {
        it = app.project.item(i);
        if (it instanceof FolderItem && it.name === name && it.parentFolder === app.project.rootFolder) { return it; }
    }
    return app.project.items.addFolder(name);
}

// Devuelve por que no se puede borrar la capa (o null si se puede)
function svfi__dependents(comp, L) {
    var i, X;
    try { if (L.isTrackMatte) { return 'it is used as a track matte'; } } catch (e) { }
    for (i = 1; i <= comp.numLayers; i++) {
        X = comp.layer(i);
        try { if (X.parent === L) { return 'other layers are parented to it'; } } catch (e2) { }
    }
    return null;
}

// Auto-comp: precompone el clip a sus propios fps (recorte exacto por frame).
// Con fix, quita los frames repetidos que deja SVFI al inicio y al final y ajusta la duracion.
function svfi__autoComp(foot, folder, a) {
    var fps = foot.frameRate, frames, s = 0, e = 0, dur, pc, L, note = '';
    if (!fps || fps <= 0) { fps = 30; }
    frames = Math.round(foot.duration * fps);
    if (a.compFix) {
        s = Math.max(0, parseInt(a.trimStart, 10) || 0);
        e = Math.max(0, parseInt(a.trimEnd, 10) || 0);
        if (frames - s - e < 1) { s = 0; e = 0; note = 'Clip too short for the frame fix: comp created without trimming.'; }
    }
    dur = (frames - s - e) / fps;
    pc = app.project.items.addComp(foot.name.replace(/\.[^.]+$/, ''), foot.width, foot.height, foot.pixelAspect, dur, fps);
    try { pc.parentFolder = folder; } catch (eF) { }
    L = pc.layers.add(foot);
    L.startTime = -s / fps;
    return { comp: pc, note: note };
}

function svfi_import(argsStr) {
    var a, f, comp, L, foot, nl, dep, note = '', err = null, folder, item, ac;
    try { a = svfi__parse(argsStr); } catch (eA) { return svfi__str({ ok: false, retry: false, error: 'Bad arguments.' }); }
    if (!app.project) { return svfi__str({ ok: false, retry: true, error: 'No project open.' }); }

    f = new File(a.file);
    if (!f.exists) { return svfi__str({ ok: false, retry: false, error: 'Result file not found: ' + a.file }); }

    if (app.project.renderQueue.rendering) { return svfi__str({ ok: false, retry: true, error: 'After Effects is rendering.' }); }
    svfi__finishPending(a.pending);

    comp = svfi__findComp(a.compId, a.compName);
    L = comp ? svfi__findLayer(comp, a) : null;

    app.beginUndoGroup('SVFI Pipeline: import result');
    try {
        foot = app.project.importFile(new ImportOptions(f));
        folder = svfi__findFolder(a.folderName || 'SVFI Results');
        try { foot.parentFolder = folder; } catch (eFo) { }
        item = foot;
        if (a.autoComp) {
            ac = svfi__autoComp(foot, folder, a);
            item = ac.comp;
            if (ac.note) { note = ac.note; }
        }

        if (!comp) {
            note = 'Composition not found: result imported to the project only.';
        } else {
            nl = comp.layers.add(item);
            nl.startTime = a.inPoint;
            if (L) {
                nl.moveBefore(L);
                try { nl.blendingMode = L.blendingMode; } catch (eB) { }
                try { nl.label = L.label; } catch (eLb) { }
                if (a.deleteOriginal) {
                    dep = svfi__dependents(comp, L);
                    if (dep) { L.enabled = false; note = (note ? note + ' ' : '') + 'Original layer kept (hidden) because ' + dep + '.'; }
                    else { L.remove(); }
                }
            } else {
                note = 'Original layer not found: result placed at the top.';
            }
        }
    } catch (e) {
        err = e.message || e.toString();
    }
    app.endUndoGroup();

    if (err) { return svfi__str({ ok: false, retry: false, error: err }); }
    return svfi__str({ ok: true, note: note });
}
