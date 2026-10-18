// AutoLiquid 2 — lado Illustrator (ExtendScript, ES3).
//
// Não calcula nada: só lê a geometria das formas e escreve o contorno que o
// motor (engine/liquid-core.js, rodando no painel/CLI) devolve.
//
// Modelo no documento:
//   GroupItem "Líquido"            note = "AutoLiquid|1|reach=..;tension=..;.."
//     CompoundPathItem (travado)   note = "ALOUT|<assinatura geo>|<assinatura estilo>"
//     ...formas-fonte (paths, paths compostos, subgrupos)...
// O contorno fica no topo do grupo e travado: cobre as formas (o líquido
// sempre contém a união delas) e o clique atravessa pra forma de baixo.
// Duplicar/copiar/apagar/desfazer o grupo funciona como qualquer grupo.
//
// Custos medidos (Illustrator 30.8): geometricBounds 13 µs, area 29 µs,
// length 10 µs, ler 1 ponto bézier ~100 µs, escrever 120 pontos ~2 ms,
// app.redraw ~55 ms (nunca chamado no caminho ao vivo). Cada chamada de
// script vira UM passo de desfazer.

var AL_VERSION = "2.0.0";
var AL_GROUP_TAG = "AutoLiquid|";
var AL_OUT_TAG = "ALOUT|";
var AL_GROUP_NAME = "Líquido";
var AL_OUT_NAME = "Contorno líquido";

if (!$.global.__AL) $.global.__AL = { reg: {}, glen: {}, polls: 0 };

// ===== utilidades =====

// JSON mínimo (o ExtendScript não tem JSON). Medido: a versão com regex em
// toda string custava 2,1 ms dos 2,9 ms da vigilância; escapar só quando há
// caractere especial derruba isso pra uma fração.
var AL_NEEDS_ESC = /["\\\x00-\x1f]/;
var AL_ESC_ALL = /["\\\x00-\x1f]/g;
function alEsc(c) {
    if (c === '"') return '\\"';
    if (c === "\\") return "\\\\";
    var h = c.charCodeAt(0).toString(16);
    return "\\u" + ("0000" + h).slice(-4);
}
function alJ(v) {
    switch (typeof v) {
        case "number": return isFinite(v) ? String(v) : "null";
        case "string": return AL_NEEDS_ESC.test(v) ? '"' + v.replace(AL_ESC_ALL, alEsc) + '"' : '"' + v + '"';
        case "boolean": return v ? "true" : "false";
    }
    if (v === null || v === undefined) return "null";
    var a = [], i, n;
    if (v instanceof Array) {
        for (i = 0, n = v.length; i < n; i++) a[i] = alJ(v[i]);
        return "[" + a.join(",") + "]";
    }
    for (var k in v) if (v.hasOwnProperty(k)) a.push('"' + k + '":' + alJ(v[k]));
    return "{" + a.join(",") + "}";
}

function alErr(msg) { return alJ({ error: msg }); }
function r3(x) { return Math.round(x * 1000) / 1000; }

// Atenção: getPageItemFromUuid devolve path composto embrulhado como
// GroupItem (typename errado) e lança erro se o item foi apagado. Por isso
// só usamos uuid pra achar GRUPOS líquidos; as formas são lidas iterando os
// filhos do grupo.
function alItem(doc, uuid) {
    try { return doc.getPageItemFromUuid(uuid); } catch (e) { return null; }
}

function alMeta(g) {
    var n = "";
    try { n = String(g.note || ""); } catch (e) { return null; }
    if (n.indexOf(AL_GROUP_TAG) !== 0) return null;
    var parts = n.split("|");
    return { version: parts[1], params: parts.slice(2).join("|") };
}

function alIsOut(item) {
    try { return String(item.note || "").indexOf(AL_OUT_TAG) === 0; } catch (e) { return false; }
}

function alColorKey(c) {
    if (!c) return "-";
    switch (c.typename) {
        case "RGBColor": return "rgb" + r3(c.red) + "," + r3(c.green) + "," + r3(c.blue);
        case "CMYKColor": return "cmyk" + r3(c.cyan) + "," + r3(c.magenta) + "," + r3(c.yellow) + "," + r3(c.black);
        case "GrayColor": return "g" + r3(c.gray);
        case "SpotColor": return "spot" + c.spot.name + "@" + r3(c.tint);
        case "GradientColor": return "grad" + c.gradient.name + "@" + r3(c.angle) + "," + r3(c.length);
        case "PatternColor": return "pat" + c.pattern.name;
        case "NoColor": return "none";
    }
    return c.typename;
}

// item cujo estilo representa a forma (num composto, o 1º subpath)
function alStyleCarrier(item) {
    if (item.typename === "CompoundPathItem") return item.pathItems.length ? item.pathItems[0] : null;
    return item;
}

function alStyleKey(item) {
    var s = alStyleCarrier(item);
    if (!s) return "-";
    var k = (s.filled ? "F" + alColorKey(s.fillColor) : "f") + "|" +
        (s.stroked ? "S" + alColorKey(s.strokeColor) + "@" + r3(s.strokeWidth) : "s") + "|" +
        r3(item.opacity) + "|" + item.blendingMode;
    return k;
}

function alCopyStyle(fromItem, toCompound) {
    var s = alStyleCarrier(fromItem);
    var d = toCompound.pathItems.length ? toCompound.pathItems[0] : null;
    if (!s || !d) return;
    d.filled = s.filled;
    if (s.filled) d.fillColor = s.fillColor;
    d.stroked = s.stroked;
    if (s.stroked) {
        d.strokeColor = s.strokeColor;
        d.strokeWidth = s.strokeWidth;
        d.strokeJoin = s.strokeJoin;
        d.strokeCap = s.strokeCap;
        d.strokeMiterLimit = s.strokeMiterLimit;
        try { d.strokeDashes = s.strokeDashes; } catch (e) { }
    }
    toCompound.opacity = fromItem.opacity;
    try { toCompound.blendingMode = fromItem.blendingMode; } catch (e2) { }
}

// Formas-fonte de um grupo líquido, na ordem do empilhamento (topo primeiro).
// Ignora: o contorno gerado, itens ocultos, guias, máscaras, texto, imagens.
function alSources(g, out, depth) {
    var items = g.pageItems;
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var t = it.typename;
        if (it.hidden) continue;
        if (t === "PathItem") {
            if (it.guides || it.clipping) continue;
            if (alIsOut(it)) continue;
            out.push(it);
        } else if (t === "CompoundPathItem") {
            if (alIsOut(it)) continue;
            out.push(it);
        } else if (t === "GroupItem" && depth < 4 && !it.clipped && !alMeta(it)) {
            alSources(it, out, depth + 1);
        }
    }
    return out;
}

function alFindOut(g) {
    var items = g.pageItems;
    if (items.length && alIsOut(items[0])) return items[0];
    for (var i = 1; i < items.length; i++) if (alIsOut(items[i])) return items[i];
    return null;
}

function alFirstPoint(it) {
    var p = it.typename === "CompoundPathItem" ? (it.pathItems.length ? it.pathItems[0] : null) : it;
    if (!p || !p.pathPoints.length) return [0, 0];
    var a = p.pathPoints[0].anchor;
    return [r3(a[0]), r3(a[1])];
}

// área e perímetro: num composto o Illustrator não expõe no item, soma os subpaths
function alArea(it) {
    if (it.typename !== "CompoundPathItem") return it.area;
    var a = 0;
    for (var i = 0; i < it.pathItems.length; i++) a += it.pathItems[i].area;
    return a;
}

function alLength(it) {
    if (it.typename !== "CompoundPathItem") return it.length;
    var l = 0;
    for (var i = 0; i < it.pathItems.length; i++) l += it.pathItems[i].length;
    return l;
}

function alPointCount(it) {
    if (it.typename !== "CompoundPathItem") return it.pathPoints.length;
    var n = 0;
    for (var i = 0; i < it.pathItems.length; i++) n += it.pathItems[i].pathPoints.length * 1000 + 1;
    return n;
}

// Resumo barato de um líquido pra vigilância: nada de ler pontos (exceto o
// 1º âncora de cada forma, que pega espelhar/girar 180° sem mudar a caixa).
function alDescribe(g, meta) {
    var srcs = alSources(g, [], 0), list = [];
    for (var i = 0; i < srcs.length; i++) {
        var s = srcs[i], b = s.geometricBounds;
        list.push({
            u: s.uuid, t: s.typename === "CompoundPathItem" ? "c" : "p",
            b: [r3(b[0]), r3(b[1]), r3(b[2]), r3(b[3])],
            a: r3(alArea(s)), l: r3(alLength(s)), n: alPointCount(s), p0: alFirstPoint(s)
        });
    }
    var out = alFindOut(g), outNote = out ? String(out.note).split("|") : [];
    return {
        u: g.uuid, name: g.name, params: meta.params,
        outSig: outNote[1] || "", outStyle: outNote[2] || "",
        style: srcs.length ? alStyleKey(srcs[0]) : "-",
        srcs: list
    };
}

function alScan(doc) {
    var found = [], gs = doc.groupItems;
    for (var i = 0; i < gs.length; i++) {
        if (alMeta(gs[i])) found.push(gs[i].uuid);
    }
    return found;
}

// Líquido "ativo" = o que contém a seleção atual (ou o próprio grupo).
function alActive(doc) {
    var sel = doc.selection;
    if (!sel || !sel.length) return null;
    var it = sel[0];
    for (var guard = 0; it && guard < 12; guard++) {
        if (it.typename === "GroupItem" && alMeta(it)) return it;
        try { it = it.parent; } catch (e) { return null; }
        if (!it || it.typename === "Layer" || it.typename === "Document") return null;
    }
    return null;
}

function alRegister(doc, uuid) {
    var G = $.global.__AL, key = doc.name;
    if (!G.reg[key]) G.reg[key] = [];
    for (var i = 0; i < G.reg[key].length; i++) if (G.reg[key][i] === uuid) return;
    G.reg[key].push(uuid);
}

// ===== pontos de entrada =====

function AL_ping() {
    return alJ({ ok: true, version: AL_VERSION, app: app.version, docs: app.documents.length });
}

// Vigilância: devolve o resumo de todos os líquidos do documento ativo.
// Reescaneia o documento só quando a quantidade de grupos muda (cópia,
// colagem, desfazer de exclusão) ou de tempos em tempos.
function AL_poll() {
    try {
        if (app.documents.length === 0) return alJ({ doc: null, liquids: [] });
        var doc = app.activeDocument, key = doc.name, G = $.global.__AL;
        var glen = doc.groupItems.length;
        G.polls++;
        if (!G.reg[key] || G.glen[key] !== glen || G.polls % 100 === 0) {
            G.reg[key] = alScan(doc);
            G.glen[key] = glen;
        }
        var reg = G.reg[key], alive = [], liquids = [];
        for (var i = 0; i < reg.length; i++) {
            var g = alItem(doc, reg[i]);
            if (!g || g.typename !== "GroupItem") continue;
            var meta = alMeta(g);
            if (!meta) continue;
            alive.push(reg[i]);
            liquids.push(alDescribe(g, meta));
        }
        G.reg[key] = alive;
        var act = alActive(doc);
        var sel = doc.selection;
        return alJ({ doc: key, active: act ? act.uuid : null, selCount: sel ? sel.length : 0, liquids: liquids });
    } catch (e) {
        return alErr(e.message + " (linha " + e.line + ")");
    }
}

// Geometria completa das formas pedidas (uuids separados por vírgula; vazio
// = todas). Pontos: [ax,ay, lx,ly, rx,ry, ...] por subpath.
function AL_read(groupUuid, uuidCsv) {
    try {
        var doc = app.activeDocument;
        var g = alItem(doc, groupUuid);
        if (!g) return alErr("Líquido não encontrado.");
        var want = null;
        if (uuidCsv) {
            want = {};
            var ids = uuidCsv.split(",");
            for (var w = 0; w < ids.length; w++) want[ids[w]] = true;
        }
        var srcs = alSources(g, [], 0), res = [];
        for (var i = 0; i < srcs.length; i++) {
            var s = srcs[i];
            if (want && !want[s.uuid]) continue;
            var paths = s.typename === "CompoundPathItem" ? s.pathItems : [s];
            var subs = [];
            for (var k = 0; k < paths.length; k++) {
                var pp = paths[k].pathPoints, pts = [];
                for (var j = 0; j < pp.length; j++) {
                    var P = pp[j], a = P.anchor, l = P.leftDirection, r = P.rightDirection;
                    pts.push(r3(a[0]), r3(a[1]), r3(l[0]), r3(l[1]), r3(r[0]), r3(r[1]));
                }
                subs.push({ c: paths[k].closed, p: pts });
            }
            var b = s.geometricBounds;
            res.push({ u: s.uuid, b: [r3(b[0]), r3(b[1]), r3(b[2]), r3(b[3])], p0: alFirstPoint(s), subs: subs });
        }
        return alJ({ srcs: res });
    } catch (e) {
        return alErr(e.message + " (linha " + e.line + ")");
    }
}

// Escreve o contorno. data = laços separados por ";" e números por ","
// (ax,ay,lx,ly,rx,ry,...). params != "" também grava os parâmetros no grupo
// — na mesma chamada, pra virar um passo só de desfazer.
function AL_write(groupUuid, geoSig, styleSig, data, params, syncStyle) {
    try {
        var doc = app.activeDocument;
        var g = alItem(doc, groupUuid);
        if (!g) return alErr("Líquido não encontrado.");
        if (params) g.note = AL_GROUP_TAG + "1|" + params;

        var loops = data ? data.split(";") : [];
        var out = alFindOut(g);
        var srcs = alSources(g, [], 0);
        if (!loops.length || !srcs.length) {
            if (out) { out.locked = false; out.remove(); }
            return alJ({ ok: true, loops: 0 });
        }
        var fresh = false;
        if (!out) {
            out = g.compoundPathItems.add();
            out.move(g, ElementPlacement.PLACEATBEGINNING);
            out.name = AL_OUT_NAME;
            fresh = true;
        }
        out.locked = false;
        var subs = out.pathItems;
        for (var i = 0; i < loops.length; i++) {
            var nums = loops[i].split(","), n = nums.length / 6;
            var anchors = [];
            for (var k = 0; k < n; k++) anchors.push([+nums[k * 6], +nums[k * 6 + 1]]);
            var p = i < subs.length ? subs[i] : out.pathItems.add();
            p.setEntirePath(anchors);
            var pts = p.pathPoints;
            for (var j = 0; j < n; j++) {
                var q = pts[j];
                q.leftDirection = [+nums[j * 6 + 2], +nums[j * 6 + 3]];
                q.rightDirection = [+nums[j * 6 + 4], +nums[j * 6 + 5]];
            }
            p.closed = true;
        }
        for (var z = subs.length - 1; z >= loops.length; z--) subs[z].remove();
        if (fresh || syncStyle) alCopyStyle(srcs[0], out);
        out.note = AL_OUT_TAG + geoSig + "|" + styleSig;
        out.locked = true;
        return alJ({ ok: true, loops: loops.length, created: fresh });
    } catch (e) {
        return alErr(e.message + " (linha " + e.line + ")");
    }
}

function alZ(it) { try { return it.absoluteZOrderPosition; } catch (e) { return 0; } }

function alInsideLiquid(it) {
    var p = it;
    for (var guard = 0; p && guard < 12; guard++) {
        if (p.typename === "GroupItem" && alMeta(p)) return true;
        try { p = p.parent; } catch (e) { return false; }
        if (!p || p.typename === "Layer" || p.typename === "Document") return false;
    }
    return false;
}

// Transforma a seleção num líquido. Um grupo comum selecionado sozinho vira
// o próprio líquido; várias formas são agrupadas na posição da mais alta.
function AL_create(params) {
    try {
        if (app.documents.length === 0) return alErr("Abra um documento no Illustrator.");
        var doc = app.activeDocument, sel = doc.selection;
        if (!sel || !sel.length) return alErr("Selecione as formas que vão virar líquido.");
        var items = [], skipped = 0;
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i], t = it.typename;
            if (alInsideLiquid(it)) return alErr("A seleção já faz parte de um líquido.");
            if (t === "PathItem" || t === "CompoundPathItem" || t === "GroupItem") items.push(it);
            else skipped++;
        }
        if (!items.length) return alErr("Nada aproveitável na seleção (use formas: círculos, retângulos, paths).");
        var g;
        if (items.length === 1 && items[0].typename === "GroupItem") {
            g = items[0];
        } else {
            items.sort(function (a, b) { return alZ(b) - alZ(a); });
            var top = items[0];
            g = top.parent.groupItems.add();
            g.move(top, ElementPlacement.PLACEBEFORE);
            for (var k = 0; k < items.length; k++) {
                var wasLocked = items[k].locked;
                if (wasLocked) items[k].locked = false;
                items[k].move(g, ElementPlacement.PLACEATEND);
                if (wasLocked) items[k].locked = true;
            }
        }
        if (!alSources(g, [], 0).length) return alErr("O grupo não tem formas visíveis.");
        g.name = AL_GROUP_NAME;
        g.note = AL_GROUP_TAG + "1|" + params;
        alRegister(doc, g.uuid);
        doc.selection = null;
        g.selected = true;
        return alJ({ ok: true, u: g.uuid, skipped: skipped });
    } catch (e) {
        return alErr(e.message + " (linha " + e.line + ")");
    }
}

// Desfaz o líquido: apaga o contorno e devolve as formas ao lugar do grupo.
function AL_release(groupUuid) {
    try {
        var doc = app.activeDocument, g = alItem(doc, groupUuid);
        if (!g) return alErr("Líquido não encontrado.");
        var out = alFindOut(g);
        if (out) { out.locked = false; out.remove(); }
        while (g.pageItems.length) {
            var it = g.pageItems[0], wasLocked = it.locked;
            if (wasLocked) it.locked = false;
            it.move(g, ElementPlacement.PLACEBEFORE);
            if (wasLocked) it.locked = true;
        }
        g.remove();
        return alJ({ ok: true });
    } catch (e) {
        return alErr(e.message + " (linha " + e.line + ")");
    }
}

// Expande: o contorno vira um path comum no lugar do grupo; as formas-fonte
// saem (desfazer traz tudo de volta).
function AL_expand(groupUuid) {
    try {
        var doc = app.activeDocument, g = alItem(doc, groupUuid);
        if (!g) return alErr("Líquido não encontrado.");
        var out = alFindOut(g);
        if (!out) return alErr("Esse líquido ainda não tem contorno.");
        out.locked = false;
        out.move(g, ElementPlacement.PLACEBEFORE);
        out.note = "";
        out.name = g.name + " (expandido)";
        g.remove();
        doc.selection = null;
        out.selected = true;
        return alJ({ ok: true, u: out.uuid });
    } catch (e) {
        return alErr(e.message + " (linha " + e.line + ")");
    }
}

// Seleciona o grupo líquido (útil depois de criar ou pelo painel).
function AL_select(groupUuid) {
    try {
        var doc = app.activeDocument, g = alItem(doc, groupUuid);
        if (!g) return alErr("Líquido não encontrado.");
        doc.selection = null;
        g.selected = true;
        return alJ({ ok: true });
    } catch (e) {
        return alErr(e.message);
    }
}
