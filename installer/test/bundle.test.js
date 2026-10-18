"use strict";

// Confere a pasta panel/ do repositório — a que vai dentro do instalador —
// antes de empacotar: id e versão batendo com o instalador, arquivos que o
// manifest cita existindo, e as cópias do motor/host iguais às fontes.

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var detect = require("../src/detect");

var ROOT = path.join(__dirname, "..", "..");
var PANEL = path.join(ROOT, "panel");
var manifest = fs.readFileSync(path.join(PANEL, "CSXS", "manifest.xml"), "utf8");
var pkg = require("../package.json");

// ---- id e versão ----
assert.strictEqual((manifest.match(/ExtensionBundleId="([^"]+)"/) || [])[1], detect.PANEL_ID,
    "ExtensionBundleId do manifest tem que ser " + detect.PANEL_ID + " (mesma pasta do AutoLiquid 1)");
var version = detect.readPanelVersion(PANEL);
assert.strictEqual(version, pkg.version,
    "versão do painel (" + version + ") e do instalador (" + pkg.version + ") diferentes: suba as duas juntas");
console.log("manifest: OK (" + detect.PANEL_ID + " " + version + ")");

// ---- arquivos citados no manifest ----
var cited = [];
manifest.replace(/<(MainPath|ScriptPath|Icon[^>]*)>\.\/([^<]+)</g, function (m, tag, rel) { cited.push(rel); return m; });
assert.ok(cited.indexOf("index.html") >= 0 && cited.indexOf("jsx/host.jsx") >= 0, "MainPath/ScriptPath não encontrados no manifest");
var icons = cited.filter(function (rel) { return /^icons\//.test(rel); });
assert.strictEqual(icons.length, 4, "esperava 4 ícones (Normal, RollOver, DarkNormal, DarkRollOver), achei " + icons.length);
cited.forEach(function (rel) {
    assert.ok(fs.existsSync(path.join(PANEL, rel)), "o manifest cita " + rel + ", que não existe em panel/");
});
// o CEP procura sozinho a versão @2X ao lado de cada ícone (telas de alta densidade)
function pngSize(file) {
    var b = fs.readFileSync(file);
    assert.strictEqual(b.toString("ascii", 1, 4), "PNG", file + " não é PNG");
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
icons.forEach(function (rel) {
    var one = path.join(PANEL, rel);
    var two = one.replace(/\.png$/, "@2X.png");
    assert.ok(fs.existsSync(two), "falta " + path.relative(PANEL, two));
    assert.deepStrictEqual(pngSize(one), [23, 23], rel + " tem que ter 23x23");
    assert.deepStrictEqual(pngSize(two), [46, 46], path.relative(PANEL, two) + " tem que ter 46x46");
});
console.log("arquivos do manifest: OK (" + cited.length + " citados, ícones 23x23 + @2X 46x46)");

// ---- cópias do motor/host dentro do painel ----
[
    ["engine/liquid-core.js", "panel/js/liquid-core.js"],
    ["engine/liquid-controller.js", "panel/js/liquid-controller.js"],
    ["host/liquid-host.jsx", "panel/jsx/host.jsx"]
].forEach(function (pair) {
    var a = fs.readFileSync(path.join(ROOT, pair[0]));
    var b = fs.readFileSync(path.join(ROOT, pair[1]));
    assert.ok(a.equals(b), pair[1] + " está diferente de " + pair[0] + " — rode `node tools/install-panel.js` para sincronizar");
});
console.log("cópias do motor/host: OK (iguais a engine/ e host/)");

console.log("ALL bundle CHECKS PASSED");
