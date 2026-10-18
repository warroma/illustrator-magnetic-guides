// Exporta a prancheta ativa do Illustrator como PNG (pra conferir resultado).
// Uso: node tools/export-png.js caminho/saida.png [escala%]
"use strict";
const path = require("path");
const { openHost } = require("../cli/com-host.js");

(async () => {
    const out = path.resolve(process.argv[2] || "relatorio/prancheta.png").split(path.sep).join("/");
    const scale = +(process.argv[3] || 100);
    const host = openHost();
    try {
        const r = await host(`(function(){ var doc = app.activeDocument; var f = new File(${JSON.stringify(out)});
            var o = new ExportOptionsPNG24(); o.artBoardClipping = true; o.antiAliasing = true; o.transparency = false;
            o.horizontalScale = ${scale}; o.verticalScale = ${scale};
            doc.exportFile(f, ExportType.PNG24, o); return f.exists ? "ok" : "falhou"; })()`);
        console.log(r === "ok" ? "Exportado: " + out : "Falhou: " + r);
    } finally {
        host.close();
    }
})().catch(e => { console.error("ERRO: " + e.message); process.exitCode = 1; });
