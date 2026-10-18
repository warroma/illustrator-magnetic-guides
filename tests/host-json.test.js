// Confere o JSON mínimo do host (alJ) contra o JSON.parse do Node.
// Uso: node tests/host-json.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "host", "liquid-host.jsx"), "utf8");
const i = src.indexOf("var AL_NEEDS_ESC"), j = src.indexOf("function alErr");
const alJ = new Function(src.slice(i, j) + "; return alJ;")();

const cases = [
    { a: "normal", b: 'com "aspas" e \\ barra', c: "linha\nnova\ttab\u0001", n: [1, 2.5, NaN], t: true, z: null },
    { name: "Líquido 2", params: "reach=26;tension=2;kernel=poly;grow=0;tol=0.1" },
    [[-1.5, 2e-7, 123456.789], "", "\u001f"]
];
let fails = 0;
for (const v of cases) {
    const out = alJ(v);
    const expect = JSON.stringify(v);   // NaN vira null nos dois
    let ok;
    try { ok = JSON.stringify(JSON.parse(out)) === expect; } catch (e) { ok = false; }
    if (!ok) fails++;
    console.log((ok ? "  ok    " : "  FALHA ") + out);
}
console.log(fails ? fails + " falha(s)" : "alJ ok");
process.exitCode = fails ? 1 : 0;
