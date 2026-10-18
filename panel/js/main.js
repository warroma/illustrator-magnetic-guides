// AutoLiquid 2 — painel. A lógica toda está no controlador compartilhado
// (js/liquid-controller.js, o mesmo do CLI); aqui é só interface.
(function () {
    "use strict";

    var cs = new CSInterface();
    function host(code) {
        return new Promise(function (resolve) { cs.evalScript(code, resolve); });
    }

    var PT_PER = { pt: 1, mm: 72 / 25.4 };
    var RANGES = { pt: { reach: 300, grow: 20 }, mm: { reach: 100, grow: 7 } };

    var els = {
        bar: document.getElementById("liquidBar"),
        name: document.getElementById("liquidName"),
        count: document.getElementById("liquidCount"),
        meta: document.getElementById("liquidMeta"),
        create: document.getElementById("createBtn"),
        controls: document.getElementById("controls"),
        unitToggle: document.getElementById("unitToggle"),
        reach: document.getElementById("reach"),
        reachVal: document.getElementById("reachVal"),
        tension: document.getElementById("tension"),
        tensionVal: document.getElementById("tensionVal"),
        grow: document.getElementById("grow"),
        growVal: document.getElementById("growVal"),
        kernelGrid: document.getElementById("kernelGrid"),
        tol: document.getElementById("tol"),
        tolVal: document.getElementById("tolVal"),
        advanced: document.getElementById("advanced"),
        expand: document.getElementById("expandBtn"),
        release: document.getElementById("releaseBtn"),
        live: document.getElementById("liveToggle"),
        status: document.getElementById("status")
    };

    function load(k) { try { return localStorage.getItem("autoliquid." + k); } catch (e) { return null; } }
    function save(k, v) { try { localStorage.setItem("autoliquid." + k, v); } catch (e) { } }

    var unit = load("unit") === "pt" ? "pt" : "mm";
    if (load("advanced") === "1") els.advanced.open = true;

    // ===== conversões =====
    function fmt(n, dec) { return (Math.round(n * Math.pow(10, dec)) / Math.pow(10, dec)).toFixed(dec).replace(".", ","); }
    function parseNum(s) { var v = parseFloat(String(s).replace(",", ".")); return isFinite(v) ? v : null; }
    function toUnit(pt) { return pt / PT_PER[unit]; }
    function toPt(v) { return v * PT_PER[unit]; }
    // Pregnância: slider 0..1000 em escala quadrática → controle fino nos
    // valores pequenos (os mais usados) e ainda alcança 100 mm / 300 pt
    function reachFromSlider(s) { var m = RANGES[unit].reach, t = s / 1000; return m * t * t; }
    function sliderFromReach(v) { return Math.round(Math.sqrt(Math.min(1, Math.max(0, v / RANGES[unit].reach))) * 1000); }
    // Tensão: slider 0..100 → expoente p 1..4 (p=2 = smooth-min quadrática)
    function pFromSlider(v) { return 1 + 3 * v / 100; }
    function sliderFromP(p) { return Math.round((p - 1) / 3 * 100); }
    // Precisão: slider 0..100 → tolerância 0,02..0,5 pt (escala log)
    function tolFromSlider(v) { return 0.02 * Math.pow(25, v / 100); }
    function sliderFromTol(t) { return Math.round(Math.log(t / 0.02) / Math.log(25) * 100); }

    // ===== controlador =====
    var ctl = new LiquidController.Controller(host, { onState: render });
    var shownFor = null;     // uuid cujos valores estão nos controles
    var editing = false;     // usuário arrastando um slider: não sobrescrever
    var lastError = null;

    function setStatus(msg, isError) {
        els.status.textContent = msg || "";
        els.status.className = isError ? "error" : "";
    }

    function render(snap) {
        if (snap && snap.error) {
            lastError = snap.error;
            setStatus(snap.error, true);
            return;
        }
        lastError = null;
        var A = snap.active;
        els.count.textContent = snap.doc ? (snap.liquids.length + (snap.liquids.length === 1 ? " líquido" : " líquidos") + " no documento") : "";
        els.bar.className = "liquid-bar" + (A ? " on" : "");
        if (!snap.doc) {
            els.name.textContent = "Nenhum documento aberto";
            els.meta.textContent = "";
        } else if (A) {
            els.name.textContent = A.name || "Líquido";
            var up = snap.lastUpdate && snap.lastUpdate.uuid === A.u ? snap.lastUpdate : null;
            els.meta.textContent = A.n + (A.n === 1 ? " forma" : " formas") +
                (up ? " · " + up.loops + (up.loops === 1 ? " contorno" : " contornos") + " · " + Math.round(up.msTotal) + " ms" : "");
        } else {
            els.name.textContent = "Nenhum líquido selecionado";
            els.meta.textContent = snap.liquids.length ? "Selecione um líquido para ajustar." : "Selecione formas e crie um líquido.";
        }
        els.create.disabled = !snap.doc || !snap.selCount || snap.selectionIsLiquid;
        els.controls.className = "controls" + (A ? "" : " off");
        els.expand.disabled = els.release.disabled = !A;
        if (A && (!editing) && (shownFor !== A.u || !sameParams(A.params))) showParams(A.params, A.u);
        if (!lastError) setStatus(snap.doc ? (ctl.timer ? "Ao vivo." : "Pausado — mudanças nas formas não atualizam o líquido.") : "");
    }

    var shownParams = null;
    function sameParams(p) {
        if (!shownParams) return false;
        for (var k in p) if (p[k] !== shownParams[k]) return false;
        return true;
    }

    function showParams(p, uuid) {
        shownFor = uuid;
        shownParams = {};
        for (var k in p) shownParams[k] = p[k];
        applyRanges();
        els.reach.value = sliderFromReach(toUnit(p.reach));
        els.reachVal.value = fmt(toUnit(p.reach), 1);
        els.tension.value = sliderFromP(p.tension);
        els.tensionVal.textContent = "p " + fmt(p.tension, 1);
        els.grow.value = toUnit(p.grow);
        els.growVal.value = fmt(toUnit(p.grow), 2);
        els.tol.value = sliderFromTol(p.tol);
        els.tolVal.textContent = fmt(p.tol, 2) + " pt";
        Array.prototype.forEach.call(els.kernelGrid.children, function (b) {
            b.classList.toggle("active", b.getAttribute("data-kernel") === p.kernel);
        });
    }

    function applyRanges() {
        var R = RANGES[unit];
        els.grow.min = -R.grow; els.grow.max = R.grow;
        els.grow.step = unit === "mm" ? 0.05 : 0.25;
        Array.prototype.forEach.call(document.querySelectorAll(".unit-label"), function (el) { el.textContent = unit; });
        Array.prototype.forEach.call(els.unitToggle.children, function (b) { b.classList.toggle("active", b.getAttribute("data-unit") === unit); });
    }

    function edit(partial) {
        var A = ctl.active();
        if (!A) return;
        for (var k in partial) shownParams[k] = partial[k];
        ctl.setParams(A.u, partial);
    }

    // ===== sliders =====
    function bindDrag(el) {
        el.addEventListener("pointerdown", function () { editing = true; });
        el.addEventListener("change", function () { editing = false; });
        el.addEventListener("pointerup", function () { editing = false; });
    }
    [els.reach, els.tension, els.grow, els.tol].forEach(bindDrag);

    els.reach.addEventListener("input", function () {
        var v = reachFromSlider(+els.reach.value);
        els.reachVal.value = fmt(v, 1);
        edit({ reach: toPt(v) });
    });
    els.reachVal.addEventListener("change", function () {
        var v = parseNum(els.reachVal.value);
        if (v === null || v < 0) { showParams(shownParams, shownFor); return; }
        edit({ reach: toPt(v) });
        els.reach.value = sliderFromReach(v);
    });
    els.tension.addEventListener("input", function () {
        var p = pFromSlider(+els.tension.value);
        els.tensionVal.textContent = "p " + fmt(p, 1);
        edit({ tension: Math.round(p * 100) / 100 });
    });
    els.grow.addEventListener("input", function () {
        var v = +els.grow.value;
        els.growVal.value = fmt(v, 2);
        edit({ grow: toPt(v) });
    });
    els.growVal.addEventListener("change", function () {
        var v = parseNum(els.growVal.value);
        if (v === null) { showParams(shownParams, shownFor); return; }
        edit({ grow: toPt(v) });
        els.grow.value = v;
    });
    els.tol.addEventListener("input", function () {
        var t = tolFromSlider(+els.tol.value);
        els.tolVal.textContent = fmt(t, 2) + " pt";
        edit({ tol: Math.round(t * 1000) / 1000 });
    });
    els.kernelGrid.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b) return;
        Array.prototype.forEach.call(els.kernelGrid.children, function (x) { x.classList.toggle("active", x === b); });
        edit({ kernel: b.getAttribute("data-kernel") });
    });
    els.unitToggle.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b) return;
        unit = b.getAttribute("data-unit");
        save("unit", unit);
        if (shownParams) showParams(shownParams, shownFor); else applyRanges();
    });
    els.advanced.addEventListener("toggle", function () { save("advanced", els.advanced.open ? "1" : "0"); });

    // ===== ações =====
    function run(promise, okMsg) {
        lastError = null;
        return promise.then(function () { if (okMsg) setStatus(okMsg); })
            .catch(function (e) { lastError = e.message; setStatus(e.message, true); });
    }

    els.create.addEventListener("click", function () {
        setStatus("Criando…");
        run(ctl.create({}).then(function () { shownFor = null; }), "Líquido criado.");
    });
    els.expand.addEventListener("click", function () {
        var A = ctl.active();
        if (A) run(ctl.expand(A.u), "Expandido em um path comum (Ctrl+Z desfaz).");
    });
    els.release.addEventListener("click", function () {
        var A = ctl.active();
        if (A) run(ctl.release(A.u), "Líquido desfeito; formas devolvidas.");
    });
    els.live.addEventListener("change", function () {
        if (els.live.checked) ctl.start(); else ctl.stop();
        render(ctl.snapshot());
    });

    // pausa quando o painel some (recolhido/fechado) pra não gastar o Illustrator
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) ctl.stop();
        else if (els.live.checked) ctl.start();
    });

    applyRanges();
    ctl.start();

    // pra depuração remota (CEP .debug) e testes automatizados
    window.__autoliquid = { ctl: ctl, els: els };
})();
