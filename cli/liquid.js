#!/usr/bin/env node
// AutoLiquid 2 — versão script (CLI). Conversa com o Illustrator aberto via
// COM e roda o MESMO motor/controlador que o painel vai usar.
//
//   node cli/liquid.js demo                 cria uma cena de exemplo já líquida
//   node cli/liquid.js cena                 só as formas do exemplo, selecionadas (pro painel criar)
//   node cli/liquid.js criar [opções]       transforma a seleção em líquido
//   node cli/liquid.js ajustar [opções]     muda os valores do líquido selecionado
//   node cli/liquid.js vigiar               atualiza em tempo real (Ctrl+C sai)
//   node cli/liquid.js validar              bateria de testes no Illustrator real
//
// Opções: --alcance <pt> (pregnância)  --tensao <p>  --curva poly|root|circ|exp|hard
//         --engordar <pt>  --tolerancia <pt>
"use strict";
const { openHost } = require("./com-host.js");
const { Controller } = require("../engine/liquid-controller.js");

const argv = process.argv.slice(2);
const cmd = argv[0] || "ajuda";
function opt(name, conv) {
    const i = argv.indexOf("--" + name);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    return conv ? conv(argv[i + 1]) : argv[i + 1];
}
function paramsFromArgs() {
    const p = {};
    const a = opt("alcance", Number); if (a !== undefined) p.reach = a;
    const t = opt("tensao", Number); if (t !== undefined) p.tension = t;
    const c = opt("curva"); if (c !== undefined) p.kernel = c;
    const g = opt("engordar", Number); if (g !== undefined) p.grow = g;
    const tol = opt("tolerancia", Number); if (tol !== undefined) p.tol = tol;
    return p;
}

async function main() {
    if (cmd === "ajuda" || cmd === "--help") {
        console.log(require("fs").readFileSync(__filename, "utf8").split("\n").slice(1, 13).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
        return;
    }
    const host = openHost();
    const t0 = Date.now();
    await host.loadHostScript();
    if (cmd === "cena") { try { await scene(host); } finally { host.close(); } return; }
    const ctl = new Controller(host, { log: m => console.log("  " + m) });
    console.log("Illustrator conectado (" + (Date.now() - t0) + " ms).");
    try {
        if (cmd === "demo") await demo(host, ctl);
        else if (cmd === "cena") await scene(host);
        else if (cmd === "criar") {
            const r = await ctl.create(paramsFromArgs());
            console.log("Líquido criado: " + r.u + (r.skipped ? " (" + r.skipped + " itens ignorados)" : ""));
        } else if (cmd === "ajustar") {
            await ctl.tick();
            const A = ctl.active();
            if (!A) throw new Error("Selecione um líquido (ou algo dentro dele) no Illustrator.");
            await ctl.setParams(A.u, paramsFromArgs());
            console.log("Ajustado: " + JSON.stringify(ctl.paramsOf(A.u)));
        } else if (cmd === "vigiar") {
            console.log("Vigiando — mova as formas dentro de um líquido (modo isolamento ou Seleção Direta). Ctrl+C sai.");
            ctl.start();
            await new Promise(() => { });
        } else if (cmd === "validar") {
            const ok = await require("./validate.js").run(host, ctl);
            process.exitCode = ok ? 0 : 1;
        } else {
            throw new Error("Comando desconhecido: " + cmd);
        }
    } finally {
        if (cmd !== "vigiar") host.close();
    }
}

async function demo(host, ctl) {
    await scene(host);
    const r = await ctl.create({ reach: 26, tension: 2 });
    console.log("Líquido criado (" + r.u + "). Rode 'node cli/liquid.js vigiar' e mova as formas.");
}

async function scene(host) {
    const made = JSON.parse(await host(`(function(){
        var doc = app.activeDocument;
        var L; try { L = doc.layers.getByName("AutoLiquid demo"); L.remove(); } catch (e) {}
        L = doc.layers.add(); L.name = "AutoLiquid demo";
        var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
        var cx = (ab[0] + ab[2]) / 2, cy = (ab[1] + ab[3]) / 2;
        function rgb(r, g, b) { var c = new RGBColor(); c.red = r; c.green = g; c.blue = b; return c; }
        var items = [];
        function circ(x, y, r) { var e = L.pathItems.ellipse(cy + y + r, cx + x - r, 2 * r, 2 * r); items.push(e); return e; }
        // par já fundido, par quase encostando, forma solta, mistura de tipos
        circ(-120, 150, 60); circ(-25, 120, 34);          // fundidos (vão 1 pt)
        circ(80, 160, 40); circ(152, 110, 22);           // quase (vão ~ alcance)
        circ(130, -40, 46);                               // solta
        var rr = L.pathItems.roundedRectangle(cy - 60, cx - 190, 150, 80, 22, 22); items.push(rr);
        circ(-20, -120, 30);                              // gruda no retângulo
        var star = L.pathItems.star(cx + 20, cy + 10, 38, 17, 5); items.push(star);
        for (var i = 0; i < items.length; i++) { items[i].filled = true; items[i].fillColor = rgb(52, 84, 214); items[i].stroked = false; }
        doc.selection = null;
        for (var k = 0; k < items.length; k++) items[k].selected = true;
        return '{"ok":true,"n":' + items.length + '}';
    })()`));
    console.log("Cena criada com " + made.n + " formas (selecionadas).");
}

main().catch(e => { console.error("ERRO: " + e.message); process.exitCode = 1; });
