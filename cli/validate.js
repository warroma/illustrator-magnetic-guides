// Bateria de validação no Illustrator real (node cli/liquid.js validar).
// Trabalha numa camada própria "_AL_validacao" e apaga tudo no fim.
"use strict";

async function run(host, ctl) {
    // Se o painel estiver aberto (instalação --dev), pausa a vigilância dele
    // durante a bateria: dois controladores escrevendo no mesmo líquido
    // bagunçam a contagem de escritas.
    let panel = null;
    try {
        panel = await require("../tools/panel-cdp.js").connect();
        await panel.eval("(window.__autoliquid.ctl.stop(), true)");
        console.log("(painel aberto: vigilância dele pausada durante a validação)");
    } catch (e) { panel = null; }
    try {
        return await runAll(host, ctl);
    } finally {
        if (panel) { await panel.eval("(document.getElementById('liveToggle').checked && window.__autoliquid.ctl.start(), true)"); panel.close(); }
    }
}

async function runAll(host, ctl) {
    let pass = 0, fail = 0;
    const timings = [];
    function check(name, ok, detail) {
        ok ? pass++ : fail++;
        console.log((ok ? "  ok    " : "  FALHA ") + name + (detail ? "  — " + detail : ""));
    }
    const J = async code => {
        const txt = await host(code);
        try { return JSON.parse(txt); } catch (e) { return txt; }
    };
    // escreve no Illustrator, deixa o controlador reagir e devolve a última atualização
    let writes = 0;
    const origCall = ctl.call.bind(ctl);
    ctl.call = code => { if (code.startsWith("AL_write(")) writes++; return origCall(code); };
    async function settle() {
        const before = writes;
        ctl.lastUpdate = null;
        await ctl.tick();
        await ctl.tick();
        return { wrote: writes - before, up: ctl.lastUpdate };
    }
    const outInfo = u => J(`(function(){ var g = app.activeDocument.getPageItemFromUuid("${u}"); var o = alFindOut(g);
        if (!o) return '{"loops":0}';
        var c = o.pathItems.length ? o.pathItems[0] : null;
        return alJ({ loops: o.pathItems.length, locked: o.locked, top: g.pageItems[0] === o, area: Math.abs(alArea(o)),
            b: o.geometricBounds, color: c ? alColorKey(c.fillColor) : "-", note: o.note }); })()`);

    console.log("\n== Montagem ==");
    const setup = await J(`(function(){
        var doc = app.activeDocument;
        try { doc.layers.getByName("_AL_validacao").remove(); } catch (e) {}
        var L = doc.layers.add(); L.name = "_AL_validacao";
        function rgb(r,g,b){ var c = new RGBColor(); c.red=r; c.green=g; c.blue=b; return c; }
        var a = L.pathItems.ellipse(400, 100, 80, 80); a.name = "A";
        var b = L.pathItems.ellipse(400, 300, 80, 80); b.name = "B";
        var t = L.pathItems.polygon(200, 200, 40, 3); t.name = "T";
        var items = [a, b, t];
        for (var i = 0; i < 3; i++) { items[i].fillColor = rgb(40, 90, 220); items[i].stroked = false; }
        doc.selection = null; a.selected = true; b.selected = true; t.selected = true;
        return alJ({ a: a.uuid, b: b.uuid, t: t.uuid });
    })()`);
    // A em x 100..180, B em x 300..380: vão de 120 pt
    const created = await ctl.create({ reach: 30, tension: 2.5 });
    const G = created.u;
    await settle();
    let o = await outInfo(G);
    check("criar: contorno existe, travado e no topo do grupo", o.loops > 0 && o.locked && o.top, JSON.stringify({ loops: o.loops, locked: o.locked, top: o.top }));
    check("formas longe (vão 120 > alcance 30) ficam separadas", o.loops === 3, o.loops + " laços");

    console.log("\n== Arrastar B na direção de A (passos de 10 pt) ==");
    let connectedAt = null, reads = 0, n = 0;
    for (let step = 1; step <= 11; step++) {
        await host(`app.activeDocument.getPageItemFromUuid("${setup.b}").translate(-10, 0); "ok"`);
        const r = await settle();
        if (r.up) { timings.push(r.up); reads += r.up.read; n++; }
        o = await outInfo(G);
        const gap = 120 - step * 10;
        if (connectedAt === null && o.loops === 2) connectedAt = gap;
    }
    const avg = k => timings.reduce((s, t) => s + t[k], 0) / Math.max(1, timings.length);
    check("cada passo do arraste gerou exatamente 1 atualização", n === 11, n + " de 11");
    check("arrastar não relê pontos (cache por translação)", reads === 0, reads + " leituras");
    check("A e B se conectam quando o vão chega ao alcance (30), não antes", connectedAt === 30 || connectedAt === 20, "separados com vão 40, conectou com vão " + connectedAt + " pt");
    console.log("  tempo médio por atualização: total " + avg("msTotal").toFixed(1) + " ms (ler " + avg("msRead").toFixed(1) +
        ", calcular " + avg("msCalc").toFixed(1) + ", escrever " + avg("msWrite").toFixed(1) + ")");

    console.log("\n== Parâmetros ==");
    await host(`app.activeDocument.getPageItemFromUuid("${setup.b}").translate(40, 0); "ok"`); // vão 50
    await settle();
    o = await outInfo(G);
    const loopsBefore = o.loops;
    const tP = Date.now();
    await ctl.setParams(G, { reach: 70 });
    const tParam = Date.now() - tP;
    o = await outInfo(G);
    check("aumentar a pregnância (alcance 30→70) conecta formas a 50 pt", loopsBefore === 3 && o.loops <= 2, loopsBefore + " → " + o.loops + " laços, " + tParam + " ms");
    const note = await J(`'"' + app.activeDocument.getPageItemFromUuid("${G}").note + '"'`);
    check("parâmetros gravados no grupo", String(note).indexOf("reach=70") > 0, note);

    console.log("\n== Desfazer ==");
    await host(`app.activeDocument.getPageItemFromUuid("${setup.b}").translate(-20, 0); "ok"`);
    await settle();
    const afterMove = await outInfo(G);
    const w0 = writes;
    await host(`app.undo(); "ok"`);           // volta só o contorno
    await settle();
    const wroteAfterUndo1 = writes - w0;
    await host(`app.undo(); "ok"`);           // volta o movimento de B
    await settle();
    const wroteAfterUndo2 = writes - w0;
    const bPos = await J(`alJ(app.activeDocument.getPageItemFromUuid("${setup.b}").geometricBounds)`);
    o = await outInfo(G);
    check("Ctrl+Z não é re-desfeito pelo painel (sem escrita após desfazer o contorno)", wroteAfterUndo1 === 0, wroteAfterUndo1 + " escritas");
    check("Ctrl+Z de novo desfaz o movimento e o contorno já bate (sem escrita nova)", wroteAfterUndo2 === 0, wroteAfterUndo2 + " escritas, B em x=" + Math.round(bPos[0]));
    await host(`app.redo(); "ok"`);
    await settle();
    o = await outInfo(G);
    check("refazer o movimento atualiza o contorno de novo", Math.abs(o.area - afterMove.area) < 1, "área " + o.area.toFixed(0) + " vs " + afterMove.area.toFixed(0));

    console.log("\n== Mudanças que exigem reler ==");
    let r = null;
    await host(`app.activeDocument.getPageItemFromUuid("${setup.t}").rotate(30); "ok"`);
    r = await settle();
    check("girar o triângulo relê só ele", r.up && r.up.read === 1, r.up ? r.up.read + " lida(s), " + r.up.msTotal.toFixed(0) + " ms" : "sem atualização");
    await host(`(function(){ var p = app.activeDocument.getPageItemFromUuid("${setup.a}").pathPoints[1]; var a = p.anchor;
        p.anchor = [a[0], a[1] + 15]; p.leftDirection = [p.leftDirection[0], p.leftDirection[1] + 15]; p.rightDirection = [p.rightDirection[0], p.rightDirection[1] + 15]; return "ok"; })()`);
    r = await settle();
    check("puxar um âncora do círculo A relê só ele", r.up && r.up.read === 1, r.up ? r.up.read + " lida(s)" : "sem atualização");

    console.log("\n== Estilo ==");
    await host(`(function(){ var g = app.activeDocument.getPageItemFromUuid("${G}"); var s = alSources(g, [], 0)[0];
        var c = new RGBColor(); c.red = 230; c.green = 60; c.blue = 30; s.fillColor = c; return "ok"; })()`);
    await settle();
    o = await outInfo(G);
    check("mudar a cor da forma do topo muda a cor do líquido", o.color === "rgb230,60,30", o.color);

    console.log("\n== Duplicar, expandir, desfazer líquido ==");
    const dup = await J(`(function(){ var g = app.activeDocument.getPageItemFromUuid("${G}"); var d = g.duplicate(); d.translate(0, -250); return alJ({ u: d.uuid }); })()`);
    await settle();
    const snap = ctl.snapshot();
    const dupOut = await outInfo(dup.u);
    check("grupo duplicado vira um líquido independente", snap.liquids.some(l => l.u === dup.u) && dupOut.loops > 0, snap.liquids.length + " líquidos no documento");
    await host(`app.activeDocument.getPageItemFromUuid("${setup.a}").translate(0, 30); "ok"`);
    await settle();
    const dupOut2 = await outInfo(dup.u);
    check("mexer no original não mexe na cópia", Math.abs(dupOut2.area - dupOut.area) < 0.5, "área da cópia " + dupOut.area.toFixed(0) + " → " + dupOut2.area.toFixed(0));
    const ex = await ctl.expand(dup.u);
    // (getPageItemFromUuid embrulha path composto como GroupItem — procura pela camada)
    const exInfo = await J(`(function(){ var L = app.activeDocument.layers.getByName("_AL_validacao"), o = null;
        for (var i = 0; i < L.pageItems.length; i++) if (L.pageItems[i].uuid === "${ex.u}") o = L.pageItems[i];
        return alJ({ t: o.typename, locked: o.locked, parent: o.parent.typename, note: o.note }); })()`);
    check("expandir: vira path composto comum, destravado, fora do grupo", exInfo.t === "CompoundPathItem" && !exInfo.locked && exInfo.parent === "Layer" && !exInfo.note, JSON.stringify(exInfo));
    await ctl.release(G);
    const rel = await J(`(function(){ var L = app.activeDocument.layers.getByName("_AL_validacao"); var n = 0, names = [];
        for (var i = 0; i < L.pageItems.length; i++) { names.push(L.pageItems[i].name || L.pageItems[i].typename); }
        return alJ({ names: names }); })()`);
    check("desfazer líquido devolve A, B e T soltos na camada", ["A", "B", "T"].every(nm => rel.names.indexOf(nm) >= 0) && rel.names.indexOf("Líquido") < 0, rel.names.join(", "));

    console.log("\n== Carga: 40 círculos num líquido ==");
    const many = await J(`(function(){ var doc = app.activeDocument; var L = doc.layers.getByName("_AL_validacao");
        var s = 7; function rnd(){ s = (s * 16807) % 2147483647; return s / 2147483647; }
        doc.selection = null; var ids = [];
        for (var i = 0; i < 40; i++) { var r = 8 + rnd() * 22; var e = L.pathItems.ellipse(780 - rnd() * 500, 40 + rnd() * 500, 2 * r, 2 * r); e.selected = true; ids.push(e.uuid); }
        return alJ({ ids: ids }); })()`);
    const tc = Date.now();
    const big = await ctl.create({ reach: 18 });
    const tCreate = Date.now() - tc;
    const bigUp = ctl.lastUpdate;
    check("criar com 40 círculos", bigUp && bigUp.shapes === 40, (bigUp ? bigUp.loops + " laços, " : "") + tCreate + " ms ponta a ponta");
    const dragT = [];
    for (let i = 0; i < 8; i++) {
        await host(`app.activeDocument.getPageItemFromUuid("${many.ids[i * 3]}").translate(6, -4); "ok"`);
        const t1 = Date.now();
        const rr = await settle();
        if (rr.up) dragT.push(rr.up);
    }
    const mean = k => dragT.reduce((s, t) => s + t[k], 0) / Math.max(1, dragT.length);
    check("arrastar 1 de 40 círculos", dragT.length === 8, "média " + mean("msTotal").toFixed(1) + " ms (calcular " + mean("msCalc").toFixed(1) + ", escrever " + mean("msWrite").toFixed(1) + ")");
    const tv = Date.now();
    await host(`AL_poll()`);
    const tPoll = Date.now() - tv;
    console.log("  vigilância (AL_poll) com 41 formas em líquidos: " + tPoll + " ms ida e volta");

    await host(`(function(){ try { app.activeDocument.layers.getByName("_AL_validacao").remove(); } catch (e) {} return "ok"; })()`);
    console.log("\n" + pass + " ok, " + fail + " falha(s)");
    return fail === 0;
}

module.exports = { run };
