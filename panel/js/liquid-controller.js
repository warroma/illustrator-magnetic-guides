/*
 * liquid-controller.js — orquestra vigiar → ler → calcular → escrever.
 *
 * Igual no CLI (Node, ponte COM) e no painel CEP (csInterface.evalScript):
 * só precisa de uma função host(código) → Promise<string>.
 *
 * Regras que importam:
 *  - Vigilância barata: AL_poll só lê caixa/área/perímetro/1º ponto de cada
 *    forma. A geometria completa só é lida quando a forma mudou de verdade;
 *    se ela só foi arrastada (mesma área, perímetro, tamanho e 1º ponto na
 *    mesma posição relativa), a geometria em cache é transladada.
 *  - Desfazer: o contorno guarda a assinatura das entradas com que foi
 *    desenhado. Só redesenhamos quando as entradas MUDARAM desde a última
 *    vigilância e o contorno não corresponde a elas. Assim Ctrl+Z que volta
 *    só o contorno não é "re-desfeito" pelo painel (o usuário consegue
 *    continuar desfazendo), e desfazer o movimento não cria passo novo.
 *  - Uma chamada ao host por vez; edições de parâmetro coalescem (vale a
 *    última), como o requestApply do AutoGrids.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("./liquid-core.js"));
    else root.LiquidController = factory(root.LiquidCore);
}(typeof self !== "undefined" ? self : this, function (Core) {
    "use strict";

    var DEFAULTS = { reach: 24, tension: 2, kernel: "poly", grow: 0, tol: 0.1 };
    var KEYS = ["reach", "tension", "kernel", "grow", "tol"];

    function encodeParams(p) {
        return KEYS.map(function (k) { return k + "=" + p[k]; }).join(";");
    }

    function decodeParams(s) {
        var p = {};
        for (var k in DEFAULTS) p[k] = DEFAULTS[k];
        String(s || "").split(";").forEach(function (kv) {
            var i = kv.indexOf("=");
            if (i < 0) return;
            var key = kv.slice(0, i), val = kv.slice(i + 1);
            if (!(key in DEFAULTS)) return;
            p[key] = typeof DEFAULTS[key] === "number" ? (isFinite(+val) ? +val : DEFAULTS[key]) : val;
        });
        return p;
    }

    function fnv(str) {
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ("0000000" + h.toString(16)).slice(-8);
    }

    function lit(s) { return JSON.stringify(String(s)); }

    function srcSig(srcs) {
        return srcs.map(function (s) { return s.u + ":" + s.b.join(",") + ":" + s.a + ":" + s.l + ":" + s.n + ":" + s.p0.join(","); }).join("|");
    }

    function shapeKey(s) { return s.u + "|" + s.t + "|" + s.a + "|" + s.l + "|" + s.n; }

    function num(v) { return String(Math.round(v * 1000) / 1000); }

    function now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }

    function Controller(host, opts) {
        opts = opts || {};
        this.host = host;
        this.minInterval = opts.interval || 60;
        this.pollMs = 0;        // ida e volta da última vigilância
        this.pollHist = [];
        this.log = opts.log || function () { };
        this.onState = opts.onState || function () { };
        this.seenGeo = {};      // uuid -> assinatura geo vista na última vigilância
        this.seenStyle = {};
        this.cache = {};        // shapeKey -> { b, p0, subs }
        this.cacheOrder = [];
        this.pending = {};      // uuid -> params editados no painel ainda não gravados
        this.busy = false;
        this.again = false;
        this.timer = null;
        this.last = null;       // última vigilância
        this.activeUuid = null;
        this.lastUpdate = null; // estatísticas da última atualização
    }

    Controller.prototype.call = function (code) {
        var self = this;
        return Promise.resolve(this.host(code)).then(function (txt) {
            var r;
            try { r = JSON.parse(txt); } catch (e) { throw new Error("Resposta inválida do Illustrator: " + String(txt).slice(0, 200)); }
            if (r && r.error) throw new Error(r.error);
            return r;
        });
    };

    // Vigilância adaptativa: o próximo ciclo espera ~12× o custo da
    // vigilância, entre 60 e 400 ms. O custo é o MÍNIMO das últimas 5 idas e
    // voltas: os picos (40–90 ms medidos) são o Illustrator ocupado com a
    // própria interface, não custo nosso. Documento leve → ~60 ms; muitas
    // formas → espaça sozinho.
    Controller.prototype.start = function () {
        var self = this;
        if (this.timer) return;
        this.timer = true;
        (function loop() {
            if (!self.timer) return;
            Promise.resolve(self.tick()).then(function () {
                if (!self.timer) return;
                var cost = self.pollHist.length ? Math.min.apply(null, self.pollHist) : 5;
                self.timer = setTimeout(loop, Math.max(self.minInterval, Math.min(400, 12 * cost)));
            });
        })();
    };

    Controller.prototype.stop = function () {
        if (this.timer && this.timer !== true) clearTimeout(this.timer);
        this.timer = null;
    };

    Controller.prototype.tick = function () {
        var self = this;
        if (this.busy) { this.again = true; return this.running; }
        this.busy = true;
        this.running = this._tick().catch(function (e) {
            self.onState({ error: e.message });
            self.log("erro: " + e.message);
        }).then(function () {
            self.busy = false;
            if (self.again || Object.keys(self.pending).length) {
                self.again = false;
                return self.tick();
            }
        });
        return this.running;
    };

    Controller.prototype._tick = function () {
        var self = this, t0 = now();
        return this.call("AL_poll()").then(function (st) {
            self.pollMs = now() - t0;
            self.pollHist.push(self.pollMs);
            if (self.pollHist.length > 5) self.pollHist.shift();
            self.last = st;
            if (st.active) self.activeUuid = st.active;
            var chain = Promise.resolve();
            (st.liquids || []).forEach(function (L) {
                chain = chain.then(function () { return self._consider(L); });
            });
            return chain.then(function () { self.onState(self.snapshot()); });
        });
    };

    Controller.prototype._consider = function (L) {
        var pend = this.pending[L.u];
        var params = pend || decodeParams(L.params);
        var pstr = encodeParams(params);
        var geoSig = fnv(pstr + "#" + srcSig(L.srcs));
        var styleSig = fnv(L.style);
        var first = !(L.u in this.seenGeo);
        var geoChanged = this.seenGeo[L.u] !== geoSig;
        var styleChanged = this.seenStyle[L.u] !== styleSig;
        this.seenGeo[L.u] = geoSig;
        this.seenStyle[L.u] = styleSig;
        var needGeo = (first || geoChanged || pend) && geoSig !== L.outSig;
        var needStyle = (first || styleChanged) && styleSig !== L.outStyle;
        if (!needGeo && !needStyle && !pend) return null;
        delete this.pending[L.u];
        return this.update(L, params, pend ? pstr : "", geoSig, styleSig, needStyle);
    };

    // Monta as formas pro motor, lendo do Illustrator só o que não dá pra
    // tirar do cache.
    Controller.prototype._shapes = function (L) {
        var self = this, need = [], out = new Array(L.srcs.length);
        L.srcs.forEach(function (s, i) {
            var c = self.cache[shapeKey(s)];
            if (c) {
                var dx = s.b[0] - c.b[0], dy = s.b[1] - c.b[1];
                var sameSize = Math.abs((s.b[2] - s.b[0]) - (c.b[2] - c.b[0])) < 0.01 && Math.abs((s.b[1] - s.b[3]) - (c.b[1] - c.b[3])) < 0.01;
                var sameP0 = Math.abs(s.p0[0] - c.p0[0] - dx) < 0.01 && Math.abs(s.p0[1] - c.p0[1] - dy) < 0.01;
                if (sameSize && sameP0) { out[i] = { id: s.u, subpaths: translate(c.subs, dx, dy) }; return; }
            }
            need.push(i);
        });
        if (!need.length) return Promise.resolve({ shapes: out, read: 0 });
        var ids = need.map(function (i) { return L.srcs[i].u; }).join(",");
        return this.call("AL_read(" + lit(L.u) + "," + lit(ids) + ")").then(function (r) {
            var byU = {};
            r.srcs.forEach(function (g) { byU[g.u] = g; });
            need.forEach(function (i) {
                var s = L.srcs[i], g = byU[s.u];
                if (!g) return;
                var subs = g.subs.map(function (sp) { return { closed: sp.c, pts: sp.p }; });
                self._remember(shapeKey(s), { b: g.b, p0: g.p0, subs: subs });
                out[i] = { id: s.u, subpaths: subs };
            });
            return { shapes: out.filter(Boolean), read: need.length };
        });
    };

    Controller.prototype._remember = function (key, val) {
        if (!(key in this.cache)) this.cacheOrder.push(key);
        this.cache[key] = val;
        while (this.cacheOrder.length > 400) delete this.cache[this.cacheOrder.shift()];
    };

    Controller.prototype.update = function (L, params, paramsToSave, geoSig, styleSig, syncStyle) {
        var self = this, t0 = now(), tRead, tCalc, res;
        return this._shapes(L).then(function (got) {
            tRead = now();
            res = Core.compute(got.shapes, {
                reach: params.reach, tension: params.tension, kernel: params.kernel,
                grow: params.grow, tolerance: params.tol
            });
            tCalc = now();
            var data = res.paths.map(function (p) { return p.pts.map(num).join(","); }).join(";");
            return self.call("AL_write(" + lit(L.u) + "," + lit(geoSig) + "," + lit(styleSig) + "," + lit(data) + "," + lit(paramsToSave) + "," + (syncStyle ? "true" : "false") + ")").then(function () {
                var t1 = now();
                // o resumo da vigilância é de antes da escrita: deixa-o em dia
                // pra interface não "voltar" o slider até a próxima vigilância
                if (paramsToSave) L.params = paramsToSave;
                L.outSig = geoSig; L.outStyle = styleSig;
                self.updates = (self.updates || 0) + 1;
                self.lastUpdate = {
                    at: Date.now(), seq: self.updates,
                    uuid: L.u, shapes: got.shapes.length, read: got.read,
                    msRead: tRead - t0, msCalc: tCalc - tRead, msWrite: t1 - tCalc, msTotal: t1 - t0,
                    loops: res.stats.loops, anchors: res.stats.anchors, engine: res.stats
                };
                self.log("atualizou " + (L.name || L.u) + ": " + got.shapes.length + " formas (" + got.read + " lidas), " +
                    res.stats.loops + " laço(s), " + res.stats.anchors + " âncoras — ler " + (tRead - t0).toFixed(0) +
                    " ms, calcular " + (tCalc - tRead).toFixed(0) + " ms, escrever " + (t1 - tCalc).toFixed(0) + " ms");
            });
        });
    };

    function translate(subs, dx, dy) {
        return subs.map(function (sp) {
            var p = sp.pts, q = new Array(p.length);
            for (var i = 0; i < p.length; i += 2) { q[i] = p[i] + dx; q[i + 1] = p[i + 1] + dy; }
            return { closed: sp.closed, pts: q };
        });
    }

    // ===== comandos =====

    Controller.prototype.liquid = function (uuid) {
        var st = this.last;
        if (!st || !st.liquids) return null;
        for (var i = 0; i < st.liquids.length; i++) if (st.liquids[i].u === uuid) return st.liquids[i];
        return null;
    };

    Controller.prototype.active = function () {
        var L = this.activeUuid ? this.liquid(this.activeUuid) : null;
        return L;
    };

    Controller.prototype.paramsOf = function (uuid) {
        if (this.pending[uuid]) return this.pending[uuid];
        var L = this.liquid(uuid);
        return decodeParams(L ? L.params : "");
    };

    Controller.prototype.setParams = function (uuid, partial) {
        var p = {}, cur = this.paramsOf(uuid);
        for (var k in cur) p[k] = cur[k];
        for (var j in partial) p[j] = partial[j];
        this.pending[uuid] = p;
        return this.tick();
    };

    // Cria a partir da seleção. Sem alcance informado, usa ~40% do menor
    // lado mediano das formas (proporcional ao desenho).
    Controller.prototype.create = function (partial) {
        var self = this, p = {};
        for (var k in DEFAULTS) p[k] = DEFAULTS[k];
        for (var j in partial || {}) p[j] = partial[j];
        var auto = !(partial && partial.reach);
        return this.call("AL_create(" + lit(encodeParams(p)) + ")").then(function (r) {
            self.activeUuid = r.u;
            return self.call("AL_poll()").then(function (st) {
                self.last = st;
                var L = self.liquid(r.u);
                if (L && auto) {
                    var sizes = L.srcs.map(function (s) { return Math.min(s.b[2] - s.b[0], s.b[1] - s.b[3]); }).sort(function (a, b) { return a - b; });
                    var med = sizes[Math.floor(sizes.length / 2)] || 50;
                    p.reach = Math.max(2, Math.round(med * 0.4));
                }
                self.pending[r.u] = p;
                return self.tick();
            }).then(function () { return r; });
        });
    };

    Controller.prototype.release = function (uuid) {
        var self = this;
        return this.call("AL_release(" + lit(uuid) + ")").then(function () { delete self.seenGeo[uuid]; return self.tick(); });
    };

    Controller.prototype.expand = function (uuid) {
        var self = this;
        return this.call("AL_expand(" + lit(uuid) + ")").then(function (r) { delete self.seenGeo[uuid]; return self.tick().then(function () { return r; }); });
    };

    Controller.prototype.select = function (uuid) {
        this.activeUuid = uuid;
        return this.call("AL_select(" + lit(uuid) + ")");
    };

    Controller.prototype.snapshot = function () {
        var st = this.last || {};
        var A = this.active();
        return {
            doc: st.doc || null,
            liquids: (st.liquids || []).map(function (L) { return { u: L.u, name: L.name, n: L.srcs.length }; }),
            active: A ? { u: A.u, name: A.name, n: A.srcs.length, params: this.paramsOf(A.u) } : null,
            selectionIsLiquid: !!st.active,
            selCount: st.selCount || 0,
            lastUpdate: this.lastUpdate
        };
    };

    return {
        Controller: Controller,
        DEFAULTS: DEFAULTS,
        encodeParams: encodeParams,
        decodeParams: decodeParams,
        fnv: fnv
    };
}));
