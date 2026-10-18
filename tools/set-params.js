// Ajusta parâmetros de TODOS os líquidos do documento ativo (pra testes).
// Uso: node tools/set-params.js reach=30 tension=1.01 kernel=poly
"use strict";
const { openHost } = require("../cli/com-host.js");
const { Controller } = require("../engine/liquid-controller.js");
(async () => {
    const host = openHost();
    await host.loadHostScript();
    const ctl = new Controller(host, { log: m => console.log("  " + m) });
    await ctl.tick();
    const partial = {};
    process.argv.slice(2).forEach(kv => { const [k, v] = kv.split("="); partial[k] = isFinite(+v) ? +v : v; });
    for (const L of ctl.last.liquids) await ctl.setParams(L.u, partial);
    await ctl.tick();
    host.close();
})().catch(e => { console.error("ERRO: " + e.message); process.exitCode = 1; });
