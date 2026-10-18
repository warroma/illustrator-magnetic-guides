/*
 * liquid-core.js — motor de cálculo do AutoLiquid 2.
 *
 * Roda igual no Node (testes/CLI) e no painel CEP (Chromium). Não toca no
 * Illustrator: recebe formas como listas de pontos bézier e devolve o
 * contorno líquido como listas de pontos bézier.
 *
 * Ideia (a mesma do Desmos/shader de referência, generalizada):
 *   1. Cada forma vira um campo de distância com sinal (SDF): d < 0 dentro,
 *      d = 0 no contorno, d > 0 fora. Exato para QUALQUER path (não só
 *      círculos), calculado sobre o próprio contorno achatado em segmentos.
 *   2. Os campos se juntam por uma "união suave" (smooth min). É ela que faz
 *      as formas se puxarem e criarem a ponte. Várias curvas disponíveis
 *      (ver KERNELS). Todas são normalizadas pelo ALCANCE: duas formas iguais
 *      se tocam exatamente quando o vão entre elas fica menor que o alcance,
 *      seja qual for a curva escolhida.
 *   3. O contorno F = 0 é extraído por marching squares numa grade adaptativa
 *      (quadtree guiada pela propriedade 1-Lipschitz do campo: só refina
 *      onde o contorno pode passar), cada vértice é projetado no contorno
 *      exato (1 passo de Newton), cantos vivos são reconstruídos e o
 *      resultado vira curvas bézier (Schneider) com tangentes exatas tiradas
 *      do gradiente do campo.
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.LiquidCore = factory();
}(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    var LN2 = Math.log(2);

    // ===== União suave (smooth min) =====
    //
    // Todas recebem a e b (distâncias com sinal) e o alcance A (pt).
    // "range" diz a partir de que diferença |a-b| a curva deixa de agir
    // (Infinity = age em qualquer distância, nunca solta de vez).
    // "drop" é o quanto ela pode afundar o campo num passo (pra margem).
    var KERNELS = {
        // União dura: sem ponte. Referência.
        hard: {
            label: "União dura (sem ponte)",
            setup: function () { return { range: 0, drop: 0 }; },
            fn: function (a, b) { return a < b ? a : b; }
        },
        // Família polinomial de expoente p (a "tensão").
        //   k = p·A,  h = max(k - |a-b|, 0)/k,  smin = min(a,b) - k·h^p/(2p)
        // p = 1 → chanfro reto (ponte esticada, cantos vivos na junção)
        // p = 2 → quadrática de Inigo Quilez (a clássica)
        // p = 3 → cúbica (mais macia, C2)
        // p → ∞ → tende à exponencial: ponte mais "mole", começa a puxar
        //         de mais longe, mas sempre solta no mesmo vão A.
        poly: {
            label: "Polinomial (tensão p)",
            setup: function (A, P) {
                var p = Math.max(1, P.tension || 2);
                var k = p * A;
                return { p: p, k: k, inv: 1 / k, c: k / (2 * p), range: k, drop: A / 2 };
            },
            fn: function (a, b, S) {
                var d = a - b; if (d < 0) d = -d;
                var m = a < b ? a : b;
                if (d >= S.k) return m;
                var h = (S.k - d) * S.inv;
                return m - S.c * (S.p === 2 ? h * h : S.p === 3 ? h * h * h : Math.pow(h, S.p));
            }
        },
        // Raiz (a do vídeo/Desmos): smin = ½·(a + b − √((a−b)² + A²)).
        // Suporte infinito: tudo é levemente atraído por tudo ("magnético"),
        // as formas incham umas em direção às outras antes de tocar.
        root: {
            label: "Raiz — a do vídeo (atrai à distância)",
            setup: function (A) { return { A2: A * A, range: Infinity, drop: A / 2 }; },
            fn: function (a, b, S) {
                var d = a - b;
                return 0.5 * (a + b - Math.sqrt(d * d + S.A2));
            }
        },
        // Circular: a junção vira um arco de círculo (filete). É o que o
        // truque nativo do Illustrator (Offset +k, Unir, Offset −k) faz.
        circ: {
            label: "Circular (= Offset nativo)",
            setup: function (A) {
                var k = (A / 2) / (1 - Math.SQRT1_2);
                return { k: k, inv: 1 / k, range: k, drop: A / 2 };
            },
            fn: function (a, b, S) {
                var d = a - b; if (d < 0) d = -d;
                var m = a < b ? a : b;
                if (d >= S.k) return m;
                var h = (S.k - d) * S.inv;
                return m - S.k * 0.5 * (1 + h - Math.sqrt(1 - h * (h - 2)));
            }
        },
        // Exponencial (log-soma-exp), N-ária de verdade: não depende da
        // ordem das formas. κ = A/(2·ln2).
        exp: {
            label: "Exponencial (N-ária)",
            nary: true,
            setup: function (A) {
                var kap = A / (2 * LN2);
                return { kap: kap, inv: 1 / kap, range: 12 * kap, dropFn: function (n) { return kap * Math.log(n); } };
            },
            fnN: function (ds, n, S) {
                var m = ds[0], s = 0;
                for (var i = 0; i < n; i++) s += Math.exp(-(ds[i] - m) * S.inv);
                return m - S.kap * Math.log(s);
            }
        }
    };

    // ===== Geometria: achatar béziers em segmentos =====

    // pts = [ax,ay, lx,ly, rx,ry, ...] por ponto (convenção do Illustrator:
    // left = alça de entrada, right = alça de saída).
    function flattenSubpath(sp, tol, out) {
        var p = sp.pts, n = p.length / 6;
        if (n < 2) return;
        var segs = sp.closed ? n : n - 1;
        for (var i = 0; i < segs; i++) {
            var j = (i + 1) % n;
            var x0 = p[i * 6], y0 = p[i * 6 + 1];
            var x1 = p[i * 6 + 4], y1 = p[i * 6 + 5];
            var x2 = p[j * 6 + 2], y2 = p[j * 6 + 3];
            var x3 = p[j * 6], y3 = p[j * 6 + 1];
            var ax = x0 - 2 * x1 + x2, ay = y0 - 2 * y1 + y2;
            var bx = x1 - 2 * x2 + x3, by = y1 - 2 * y2 + y3;
            var L = Math.max(Math.sqrt(ax * ax + ay * ay), Math.sqrt(bx * bx + by * by));
            var steps = L < 1e-9 ? 1 : Math.min(256, Math.max(1, Math.ceil(Math.sqrt(0.75 * L / tol))));
            var px = x0, py = y0;
            for (var s = 1; s <= steps; s++) {
                var t = s / steps, u = 1 - t;
                var b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
                var qx = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3;
                var qy = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3;
                out.push(px, py, qx, qy);
                px = qx; py = qy;
            }
        }
        // Path aberto: o Illustrator preenche como se fosse fechado.
        if (!sp.closed) {
            out.push(p[(n - 1) * 6], p[(n - 1) * 6 + 1], p[0], p[1]);
        }
    }

    // Prepara cada forma. Círculos e retângulos alinhados aos eixos são
    // reconhecidos e ganham distância analítica exata (O(1)); o resto usa os
    // segmentos achatados indexados numa BVH (O(log n) por consulta).
    function prepareShapes(shapes, tol) {
        var res = [];
        for (var i = 0; i < shapes.length; i++) {
            var arr = [];
            var sps = shapes[i].subpaths;
            for (var j = 0; j < sps.length; j++) flattenSubpath(sps[j], tol, arr);
            if (arr.length < 12) continue; // menos de 3 segmentos: sem área
            var segs = new Float64Array(arr);
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (var k = 0; k < segs.length; k += 2) {
                var x = segs[k], y = segs[k + 1];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            if (maxX - minX < 1e-6 || maxY - minY < 1e-6) continue;
            var S = { id: shapes[i].id, segs: segs, n: segs.length / 4, minX: minX, minY: minY, maxX: maxX, maxY: maxY, kind: "poly" };
            classify(S, sps.length);
            if (S.kind === "poly") S.bvh = buildBVH(segs);
            res.push(S);
        }
        return res;
    }

    function classify(S, nSub) {
        if (nSub !== 1) return;
        var w = S.maxX - S.minX, hh = S.maxY - S.minY, segs = S.segs, k, x, y;
        var cx = (S.minX + S.maxX) / 2, cy = (S.minY + S.maxY) / 2;
        // círculo: caixa quadrada e todos os vértices a raio constante (o
        // círculo bézier de 4 pontos erra no máximo 0,027% do raio)
        if (Math.abs(w - hh) <= 1e-3 * Math.max(w, hh)) {
            var r = w / 2, tolR = 6e-4 * r + 0.004, ok = true;
            for (k = 0; k < segs.length && ok; k += 2) {
                x = segs[k] - cx; y = segs[k + 1] - cy;
                if (Math.abs(Math.sqrt(x * x + y * y) - r) > tolR) ok = false;
            }
            if (ok) { S.kind = "circle"; S.cx = cx; S.cy = cy; S.r = r; return; }
        }
        // retângulo alinhado: todo vértice na borda da caixa e área = caixa
        var e = 1e-6 * Math.max(w, hh) + 1e-6, area = 0;
        for (k = 0; k < segs.length; k += 4) {
            var x0 = segs[k], y0 = segs[k + 1], x1 = segs[k + 2], y1 = segs[k + 3];
            if (!onBox(S, x0, y0, e)) return;
            area += x0 * y1 - x1 * y0;
        }
        if (Math.abs(Math.abs(area / 2) - w * hh) > 1e-6 * w * hh) return;
        S.kind = "box"; S.cx = cx; S.cy = cy; S.hx = w / 2; S.hy = hh / 2;
    }

    function onBox(S, x, y, e) {
        return Math.abs(x - S.minX) < e || Math.abs(x - S.maxX) < e || Math.abs(y - S.minY) < e || Math.abs(y - S.maxY) < e;
    }

    // ===== BVH de segmentos =====
    //
    // Nós em arrays planos. Folha guarda até 4 segmentos (índices em "idx").
    function buildBVH(segs) {
        var n = segs.length / 4;
        var idx = new Int32Array(n), cxs = new Float64Array(n), cys = new Float64Array(n);
        for (var i = 0; i < n; i++) {
            idx[i] = i;
            cxs[i] = (segs[i * 4] + segs[i * 4 + 2]) / 2;
            cys[i] = (segs[i * 4 + 1] + segs[i * 4 + 3]) / 2;
        }
        var cap = Math.max(4, 2 * Math.ceil(n / 2) + 2);
        var bx0 = new Float64Array(cap), by0 = new Float64Array(cap), bx1 = new Float64Array(cap), by1 = new Float64Array(cap);
        var left = new Int32Array(cap), start = new Int32Array(cap), count = new Int32Array(cap);
        var used = 0;
        function grow() {
            var nc = cap * 2;
            function g(a, T) { var b = new T(nc); b.set(a); return b; }
            bx0 = g(bx0, Float64Array); by0 = g(by0, Float64Array); bx1 = g(bx1, Float64Array); by1 = g(by1, Float64Array);
            left = g(left, Int32Array); start = g(start, Int32Array); count = g(count, Int32Array);
            cap = nc;
        }
        function build(s, e) {
            if (used >= cap) grow();
            var node = used++;
            var a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
            var ca = Infinity, cb = Infinity, cc = -Infinity, cd = -Infinity;
            for (var k = s; k < e; k++) {
                var q = idx[k] * 4;
                var x0 = segs[q], y0 = segs[q + 1], x1 = segs[q + 2], y1 = segs[q + 3];
                if (x0 < a) a = x0; if (x1 < a) a = x1; if (x0 > c) c = x0; if (x1 > c) c = x1;
                if (y0 < b) b = y0; if (y1 < b) b = y1; if (y0 > d) d = y0; if (y1 > d) d = y1;
                var cx = cxs[idx[k]], cy = cys[idx[k]];
                if (cx < ca) ca = cx; if (cx > cc) cc = cx; if (cy < cb) cb = cy; if (cy > cd) cd = cy;
            }
            bx0[node] = a; by0[node] = b; bx1[node] = c; by1[node] = d;
            if (e - s <= 4) { left[node] = -1; start[node] = s; count[node] = e - s; return node; }
            var axisX = (cc - ca) >= (cd - cb);
            var sub = Array.prototype.slice.call(idx.subarray(s, e));
            sub.sort(axisX ? function (p, q) { return cxs[p] - cxs[q]; } : function (p, q) { return cys[p] - cys[q]; });
            for (var m = 0; m < sub.length; m++) idx[s + m] = sub[m];
            var mid = (s + e) >> 1;
            build(s, mid);
            var rightNode = build(mid, e);
            left[node] = node + 1; start[node] = rightNode; count[node] = 0;
            return node;
        }
        build(0, n);
        return { segs: segs, idx: idx, bx0: bx0, by0: by0, bx1: bx1, by1: by1, left: left, start: start, count: count, stack: new Int32Array(256) };
    }

    function boxDist2(B, node, x, y) {
        var dx = x < B.bx0[node] ? B.bx0[node] - x : (x > B.bx1[node] ? x - B.bx1[node] : 0);
        var dy = y < B.by0[node] ? B.by0[node] - y : (y > B.by1[node] ? y - B.by1[node] : 0);
        return dx * dx + dy * dy;
    }

    function segDist2(segs, q, x, y) {
        var x0 = segs[q], y0 = segs[q + 1];
        var ex = segs[q + 2] - x0, ey = segs[q + 3] - y0;
        var wx = x - x0, wy = y - y0;
        var ll = ex * ex + ey * ey;
        var t = ll > 0 ? (wx * ex + wy * ey) / ll : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var dx = wx - ex * t, dy = wy - ey * t;
        return dx * dx + dy * dy;
    }

    function bvhSdf(B, x, y) {
        var segs = B.segs, idx = B.idx, stack = B.stack, sp = 0, best = Infinity, k, q, node;
        // distância: busca do mais próximo com poda
        stack[sp++] = 0;
        while (sp > 0) {
            node = stack[--sp];
            if (boxDist2(B, node, x, y) >= best) continue;
            if (B.left[node] < 0) {
                for (k = B.start[node], q = k + B.count[node]; k < q; k++) {
                    var d2 = segDist2(segs, idx[k] * 4, x, y);
                    if (d2 < best) best = d2;
                }
            } else {
                var l = B.left[node], r = B.start[node];
                var dl = boxDist2(B, l, x, y), dr = boxDist2(B, r, x, y);
                if (dl < dr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
            }
        }
        // sinal: paridade de cruzamentos de um raio horizontal pra direita
        var inside = false;
        stack[sp++] = 0;
        while (sp > 0) {
            node = stack[--sp];
            if (B.by1[node] <= y || B.by0[node] > y || B.bx1[node] <= x) continue;
            if (B.left[node] < 0) {
                for (k = B.start[node], q = k + B.count[node]; k < q; k++) {
                    var s = idx[k] * 4;
                    var y0 = segs[s + 1], y1 = segs[s + 3];
                    if ((y0 > y) !== (y1 > y)) {
                        var x0 = segs[s];
                        if (x < x0 + (y - y0) * (segs[s + 2] - x0) / (y1 - y0)) inside = !inside;
                    }
                }
            } else {
                stack[sp++] = B.left[node]; stack[sp++] = B.start[node];
            }
        }
        var d = Math.sqrt(best);
        return inside ? -d : d;
    }

    // Distância com sinal até o contorno da forma (par-ímpar para furos).
    function sdfShape(S, x, y) {
        if (S.kind === "circle") {
            var dx = x - S.cx, dy = y - S.cy;
            return Math.sqrt(dx * dx + dy * dy) - S.r;
        }
        if (S.kind === "box") {
            var qx = Math.abs(x - S.cx) - S.hx, qy = Math.abs(y - S.cy) - S.hy;
            var ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
            var inner = qx > qy ? qx : qy;
            return Math.sqrt(ox * ox + oy * oy) + (inner < 0 ? inner : 0);
        }
        return bvhSdf(S.bvh, x, y);
    }

    function bboxDist(S, x, y) {
        var dx = x < S.minX ? S.minX - x : (x > S.maxX ? x - S.maxX : 0);
        var dy = y < S.minY ? S.minY - y : (y > S.maxY ? y - S.maxY : 0);
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ===== Campo combinado =====
    //
    // "reachPad" = folga extra do índice espacial. Com ele, toda forma fora
    // da lista de uma célula está a mais de (alcance da curva + afundamento
    // máximo + reachPad) do ponto, o que garante campo exato em qualquer
    // ponto a menos de reachPad do contorno — inclusive nos cantos dos blocos
    // da quadtree, que é o que a poda por Lipschitz precisa.
    function makeField(prepared, kernelName, A, params, reachPad) {
        var K = KERNELS[kernelName];
        if (!K) throw new Error("Curva desconhecida: " + kernelName);
        var S = K.setup(A, params);
        var N = prepared.length;
        var lb = new Float64Array(N), order = new Int32Array(N), ds = new Float64Array(N);
        var cutoff = S.range;
        var stats = { evals: 0, sdf: 0 };
        var drop = S.dropFn ? S.dropFn(Math.max(2, N)) : S.drop * (1 + 0.5 * Math.min(Math.max(N - 2, 0), 6));

        // índice espacial de formas (só quando a curva tem alcance finito)
        var grid = null;
        if (isFinite(cutoff) && N > 4) {
            var E = cutoff + drop + (reachPad || 0);
            var gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
            for (var a = 0; a < N; a++) {
                gx0 = Math.min(gx0, prepared[a].minX); gy0 = Math.min(gy0, prepared[a].minY);
                gx1 = Math.max(gx1, prepared[a].maxX); gy1 = Math.max(gy1, prepared[a].maxY);
            }
            gx0 -= E; gy0 -= E; gx1 += E; gy1 += E;
            var G = Math.max(E / 2, Math.sqrt((gx1 - gx0) * (gy1 - gy0) / 16384));
            var gnx = Math.max(1, Math.ceil((gx1 - gx0) / G)), gny = Math.max(1, Math.ceil((gy1 - gy0) / G));
            var cells = new Array(gnx * gny);
            for (var c = 0; c < cells.length; c++) cells[c] = [];
            for (var s = 0; s < N; s++) {
                var P = prepared[s];
                var i0 = Math.max(0, Math.floor((P.minX - E - gx0) / G)), i1 = Math.min(gnx - 1, Math.floor((P.maxX + E - gx0) / G));
                var j0 = Math.max(0, Math.floor((P.minY - E - gy0) / G)), j1 = Math.min(gny - 1, Math.floor((P.maxY + E - gy0) / G));
                for (var jj = j0; jj <= j1; jj++) for (var ii = i0; ii <= i1; ii++) cells[jj * gnx + ii].push(s);
            }
            grid = { x0: gx0, y0: gy0, G: G, nx: gnx, ny: gny, cells: cells, E: E };
        }
        var all = [];
        for (var z = 0; z < N; z++) all.push(z);

        function F(x, y) {
            stats.evals++;
            var cand = all, i, j;
            if (grid) {
                var ci = Math.floor((x - grid.x0) / grid.G), cj = Math.floor((y - grid.y0) / grid.G);
                if (ci < 0 || cj < 0 || ci >= grid.nx || cj >= grid.ny) {
                    // fora do índice: longe de tudo; devolve um limite inferior
                    // (positivo) da distância — seguro pra poda da quadtree
                    var lbAll = Infinity;
                    for (i = 0; i < N; i++) { var bd = bboxDist(prepared[i], x, y); if (bd < lbAll) lbAll = bd; }
                    return lbAll - drop;
                }
                cand = grid.cells[cj * grid.nx + ci];
                if (cand.length === 0) return grid.E - drop;
            }
            var nc = cand.length;
            for (i = 0; i < nc; i++) {
                var si = cand[i];
                lb[i] = bboxDist(prepared[si], x, y);
                j = i;
                while (j > 0 && lb[order[j - 1]] > lb[i]) { order[j] = order[j - 1]; j--; }
                order[j] = i;
            }
            var n = 0, m = Infinity;
            for (i = 0; i < nc; i++) {
                var o = order[i];
                if (lb[o] >= m + cutoff) break;
                stats.sdf++;
                var d = sdfShape(prepared[cand[o]], x, y);
                j = n++;
                while (j > 0 && ds[j - 1] > d) { ds[j] = ds[j - 1]; j--; }
                ds[j] = d;
                if (d < m) m = d;
            }
            if (n === 0) return Infinity;
            if (K.nary) return K.fnN(ds, n, S);
            var acc = ds[0];
            for (i = 1; i < n; i++) acc = K.fn(acc, ds[i], S);
            return acc;
        }

        return { F: F, stats: stats, maxDrop: drop };
    }

    // ===== Extração do contorno =====

    function extract(field, region, h) {
        var F = field.F;
        var x0 = region.minX, y0 = region.minY;
        var nx = Math.ceil((region.maxX - x0) / h) + 1;
        var ny = Math.ceil((region.maxY - y0) / h) + 1;
        var vals = new Float64Array(nx * ny);
        for (var q = 0; q < vals.length; q++) vals[q] = NaN;
        var boundaryNegative = false;

        function V(i, j) {
            var id = j * nx + i, v = vals[id];
            if (v !== v) {
                v = F(x0 + i * h, y0 + j * h);
                vals[id] = v;
                if (v < 0 && (i === 0 || j === 0 || i === nx - 1 || j === ny - 1)) boundaryNegative = true;
            }
            return v;
        }

        var next = new Map();   // edgeId de saída -> edgeId de chegada
        var SQ2 = Math.SQRT2;

        // edge ids: horizontal (i,j)-(i+1,j) = 2*(j*nx+i); vertical (i,j)-(i,j+1) = 2*(j*nx+i)+1
        function cell(i, j) {
            var v0 = V(i, j), v1 = V(i + 1, j), v2 = V(i + 1, j + 1), v3 = V(i, j + 1);
            var c = (v0 < 0 ? 1 : 0) | (v1 < 0 ? 2 : 0) | (v2 < 0 ? 4 : 0) | (v3 < 0 ? 8 : 0);
            if (c === 0 || c === 15) return;
            var e0 = 2 * (j * nx + i);            // baixo  v0-v1
            var e1 = 2 * (j * nx + i + 1) + 1;    // direita v1-v2
            var e2 = 2 * ((j + 1) * nx + i);      // cima   v3-v2
            var e3 = 2 * (j * nx + i) + 1;        // esquerda v0-v3
            var E = [e0, e1, e2, e3];
            var ins = [c & 1, c & 2, c & 4, c & 8];
            var inOut = [], outIn = [];
            for (var k = 0; k < 4; k++) {
                var a = ins[k] ? 1 : 0, b = ins[(k + 1) % 4] ? 1 : 0;
                if (a && !b) inOut.push(k);
                else if (!a && b) outIn.push(k);
            }
            if (inOut.length === 1) {
                next.set(E[inOut[0]], E[outIn[0]]);
            } else {
                // sela: decide pelo valor exato no centro da célula
                var center = F(x0 + (i + 0.5) * h, y0 + (j + 0.5) * h);
                for (var m = 0; m < 2; m++) {
                    var kk = inOut[m];
                    var partner = center < 0 ? (kk + 1) % 4 : (kk + 3) % 4;
                    next.set(E[kk], E[partner]);
                }
            }
        }

        // quadtree: bloco de lado s células com canto (i,j)
        function block(i, j, s) {
            if (i >= nx - 1 || j >= ny - 1) return;
            var i1 = Math.min(i + s, nx - 1), j1 = Math.min(j + s, ny - 1);
            if (s === 1) { cell(i, j); return; }
            var a = V(i, j), b = V(i1, j), c = V(i1, j1), d = V(i, j1);
            var sameSign = (a < 0) === (b < 0) && (b < 0) === (c < 0) && (c < 0) === (d < 0);
            if (sameSign) {
                var diag = Math.max(i1 - i, j1 - j) * h * SQ2;
                var mn = Math.min(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
                if (mn > diag) return; // 1-Lipschitz: o contorno não passa aqui
            }
            var hs = s >> 1;
            block(i, j, hs); block(i + hs, j, hs); block(i, j + hs, hs); block(i + hs, j + hs, hs);
        }

        var S0 = 32;
        for (var bj = 0; bj < ny - 1; bj += S0)
            for (var bi = 0; bi < nx - 1; bi += S0) block(bi, bj, S0);

        // posição de um edge id por interpolação linear
        function edgePoint(id) {
            var base = id >> 1, i = base % nx, j = (base - i) / nx;
            var va = vals[base], vb, ax = x0 + i * h, ay = y0 + j * h;
            if (id & 1) { vb = vals[base + nx]; var t = va / (va - vb); return [ax, ay + t * h]; }
            vb = vals[base + 1]; var t2 = va / (va - vb); return [ax + t2 * h, ay];
        }

        var loops = [];
        var seen = new Set();
        next.forEach(function (_, start) {
            if (seen.has(start)) return;
            var loop = [], id = start, guard = 0;
            while (!seen.has(id) && guard++ < 1e7) {
                seen.add(id);
                loop.push(edgePoint(id));
                var nid = next.get(id);
                if (nid === undefined) break;
                id = nid;
            }
            if (loop.length >= 3) loops.push(loop);
        });
        return { loops: loops, boundaryNegative: boundaryNegative, grid: { nx: nx, ny: ny, h: h } };
    }

    // ===== Refino: Newton + normais + cantos =====

    // Cada vértice do marching squares é projetado no contorno exato com um
    // passo de Newton (o campo é quase linear perto do contorno, 1 passo
    // basta). O gradiente sai de diferenças pra frente (3 avaliações por
    // vértice) e vira a normal usada nas tangentes.
    //
    // Depois, entre vizinhos cuja normal gira mais que ~10°, insere o ponto
    // do meio (também projetado) até a curva ficar bem amostrada. Se o giro
    // não diminui mesmo com os pontos colados, é canto vivo de verdade: o
    // canto exato é a interseção das duas tangentes.
    function refineLoop(F, loop, h, cornerDeg) {
        var eps = h * 1e-3;
        var maxStep = h * 0.75;
        var cosSmooth = Math.cos(10 * Math.PI / 180);
        var cosCorner = Math.cos((cornerDeg || 25) * Math.PI / 180);
        var minLen = h / 48;
        // Um passo de Newton. O SDF tem |∇F| ≈ 1; se a diferença pra frente
        // der algo bem diferente disso, o ponto está em cima de uma dobra do
        // campo (eixo medial, ex.: a diagonal interna de um retângulo) e o
        // gradiente central desempata. "strict" = ponto de refino: precisa
        // terminar colado no contorno, senão é descartado (devolve null).
        function project(x, y, strict) {
            var f = F(x, y);
            var gx = (F(x + eps, y) - f) / eps, gy = (F(x, y + eps) - f) / eps;
            var gg = gx * gx + gy * gy;
            if (gg < 0.49 || gg > 1.69) {
                gx = (F(x + eps, y) - F(x - eps, y)) / (2 * eps);
                gy = (F(x, y + eps) - F(x, y - eps)) / (2 * eps);
                gg = gx * gx + gy * gy;
            }
            if (gg < 1e-6) return strict ? null : { x: x, y: y, nx: NaN, ny: NaN, corner: false };
            var sx = f * gx / gg, sy = f * gy / gg;
            var sl = Math.sqrt(sx * sx + sy * sy);
            if (sl > maxStep) { sx *= maxStep / sl; sy *= maxStep / sl; }
            x -= sx; y -= sy;
            if (strict && Math.abs(F(x, y)) > h * 0.02) return null;
            var gl = Math.sqrt(gg);
            return { x: x, y: y, nx: gx / gl, ny: gy / gl, corner: false };
        }
        var P = [];
        for (var i = 0; i < loop.length; i++) P.push(project(loop[i][0], loop[i][1], false));
        // normal indefinida (raro): herda a direção da corda vizinha
        for (var w = 0; w < P.length; w++) {
            if (P[w].nx === P[w].nx) continue;
            var pa = P[(w - 1 + P.length) % P.length], pb = P[(w + 1) % P.length];
            var cx = pb.x - pa.x, cy = pb.y - pa.y, cl = Math.hypot(cx, cy) || 1;
            P[w].nx = cy / cl; P[w].ny = -cx / cl;
        }

        var out = [];
        function cornerBetween(a, b) {
            var tax = -a.ny, tay = a.nx, tbx = -b.ny, tby = b.nx;
            var det = tax * (-tby) - tay * (-tbx);
            if (Math.abs(det) < 1e-9) return null;
            var rx = b.x - a.x, ry = b.y - a.y;
            var s = (rx * (-tby) - ry * (-tbx)) / det;
            var qx = a.x + s * tax, qy = a.y + s * tay;
            var lim = 2 * h;
            if (Math.hypot(qx - a.x, qy - a.y) > lim || Math.hypot(qx - b.x, qy - b.y) > lim) return null;
            return { x: qx, y: qy, nx: NaN, ny: NaN, corner: true };
        }
        function between(a, b, depth) {
            var c = a.nx * b.nx + a.ny * b.ny;
            if (c >= cosSmooth) return;
            var d = Math.hypot(b.x - a.x, b.y - a.y);
            if (d < minLen || depth >= 7) {
                if (c < cosCorner) { var q = cornerBetween(a, b); if (q) out.push(q); }
                return;
            }
            var m = project((a.x + b.x) / 2, (a.y + b.y) / 2, true);
            if (!m) {
                if (c < cosCorner) { var q2 = cornerBetween(a, b); if (q2) out.push(q2); }
                return;
            }
            between(a, m, depth + 1);
            out.push(m);
            between(m, b, depth + 1);
        }
        for (var k = 0; k < P.length; k++) {
            out.push(P[k]);
            between(P[k], P[(k + 1) % P.length], 0);
        }
        // funde vértices quase coincidentes (preserva o canto)
        var merged = [];
        var tiny = h * 0.02;
        for (var m2 = 0; m2 < out.length; m2++) {
            var p = out[m2], last = merged[merged.length - 1];
            if (last && Math.hypot(p.x - last.x, p.y - last.y) < tiny) {
                if (p.corner) { last.x = p.x; last.y = p.y; last.corner = true; last.nx = last.ny = NaN; }
                continue;
            }
            merged.push(p);
        }
        if (merged.length > 2) {
            var f0 = merged[0], fl = merged[merged.length - 1];
            if (Math.hypot(f0.x - fl.x, f0.y - fl.y) < tiny) {
                if (fl.corner) { f0.x = fl.x; f0.y = fl.y; f0.corner = true; f0.nx = f0.ny = NaN; }
                merged.pop();
            }
        }
        return merged;
    }

    // ===== Ajuste de bézier (Schneider, Graphics Gems I) =====

    function v2(x, y) { return { x: x, y: y }; }
    function sub(a, b) { return v2(a.x - b.x, a.y - b.y); }
    function add(a, b) { return v2(a.x + b.x, a.y + b.y); }
    function scl(a, s) { return v2(a.x * s, a.y * s); }
    function dot(a, b) { return a.x * b.x + a.y * b.y; }
    function len(a) { return Math.sqrt(a.x * a.x + a.y * a.y); }
    function nrm(a) { var l = len(a); return l > 1e-12 ? v2(a.x / l, a.y / l) : v2(0, 0); }

    function bezPt(b, t) {
        var u = 1 - t;
        var b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
        return v2(b0 * b[0].x + b1 * b[1].x + b2 * b[2].x + b3 * b[3].x,
            b0 * b[0].y + b1 * b[1].y + b2 * b[2].y + b3 * b[3].y);
    }

    function chordParams(P, first, last) {
        var u = [0];
        for (var i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(P[i], P[i - 1])));
        var tot = u[u.length - 1];
        for (var k = 1; k < u.length; k++) u[k] = tot > 0 ? u[k] / tot : k / (u.length - 1);
        return u;
    }

    function generateBezier(P, first, last, u, t1, t2) {
        var p0 = P[first], p3 = P[last];
        var C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
        for (var i = 0; i < u.length; i++) {
            var t = u[i], s = 1 - t;
            var B0 = s * s * s, B1 = 3 * s * s * t, B2 = 3 * s * t * t, B3 = t * t * t;
            var A0 = scl(t1, B1), A1 = scl(t2, B2);
            C00 += dot(A0, A0); C01 += dot(A0, A1); C11 += dot(A1, A1);
            var tmp = sub(P[first + i], add(scl(p0, B0 + B1), scl(p3, B2 + B3)));
            X0 += dot(A0, tmp); X1 += dot(A1, tmp);
        }
        var det = C00 * C11 - C01 * C01;
        var al = det !== 0 ? (X0 * C11 - X1 * C01) / det : 0;
        var ar = det !== 0 ? (C00 * X1 - C01 * X0) / det : 0;
        var seg = len(sub(p3, p0));
        var eps = 1e-6 * seg;
        if (al < eps || ar < eps || al > seg * 3 || ar > seg * 3) { al = ar = seg / 3; }
        return [p0, add(p0, scl(t1, al)), add(p3, scl(t2, ar)), p3];
    }

    function maxError(P, first, last, b, u) {
        var maxD = 0, split = Math.floor((first + last) / 2);
        for (var i = first + 1; i < last; i++) {
            var q = bezPt(b, u[i - first]);
            var d = sub(q, P[i]), dd = dot(d, d);
            if (dd >= maxD) { maxD = dd; split = i; }
        }
        return { err: maxD, split: split };
    }

    function reparam(P, first, last, u, b) {
        var out = [];
        var d1 = [scl(sub(b[1], b[0]), 3), scl(sub(b[2], b[1]), 3), scl(sub(b[3], b[2]), 3)];
        var d2 = [scl(sub(d1[1], d1[0]), 2), scl(sub(d1[2], d1[1]), 2)];
        for (var i = first; i <= last; i++) {
            var t = u[i - first], s = 1 - t;
            var q = bezPt(b, t);
            var q1 = v2(s * s * d1[0].x + 2 * s * t * d1[1].x + t * t * d1[2].x, s * s * d1[0].y + 2 * s * t * d1[1].y + t * t * d1[2].y);
            var q2 = v2(s * d2[0].x + t * d2[1].x, s * d2[0].y + t * d2[1].y);
            var diff = sub(q, P[i]);
            var num = dot(diff, q1), den = dot(q1, q1) + dot(diff, q2);
            var nt = den !== 0 ? t - num / den : t;
            out.push(nt < 0 ? 0 : nt > 1 ? 1 : nt);
        }
        return out;
    }

    // tangente "pra frente" no ponto i, a partir da normal do campo
    function tangentAt(P, i, fwdHint) {
        var p = P[i];
        if (p.nx === p.nx) {
            var t = v2(-p.ny, p.nx);
            if (dot(t, fwdHint) < 0) t = scl(t, -1);
            return nrm(t);
        }
        return nrm(fwdHint);
    }

    // Tenta UM bézier pros pontos first..last; devolve null se não couber
    // na tolerância.
    function tryFit(P, first, last, t1, t2, err2) {
        var u = chordParams(P, first, last);
        var b = generateBezier(P, first, last, u, t1, t2);
        var r = maxError(P, first, last, b, u);
        if (r.err < err2) return { b: b };
        if (r.err < err2 * 16) {
            for (var it = 0; it < 6; it++) {
                u = reparam(P, first, last, u, b);
                b = generateBezier(P, first, last, u, t1, t2);
                r = maxError(P, first, last, b, u);
                if (r.err < err2) return { b: b };
            }
        }
        return { b: null, split: r.split };
    }

    // Schneider: ajusta, e se não couber divide no ponto de maior erro.
    // Cada segmento sai com o intervalo de pontos que cobre (pra fusão).
    function fitCubic(P, first, last, t1, t2, err2, out, depth) {
        if (last - first === 1 || depth > 40) {
            var dist = len(sub(P[last], P[first])) / 3;
            out.push({ b: [P[first], add(P[first], scl(t1, dist)), add(P[last], scl(t2, dist)), P[last]], first: first, last: last, t1: t1, t2: t2 });
            return;
        }
        var r = tryFit(P, first, last, t1, t2, err2);
        if (r.b) { out.push({ b: r.b, first: first, last: last, t1: t1, t2: t2 }); return; }
        var sp = r.split;
        var tc = tangentAt(P, sp, sub(P[sp + 1], P[sp - 1]));
        fitCubic(P, first, sp, t1, scl(tc, -1), err2, out, depth + 1);
        fitCubic(P, sp, last, tc, t2, err2, out, depth + 1);
    }

    // Funde vizinhos enquanto um bézier só ainda couber (menos âncoras).
    function mergeRuns(P, segs, err2) {
        var changed = true;
        while (changed && segs.length > 1) {
            changed = false;
            for (var i = 0; i + 1 < segs.length; i++) {
                var a = segs[i], c = segs[i + 1];
                var r = tryFit(P, a.first, c.last, a.t1, c.t2, err2);
                if (r.b) {
                    segs.splice(i, 2, { b: r.b, first: a.first, last: c.last, t1: a.t1, t2: c.t2 });
                    changed = true;
                }
            }
        }
        return segs;
    }

    function fitRun(P, first, last, t1, t2, err2, out) {
        var segs = [];
        fitCubic(P, first, last, t1, t2, err2, segs, 0);
        mergeRuns(P, segs, err2);
        for (var i = 0; i < segs.length; i++) out.push(segs[i].b);
    }

    // Converte um laço refinado em segmentos bézier [p0,c1,c2,p3].
    function fitLoop(R, tol) {
        var n = R.length;
        var err2 = tol * tol;
        var corners = [];
        for (var i = 0; i < n; i++) if (R[i].corner) corners.push(i);
        var segs = [];
        if (corners.length === 0) {
            // laço liso: começa no ponto mais à esquerda (âncora estável)
            var s0 = 0;
            for (var k = 1; k < n; k++) if (R[k].x < R[s0].x) s0 = k;
            var P = [];
            for (var q = 0; q <= n; q++) P.push(R[(s0 + q) % n]);
            var t = tangentAt(P, 0, sub(P[1], P[n - 1]));
            fitRun(P, 0, n, t, scl(t, -1), err2, segs);
            return segs;
        }
        for (var c = 0; c < corners.length; c++) {
            var a = corners[c], b = corners[(c + 1) % corners.length];
            var run = [];
            var idx = a;
            do { run.push(R[idx]); idx = (idx + 1) % n; } while (idx !== b);
            run.push(R[b]);
            if (run.length < 2) continue;
            var m = run.length - 1;
            var t1 = run.length > 2 ? tangentAt(run, 1, sub(run[2], run[0])) : nrm(sub(run[1], run[0]));
            var t2 = run.length > 2 ? scl(tangentAt(run, m - 1, sub(run[m], run[m - 2])), -1) : nrm(sub(run[m - 1], run[m]));
            // no canto a tangente é a do lado vizinho (normal do vizinho)
            fitRun(run, 0, m, t1, t2, err2, segs);
        }
        return segs;
    }

    function signedArea(loop) {
        var a = 0;
        for (var i = 0, n = loop.length; i < n; i++) {
            var p = loop[i], q = loop[(i + 1) % n];
            a += p[0] * q[1] - q[0] * p[1];
        }
        return a / 2;
    }

    // ===== API =====
    //
    // compute(shapes, params) → { paths: [{ closed, pts:[ax,ay,lx,ly,rx,ry,...] }], stats }
    // params: reach (pt, obrigatório), kernel ("poly"), tension (p, 2),
    //         grow (pt, 0: engorda/emagrece tudo), cell (pt, auto),
    //         tolerance (pt, 0.08), cornerDeg (25)
    function compute(shapes, params) {
        var t0 = now();
        params = params || {};
        var A = Math.max(1e-3, +params.reach || 0);
        var kernel = params.kernel || "poly";
        var grow = +params.grow || 0;
        var tol = params.tolerance > 0 ? +params.tolerance : 0.08;

        var prepared = prepareShapes(shapes, Math.min(0.02, tol / 4));
        if (!prepared.length) return { paths: [], stats: { ms: 0, msExtract: 0, msFit: 0, evals: 0, loops: 0, anchors: 0, shapes: 0 } };

        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minFeat = Infinity;
        for (var i = 0; i < prepared.length; i++) {
            var S = prepared[i];
            minX = Math.min(minX, S.minX); minY = Math.min(minY, S.minY);
            maxX = Math.max(maxX, S.maxX); maxY = Math.max(maxY, S.maxY);
            minFeat = Math.min(minFeat, S.maxX - S.minX, S.maxY - S.minY);
        }

        // Célula da grade: só precisa resolver a topologia (pescoços finos,
        // formas pequenas) — a precisão vem da projeção de Newton.
        var h = params.cell > 0 ? +params.cell : Math.max(0.25, Math.min(A / 6, minFeat / 12, 5));
        var MAX_NODES = 2.5e6;
        var base, F, field, res, region, tries = 0, margin = -1;
        function buildField() {
            // folga do índice = maior bloco da quadtree (32 células) + sobra
            base = makeField(prepared, kernel, A, params, 32 * h * Math.SQRT2 * 1.05 + 2 * h + Math.max(grow, 0));
            F = grow ? function (x, y) { return base.F(x, y) - grow; } : base.F;
            field = { F: F, stats: base.stats };
        }
        buildField();
        margin = base.maxDrop + Math.max(grow, 0) + 3 * h;
        do {
            region = { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
            var area = (region.maxX - region.minX) * (region.maxY - region.minY);
            if (area / (h * h) > MAX_NODES) { h = Math.sqrt(area / MAX_NODES); buildField(); }
            res = extract(field, region, h);
            margin *= 2;
        } while (res.boundaryNegative && ++tries < 3);
        var tExtract = now();

        var paths = [];
        var outCount = 0;
        for (var L = 0; L < res.loops.length; L++) {
            var loop = res.loops[L];
            var R = refineLoop(F, loop, h, params.cornerDeg || 25);
            if (R.length < 3) continue;
            var segs = fitLoop(R, tol);
            if (!segs.length) continue;
            var pts = [];
            for (var s = 0; s < segs.length; s++) {
                var b = segs[s], prev = segs[(s - 1 + segs.length) % segs.length];
                pts.push(b[0].x, b[0].y, prev[2].x, prev[2].y, b[1].x, b[1].y);
            }
            var poly = [];
            for (var r = 0; r < R.length; r++) poly.push([R[r].x, R[r].y]);
            var area2 = signedArea(poly);
            if (Math.abs(area2) < h * h * 0.5) continue; // farelo
            outCount += segs.length;
            paths.push({ closed: true, pts: pts, area: area2 });
        }
        var t1 = now();
        return {
            paths: paths,
            stats: {
                ms: t1 - t0, msExtract: tExtract - t0, msFit: t1 - tExtract,
                evals: field.stats.evals, sdf: field.stats.sdf, cell: h, grid: res.grid,
                kinds: prepared.map(function (p) { return p.kind; }).join(","),
                loops: paths.length, anchors: outCount, shapes: prepared.length,
                segments: prepared.reduce(function (s, p) { return s + p.n; }, 0)
            }
        };
    }

    function now() {
        return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    // Helpers de forma pra testes e CLI
    var KAPPA = 0.5522847498307936;
    function circle(id, cx, cy, r) { return ellipse(id, cx, cy, r, r); }
    function ellipse(id, cx, cy, rx, ry) {
        var kx = rx * KAPPA, ky = ry * KAPPA;
        // 4 âncoras, sentido anti-horário (y pra cima), como o Illustrator
        return {
            id: id, subpaths: [{
                closed: true, pts: [
                    cx + rx, cy, cx + rx, cy - ky, cx + rx, cy + ky,
                    cx, cy + ry, cx + kx, cy + ry, cx - kx, cy + ry,
                    cx - rx, cy, cx - rx, cy + ky, cx - rx, cy - ky,
                    cx, cy - ry, cx - kx, cy - ry, cx + kx, cy - ry
                ]
            }]
        };
    }
    function rect(id, x, y, w, hh) {
        var p = [[x, y], [x + w, y], [x + w, y + hh], [x, y + hh]], pts = [];
        p.forEach(function (q) { pts.push(q[0], q[1], q[0], q[1], q[0], q[1]); });
        return { id: id, subpaths: [{ closed: true, pts: pts }] };
    }
    function polygon(id, coords) {
        var pts = [];
        coords.forEach(function (q) { pts.push(q[0], q[1], q[0], q[1], q[0], q[1]); });
        return { id: id, subpaths: [{ closed: true, pts: pts }] };
    }

    return {
        compute: compute,
        KERNELS: KERNELS,
        makeField: makeField,
        prepareShapes: prepareShapes,
        sdfShape: sdfShape,
        shapes: { circle: circle, ellipse: ellipse, rect: rect, polygon: polygon }
    };
}));
