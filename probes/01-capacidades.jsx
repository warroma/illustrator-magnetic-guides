// Sonda: o que o Illustrator desta máquina permite por script.
// Roda num documento aberto; cria e apaga uma camada própria "_sonda".
(function () {
    var out = [];
    function log(k, v) { out.push(k + ": " + v); }
    var doc = app.activeDocument;
    var layer = doc.layers.add();
    layer.name = "_sonda";
    try {
        // 1. UUID estável por item
        var c = layer.pathItems.ellipse(500, 100, 80, 80);
        log("uuid", typeof c.uuid + " = " + c.uuid);
        var back = doc.getPageItemFromUuid(c.uuid);
        log("getPageItemFromUuid", back && back.typename);

        // 2. Script consegue editar item bloqueado?
        var p = layer.pathItems.add();
        p.setEntirePath([[0, 0], [10, 0], [10, 10]]);
        p.locked = true;
        try { p.setEntirePath([[0, 0], [20, 0], [20, 20]]); log("editar bloqueado (setEntirePath)", "ok"); }
        catch (e) { log("editar bloqueado (setEntirePath)", "ERRO " + e.message); }
        try { p.pathPoints[0].rightDirection = [5, 5]; log("editar bloqueado (handle)", "ok"); }
        catch (e2) { log("editar bloqueado (handle)", "ERRO " + e2.message); }
        try { p.note = "x"; log("editar bloqueado (note)", "ok"); }
        catch (e3) { log("editar bloqueado (note)", "ERRO " + e3.message); }

        // 3. Custo de desenhar um path de N pontos com alças
        var N = 120;
        var pts = [];
        for (var i = 0; i < N; i++) {
            var a = i / N * Math.PI * 2;
            pts.push([300 + 100 * Math.cos(a), 400 + 100 * Math.sin(a)]);
        }
        $.hiresTimer;
        var q = layer.pathItems.add();
        q.setEntirePath(pts);
        var tSet = $.hiresTimer;
        var pp = q.pathPoints;
        for (var j = 0; j < N; j++) {
            var pt = pp[j];
            pt.leftDirection = [pts[j][0] - 1, pts[j][1] - 1];
            pt.rightDirection = [pts[j][0] + 1, pts[j][1] + 1];
        }
        var tHandles = $.hiresTimer;
        q.closed = true;
        log("setEntirePath " + N + " pts (us)", tSet);
        log("alças " + N + " pts (us)", tHandles);

        // 3b. Alternativa: criar via pathPoints.add (um por um)
        $.hiresTimer;
        var r = layer.pathItems.add();
        for (var k = 0; k < N; k++) {
            var np = r.pathPoints.add();
            np.anchor = pts[k];
            np.leftDirection = [pts[k][0] - 1, pts[k][1] - 1];
            np.rightDirection = [pts[k][0] + 1, pts[k][1] + 1];
        }
        log("pathPoints.add " + N + " pts (us)", $.hiresTimer);

        // 4. Ler geometria: custo de ler N pontos
        $.hiresTimer;
        var s = [];
        for (var m = 0; m < N; m++) {
            var P = pp[m];
            s.push(P.anchor[0], P.anchor[1], P.leftDirection[0], P.leftDirection[1], P.rightDirection[0], P.rightDirection[1]);
        }
        log("ler " + N + " pts (us)", $.hiresTimer);
        $.hiresTimer;
        var gb = q.geometricBounds;
        log("geometricBounds (us)", $.hiresTimer);

        // 5. applyEffect existe? (alternativa nativa)
        log("applyEffect", typeof c.applyEffect);

        // 6. redraw
        $.hiresTimer;
        app.redraw();
        log("redraw (us)", $.hiresTimer);
    } catch (err) {
        log("FALHA", err.message + " (linha " + err.line + ")");
    }
    // limpa
    for (var z = layer.pageItems.length - 1; z >= 0; z--) { layer.pageItems[z].locked = false; layer.pageItems[z].remove(); }
    layer.remove();
    return out.join("\n");
})();
