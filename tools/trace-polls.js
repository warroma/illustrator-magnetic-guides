// Diagnóstico: registra no painel o horário de início/fim de cada vigilância
// e mostra a linha do tempo em torno de um movimento feito por COM.
"use strict";
const { openHost } = require("../cli/com-host.js");
const { connect } = require("./panel-cdp.js");

(async () => {
    const host = openHost();
    await host.loadHostScript();
    const panel = await connect();
    try {
        await panel.eval(`(function(){ var c = window.__autoliquid.ctl; c.__trace = [];
            if (!c.__origCall) { c.__origCall = c.call; c.call = function(code){ var t = Date.now(), tag = code.slice(0, 9);
                c.__trace.push(["ini " + tag, t]);
                return c.__origCall.call(c, code).then(function(r){ c.__trace.push(["fim " + tag, Date.now()]); return r; }); }; }
            return true; })()`);
        const st = JSON.parse(await host("AL_poll()"));
        const L = st.liquids[0], src = L.srcs[L.srcs.length - 1].u;
        for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 400));
            await panel.eval("(window.__autoliquid.ctl.__trace = [], true)");
            const tA = Date.now();
            await host(`app.activeDocument.getPageItemFromUuid("${src}").translate(${i % 2 ? -8 : 8}, 0); "ok"`);
            const tB = Date.now();
            await new Promise(r => setTimeout(r, 400));
            const tr = await panel.eval("window.__autoliquid.ctl.__trace");
            console.log("\nmovimento: COM enviado em 0, voltou em " + (tB - tA) + " ms");
            console.log(tr.filter(e => e[1] >= tA - 80).map(e => "  " + String(e[1] - tA).padStart(5) + " ms  " + e[0]).join("\n"));
        }
        await panel.eval("(function(){ var c = window.__autoliquid.ctl; c.call = c.__origCall; delete c.__origCall; return true; })()");
    } finally {
        host.close();
        panel.close();
    }
})().catch(e => { console.error("ERRO: " + e.message); process.exitCode = 1; });
