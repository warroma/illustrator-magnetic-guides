// Mede a latência ponta a ponta com o PAINEL no comando: move uma forma
// por COM e espera o painel terminar de reescrever o contorno. O fim é lido
// no próprio painel (DevTools, porta 8098 — instalação --dev), então a
// medição não disputa o motor de script do Illustrator com o painel.
// Uso: node tools/latency.js [repetições] [passo-pt]
"use strict";
const { openHost } = require("../cli/com-host.js");
const { connect } = require("./panel-cdp.js");

(async () => {
    const reps = +(process.argv[2] || 12), step = +(process.argv[3] || 8);
    const host = openHost();
    await host.loadHostScript();
    const panel = await connect();
    try {
        const st = JSON.parse(await host("AL_poll()"));
        const L = st.liquids[0];
        if (!L) throw new Error("Nenhum líquido no documento ativo.");
        const src = L.srcs[L.srcs.length - 1].u;
        const seq = () => panel.eval("(window.__autoliquid.ctl.lastUpdate || {}).seq || 0");
        const at = () => panel.eval("(window.__autoliquid.ctl.lastUpdate || {}).at || 0");
        const times = [], polls = [];
        for (let i = 0; i < reps; i++) {
            await new Promise(r => setTimeout(r, 250 + Math.random() * 200)); // fase aleatória em relação à vigilância
            const before = await seq();
            const dx = (i % 2 ? -1 : 1) * step;
            await host(`app.activeDocument.getPageItemFromUuid("${src}").translate(${dx}, 0); "ok"`);
            const t0 = Date.now();
            let s = before;
            while (s === before && Date.now() - t0 < 3000) { await new Promise(r => setTimeout(r, 5)); s = await seq(); }
            times.push(s === before ? NaN : (await at()) - t0);
            polls.push(await panel.eval("Math.round(Math.min.apply(null, window.__autoliquid.ctl.pollHist))"));
        }
        const ok = times.filter(t => t === t).sort((a, b) => a - b);
        console.log("líquido com " + L.srcs.length + " formas; " + ok.length + "/" + reps + " atualizaram");
        console.log("latência (ms): mediana " + ok[Math.floor(ok.length / 2)] + ", mín " + ok[0] + ", máx " + ok[ok.length - 1]);
        console.log("amostras: " + times.join(", "));
        console.log("custo de vigilância usado no intervalo (ms): " + polls.join(", "));
    } finally {
        host.close();
        panel.close();
    }
})().catch(e => { console.error("ERRO: " + e.message); process.exitCode = 1; });
