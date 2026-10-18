// Sincroniza o motor/host pra dentro do painel e instala no CEP do usuário.
//
//   node tools/install-panel.js           só sincroniza panel/ (motor + host)
//   node tools/install-panel.js --install sincroniza e instala em %APPDATA%\Adobe\CEP\extensions
//   node tools/install-panel.js --install --dev  idem + porta de depuração remota (localhost:8098)
//
// A instalação anterior é copiada antes para _backup/painel-instalado-<data>/.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const panel = path.join(root, "panel");
const args = process.argv.slice(2);

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
    }
}

// 1. sincroniza: uma fonte só (engine/ e host/), o painel recebe cópias
copy(path.join(root, "engine", "liquid-core.js"), path.join(panel, "js", "liquid-core.js"));
copy(path.join(root, "engine", "liquid-controller.js"), path.join(panel, "js", "liquid-controller.js"));
copy(path.join(root, "host", "liquid-host.jsx"), path.join(panel, "jsx", "host.jsx"));
console.log("Painel sincronizado (motor, controlador e host).");

if (!args.includes("--install")) process.exit(0);

const ext = path.join(process.env.APPDATA, "Adobe", "CEP", "extensions");
const dest = path.join(ext, "com.autoliquid.panel");
function bundleVersion(dir) {
    try {
        const xml = fs.readFileSync(path.join(dir, "CSXS", "manifest.xml"), "utf8");
        return (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1] || "?";
    } catch (e) { return null; }
}
if (fs.existsSync(dest)) {
    const old = bundleVersion(dest), neu = bundleVersion(panel);
    if (old !== neu) {
        // só guarda cópia quando é OUTRA versão (ex.: o AutoLiquid 1)
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const bak = path.join(root, "_backup", "painel-instalado-v" + old + "-" + stamp);
        copyDir(dest, bak);
        console.log("Versão instalada anterior (" + old + ") salva em " + path.relative(root, bak));
    }
    fs.rmSync(dest, { recursive: true, force: true });
}
copyDir(panel, dest);
const debugFile = path.join(dest, ".debug");
if (args.includes("--dev")) {
    fs.writeFileSync(debugFile, `<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
    <Extension Id="com.autoliquid.panel.main">
        <HostList>
            <Host Name="ILST" Port="8098"/>
        </HostList>
    </Extension>
</ExtensionList>
`);
    console.log("Depuração remota ligada: http://localhost:8098");
} else if (fs.existsSync(debugFile)) {
    fs.rmSync(debugFile);
}
console.log("Instalado em " + dest);
console.log("Feche e abra o Illustrator; o painel fica em Janela > Extensões > AutoLiquid.");
