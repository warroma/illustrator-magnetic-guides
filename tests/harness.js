// Harness do motor: testes de correção + métricas de comportamento de cada
// curva + desempenho + relatório visual (relatorio/comparativo.html).
// Uso: node tests/harness.js
"use strict";
const fs = require("fs");
const path = require("path");
const L = require("../engine/liquid-core.js");
const { circle, ellipse, rect, polygon } = L.shapes;

let fails = 0, passes = 0;
function check(name, ok, detail) {
    if (ok) passes++; else fails++;
    console.log((ok ? "  ok   " : "  FALHA ") + name + (detail ? "  — " + detail : ""));
}

// Amostra os béziers de saída e mede |F| (quanto a curva desenhada se afasta
// do contorno matemático exato).
function maxFieldError(shapes, params, result) {
    const field = L.makeField(L.prepareShapes(shapes, 0.005), params.kernel || "poly", params.reach, params);
    const g = params.grow || 0;
    let worst = 0;
    for (const p of result.paths) {
        const a = p.pts, n = a.length / 6;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const P0 = [a[i * 6], a[i * 6 + 1]], P1 = [a[i * 6 + 4], a[i * 6 + 5]];
            const P2 = [a[j * 6 + 2], a[j * 6 + 3]], P3 = [a[j * 6], a[j * 6 + 1]];
            for (let s = 0; s <= 8; s++) {
                const t = s / 8, u = 1 - t;
                const x = u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0];
                const y = u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1];
                worst = Math.max(worst, Math.abs(field.F(x, y) - g));
            }
        }
    }
    return worst;
}

function totalArea(r) { return r.paths.reduce((s, p) => s + p.area, 0); }

// path "orgânico" com âncoras bézier suaves (alças por Catmull-Rom)
function blobPathShape(nAnch) {
    const P = [];
    for (let i = 0; i < nAnch; i++) {
        const a = i / nAnch * Math.PI * 2, r = 120 + 25 * Math.sin(a * 7) + 10 * Math.cos(a * 13);
        P.push([300 + r * Math.cos(a), 300 + r * Math.sin(a)]);
    }
    const pts = [];
    for (let i = 0; i < nAnch; i++) {
        const p = P[i], pr = P[(i - 1 + nAnch) % nAnch], nx = P[(i + 1) % nAnch];
        const tx = (nx[0] - pr[0]) / 6, ty = (nx[1] - pr[1]) / 6;
        pts.push(p[0], p[1], p[0] - tx, p[1] - ty, p[0] + tx, p[1] + ty);
    }
    return { id: "blob", subpaths: [{ closed: true, pts }] };
}

// Bissecção no campo ao longo de um segmento [a,b] (F(a)<0<F(b) ou o contrário)
function zeroOn(F, ax, ay, bx, by) {
    let fa = F(ax, ay), fb = F(bx, by);
    if ((fa < 0) === (fb < 0)) return null;
    for (let i = 0; i < 60; i++) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2, fm = F(mx, my);
        if ((fm < 0) === (fa < 0)) { ax = mx; ay = my; fa = fm; } else { bx = mx; by = my; fb = fm; }
    }
    return [(ax + bx) / 2, (ay + by) / 2];
}

// ===== Variantes avaliadas =====
const VARIANTS = [
    { key: "hard", label: "União dura", kernel: "hard" },
    { key: "p1", label: "Polinomial p=1 (chanfro, tensa)", kernel: "poly", tension: 1 },
    { key: "p2", label: "Polinomial p=2 (quadrática IQ)", kernel: "poly", tension: 2 },
    { key: "p3", label: "Polinomial p=3 (cúbica)", kernel: "poly", tension: 3 },
    { key: "p6", label: "Polinomial p=6 (mole)", kernel: "poly", tension: 6 },
    { key: "circ", label: "Circular (= Offset nativo)", kernel: "circ" },
    { key: "root", label: "Raiz (a do vídeo)", kernel: "root" },
    { key: "exp", label: "Exponencial N-ária", kernel: "exp" }
];

// ===== 1. Correção =====
console.log("\n== Correção ==");
{
    // BVH x força bruta (distância e sinal), com furo (par-ímpar)
    const ring = { id: "ring", subpaths: ellipse("o", 0, 0, 80, 50).subpaths.concat(ellipse("i", 10, 0, 30, 20).subpaths) };
    const sh = [ellipse("e", 0, 0, 60, 25), ring, blobPathShape(300)];
    const prep = L.prepareShapes(sh, 0.02);
    let worst = 0, signErr = 0, s = 3;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const S of prep) {
        for (let k = 0; k < 4000; k++) {
            const x = S.minX - 40 + rnd() * (S.maxX - S.minX + 80), y = S.minY - 40 + rnd() * (S.maxY - S.minY + 80);
            let best = Infinity, inside = false;
            const g = S.segs;
            for (let i = 0; i < g.length; i += 4) {
                const x0 = g[i], y0 = g[i + 1], x1 = g[i + 2], y1 = g[i + 3];
                const ex = x1 - x0, ey = y1 - y0, ll = ex * ex + ey * ey;
                let t = ll > 0 ? ((x - x0) * ex + (y - y0) * ey) / ll : 0; t = Math.max(0, Math.min(1, t));
                best = Math.min(best, (x - x0 - ex * t) ** 2 + (y - y0 - ey * t) ** 2);
                if ((y0 > y) !== (y1 > y) && x < x0 + (y - y0) * ex / ey) inside = !inside;
            }
            const ref = inside ? -Math.sqrt(best) : Math.sqrt(best), got = L.sdfShape(S, x, y);
            worst = Math.max(worst, Math.abs(Math.abs(ref) - Math.abs(got)));
            if ((ref < 0) !== (got < 0) && Math.abs(ref) > 1e-9) signErr++;
        }
    }
    check("BVH = força bruta (distância e sinal, com furo)", worst < 1e-9 && signErr === 0,
        "tipos " + prep.map(p => p.kind).join("/") + ", erro máx " + worst.toExponential(1) + ", sinais trocados " + signErr);
}
{
    const prep = L.prepareShapes([circle("c", 5, 5, 40), rect("r", 0, 0, 30, 20), ellipse("e", 0, 0, 40, 20)], 0.02);
    check("reconhece círculo e retângulo (analíticos), elipse fica em BVH", prep.map(p => p.kind).join(",") === "circle,box,poly", prep.map(p => p.kind).join(","));
}
{
    const r = L.compute([circle("a", 0, 0, 50)], { reach: 20 });
    const err = maxFieldError([circle("a", 0, 0, 50)], { reach: 20 }, r);
    check("círculo isolado continua círculo", r.paths.length === 1 && err < 0.1, "desvio máx " + err.toFixed(4) + " pt, " + r.stats.anchors + " âncoras");
}
{
    const sh = [rect("r", 0, 0, 100, 60)];
    const r = L.compute(sh, { reach: 20 });
    const a = r.paths[0].pts;
    const want = [[0, 0], [100, 0], [100, 60], [0, 60]];
    let worst = 0;
    for (const w of want) {
        let best = Infinity;
        for (let i = 0; i < a.length; i += 6) best = Math.min(best, Math.hypot(a[i] - w[0], a[i + 1] - w[1]));
        worst = Math.max(worst, best);
    }
    check("retângulo mantém os 4 cantos vivos", worst < 0.05 && r.stats.anchors === 4, "canto mais longe a " + worst.toFixed(4) + " pt, " + r.stats.anchors + " âncoras");
}
{
    // estrela: cantos côncavos de UMA forma não podem ser arredondados
    const star = [];
    for (let i = 0; i < 10; i++) {
        const ang = Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 25 : 60;
        star.push([rr * Math.cos(ang), rr * Math.sin(ang)]);
    }
    const sh = [polygon("s", star)];
    const r = L.compute(sh, { reach: 30 });
    const area = Math.abs(totalArea(r));
    let exact = 0;
    for (let i = 0; i < star.length; i++) { const p = star[i], q = star[(i + 1) % star.length]; exact += p[0] * q[1] - q[0] * p[1]; }
    exact = Math.abs(exact / 2);
    check("estrela sozinha não é alterada (pregnância só age ENTRE formas)", Math.abs(area - exact) / exact < 0.002 && r.stats.anchors === 10,
        "área " + area.toFixed(1) + " vs " + exact.toFixed(1) + ", " + r.stats.anchors + " âncoras");
}
for (const V of VARIANTS) {
    if (V.kernel === "hard") continue;
    const A = 24, R = 40;
    const near = L.compute([circle("a", -(R + A * 0.45), 0, R), circle("b", R + A * 0.45, 0, R)], { reach: A, kernel: V.kernel, tension: V.tension });
    const far = L.compute([circle("a", -(R + A * 0.55), 0, R), circle("b", R + A * 0.55, 0, R)], { reach: A, kernel: V.kernel, tension: V.tension });
    check("[" + V.key + "] conecta com vão 0,90·A e solta com 1,10·A", near.paths.length === 1 && far.paths.length === 2,
        "laços " + near.paths.length + " / " + far.paths.length);
}
{
    const base = [circle("a", 0, 0, 30), circle("b", 62, 10, 25), circle("c", 30, 55, 28)];
    for (const V of VARIANTS) {
        const perms = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];
        const areas = perms.map(pm => totalArea(L.compute(pm.map(i => base[i]), { reach: 20, kernel: V.kernel, tension: V.tension })));
        const spread = Math.max(...areas) - Math.min(...areas);
        check("[" + V.key + "] não depende da ordem das formas", spread < 0.5, "variação de área " + spread.toFixed(3) + " pt²");
    }
}
for (const V of VARIANTS) {
    const sh = [circle("a", 0, 0, 30), circle("b", 66, 0, 30), ellipse("c", 30, 50, 22, 14), rect("d", -20, -70, 40, 30)];
    const p = { reach: 18, kernel: V.kernel, tension: V.tension };
    const r = L.compute(sh, p);
    const err = maxFieldError(sh, p, r);
    check("[" + V.key + "] bézier desenhado colado ao contorno exato", err < 0.15, "desvio máx " + err.toFixed(4) + " pt, " + r.stats.anchors + " âncoras");
}

// ===== 2. Comportamento (2 círculos R=50, alcance A=30) =====
console.log("\n== Comportamento: 2 círculos R=50, alcance A=30 ==");
const R = 50, A = 30;
const gaps = [0, 0.25, 0.5, 0.75, 0.95, 1.1, 1.5, 2.5];
const behavior = {};
for (const V of VARIANTS) {
    const row = { neck: [], bulge: [], far: [] };
    for (const gf of gaps) {
        const g = gf * A, c = R + g / 2;
        const sh = [circle("a", -c, 0, R), circle("b", c, 0, R)];
        const { F } = L.makeField(L.prepareShapes(sh, 0.005), V.kernel, A, { tension: V.tension });
        // pescoço: largura da ponte em x=0
        let neck = 0;
        if (F(0, 0) < 0) { const z = zeroOn(F, 0, 0, 0, R * 1.5); neck = z ? 2 * z[1] : 0; }
        // inchaço frontal: quanto a face de dentro avança (antes de tocar)
        let bulge = null;
        if (F(0, 0) >= 0) { const z = zeroOn(F, -c, 0, 0, 0); bulge = z ? z[0] + g / 2 : null; }
        // lado de trás: quanto a face oposta se deforma
        const zf = zeroOn(F, -c, 0, -c - R * 1.5, 0);
        const far = zf ? (-zf[0]) - (c + R) : 0;
        row.neck.push(neck); row.bulge.push(bulge); row.far.push(far);
    }
    behavior[V.key] = row;
}
const fmt = v => v === null ? "   —  " : (v >= 0 ? " " : "") + v.toFixed(2).padStart(5);
console.log("vão/A:".padEnd(34) + gaps.map(g => g.toFixed(2).padStart(7)).join(""));
for (const V of VARIANTS) console.log(("pescoço " + V.key).padEnd(34) + behavior[V.key].neck.map(v => fmt(v).padStart(7)).join(""));
for (const V of VARIANTS) console.log(("inchaço frontal " + V.key).padEnd(34) + behavior[V.key].bulge.map(v => fmt(v).padStart(7)).join(""));
for (const V of VARIANTS) console.log(("deformação lado oposto " + V.key).padEnd(34) + behavior[V.key].far.map(v => fmt(v).padStart(7)).join(""));

// ===== 3. Desempenho =====
console.log("\n== Desempenho (ms, média de 5) ==");
function scatter(n, seed) {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const out = [];
    for (let i = 0; i < n; i++) out.push(circle("c" + i, rnd() * 600, rnd() * 600, 10 + rnd() * 30));
    return out;
}
function blobPath(nAnch) {
    const pts = [];
    for (let i = 0; i < nAnch; i++) {
        const a = i / nAnch * Math.PI * 2, r = 120 + 25 * Math.sin(a * 7) + 10 * Math.cos(a * 13);
        pts.push([300 + r * Math.cos(a), 300 + r * Math.sin(a)]);
    }
    return polygon("blob", pts);
}
const perfCases = [
    ["2 círculos", [circle("a", 0, 0, 50), circle("b", 115, 0, 50)], 20],
    ["10 círculos", scatter(10, 7), 25],
    ["40 círculos", scatter(40, 11), 20],
    ["100 círculos", scatter(100, 13), 15],
    ["path 400 âncoras + 6 círculos", [blobPath(400)].concat(scatter(6, 5)), 25],
    ["path bézier 300 âncoras + 6 círculos", [blobPathShape(300)].concat(scatter(6, 5)), 25]
];
const perf = [];
for (const [name, sh, reach] of perfCases) {
    for (const V of [VARIANTS[2], VARIANTS[6], VARIANTS[7]]) {
        L.compute(sh, { reach, kernel: V.kernel, tension: V.tension }); // aquece
        let t = 0, st;
        for (let i = 0; i < 5; i++) { const r = L.compute(sh, { reach, kernel: V.kernel, tension: V.tension }); t += r.stats.ms; st = r.stats; }
        perf.push({ name, kernel: V.key, ms: t / 5, st });
        console.log(("  " + name + " [" + V.key + "]").padEnd(44) + (t / 5).toFixed(1).padStart(7) + " ms   (contorno " + st.msExtract.toFixed(1) + " + ajuste " + st.msFit.toFixed(1) + ")  célula " + st.cell.toFixed(2) + " pt, " + st.evals + " aval., " + st.anchors + " âncoras");
    }
}

// ===== 4. Relatório visual =====
function toSvgPath(r) {
    return r.paths.map(p => {
        const a = p.pts, n = a.length / 6;
        let d = "M" + a[0].toFixed(2) + " " + (-a[1]).toFixed(2);
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            d += "C" + a[i * 6 + 4].toFixed(2) + " " + (-a[i * 6 + 5]).toFixed(2) + " " + a[j * 6 + 2].toFixed(2) + " " + (-a[j * 6 + 3]).toFixed(2) + " " + a[j * 6].toFixed(2) + " " + (-a[j * 6 + 1]).toFixed(2);
        }
        return d + "Z";
    }).join(" ");
}
function shapesOutline(sh) {
    return sh.map(s => toSvgPath({ paths: s.subpaths.map(sp => ({ pts: sp.pts })) })).join(" ");
}
function cellSvg(sh, params, vb) {
    const r = L.compute(sh, params);
    return `<svg viewBox="${vb}" class="cell"><path d="${toSvgPath(r)}" class="blob" fill-rule="nonzero"/><path d="${shapesOutline(sh)}" class="src"/></svg>`;
}
const visGaps = [0.2, 0.6, 0.9, 1.2, 1.8];
let rows = "";
for (const V of VARIANTS) {
    let cells = "";
    for (const gf of visGaps) {
        // vão medido de borda a borda: círculo A (R=50) à esquerda, B (R=38) à direita
        const g = gf * A;
        cells += "<td>" + cellSvg([circle("a", -(R + g / 2), 0, R), circle("b", 38 + g / 2, 0, 38)], { reach: A, kernel: V.kernel, tension: V.tension }, "-150 -75 300 150") + "</td>";
    }
    const trio = [circle("a", -40, 0, 34), circle("b", 40, 8, 26), rect("c", -25, 50, 60, 34), ellipse("d", 0, -62, 40, 16)];
    cells += "<td>" + cellSvg(trio, { reach: 22, kernel: V.kernel, tension: V.tension }, "-110 -120 220 220") + "</td>";
    rows += `<tr><th>${V.label}</th>${cells}</tr>`;
}
const head = "<tr><th></th>" + visGaps.map(g => `<th>vão = ${g}·A</th>`).join("") + "<th>4 formas mistas</th></tr>";
const neckRows = VARIANTS.map(V => `<tr><th>${V.label}</th>${behavior[V.key].neck.map(v => `<td>${v.toFixed(1)}</td>`).join("")}${behavior[V.key].bulge.map(v => `<td>${v === null ? "—" : v.toFixed(2)}</td>`).join("")}${behavior[V.key].far.map(v => `<td>${v.toFixed(2)}</td>`).join("")}</tr>`).join("");
const perfRows = perf.map(p => `<tr><td>${p.name}</td><td>${p.kernel}</td><td>${p.ms.toFixed(1)} ms</td><td>${p.st.cell.toFixed(2)} pt</td><td>${p.st.anchors}</td></tr>`).join("");
const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curvas de líquido</title>
<style>
:root{--bg:#f6f5f2;--ink:#1d1c1a;--mute:#6d6a64;--line:#dcd8d0;--blob:#3b5bdb;--src:#e8590c;--card:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#17181a;--ink:#ecebe8;--mute:#9a978f;--line:#2e3034;--blob:#748ffc;--src:#ff922b;--card:#1f2023}}
:root[data-theme="dark"]{--bg:#17181a;--ink:#ecebe8;--mute:#9a978f;--line:#2e3034;--blob:#748ffc;--src:#ff922b;--card:#1f2023}
body{background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px}p{color:var(--mute);max-width:70ch;margin:4px 0}
.wrap{overflow-x:auto}table{border-collapse:collapse;background:var(--card)}th,td{border:1px solid var(--line);padding:6px 8px;text-align:center;font-weight:400}
th{font-size:12px;color:var(--mute);white-space:nowrap}tr th:first-child{text-align:left;color:var(--ink)}
.cell{width:170px;height:auto;display:block}.blob{fill:var(--blob);fill-opacity:.85}.src{fill:none;stroke:var(--src);stroke-width:1.6;stroke-dasharray:5 3;vector-effect:non-scaling-stroke}
td{font-variant-numeric:tabular-nums}
</style></head><body>
<h1>Curvas de líquido — comparativo</h1>
<p>Azul = resultado do motor; tracejado laranja = formas originais. Todas as curvas estão normalizadas pelo <b>alcance A</b>: duas formas iguais se tocam quando o vão fica menor que A. Esquerda: círculos R=50 e R=38, A=30.</p>
<div class="wrap"><table>${head}${rows}</table></div>
<h2>Medidas (2 círculos R=50, A=30)</h2>
<p>Pescoço = largura da ponte no meio (0 = ainda não tocou). Inchaço = quanto a face interna avança antes de tocar. Lado oposto = quanto a face de trás se deforma (ideal: 0).</p>
<div class="wrap"><table><tr><th>vão/A</th>${gaps.map(g => `<th>pesc. ${g}</th>`).join("")}${gaps.map(g => `<th>inch. ${g}</th>`).join("")}${gaps.map(g => `<th>oposto ${g}</th>`).join("")}</tr>${neckRows}</table></div>
<h2>Desempenho (Node, média de 5)</h2>
<div class="wrap"><table><tr><th>cena</th><th>curva</th><th>tempo</th><th>célula</th><th>âncoras</th></tr>${perfRows}</table></div>
</body></html>`;
const outDir = path.join(__dirname, "..", "relatorio");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "comparativo.html"), html);
console.log("\nRelatório: relatorio/comparativo.html");
console.log("\n" + passes + " ok, " + fails + " falha(s)");
process.exitCode = fails ? 1 : 0;
