// Lógica pura de instalação (copiar arquivos, habilitar modo de depuração do
// CEP) — sem nada do Electron aqui, para poder ser testada isoladamente.
"use strict";

var fs = require("fs");
var path = require("path");
var execFileSync = require("child_process").execFileSync;
var cepExtensionsDir = require("./detect").cepExtensionsDir;
var inspectInstalled = require("./detect").inspectInstalled;
var PANEL_ID = require("./detect").PANEL_ID;

// O manifest pede CSXS 9.0 (Illustrator 2019 em diante); liga até o 12, como
// o AutoGrids. Cada versão do Illustrator lê só a chave da sua versão do CSXS.
var CSXS_VERSIONS = ["9", "10", "11", "12"];

// Arquivos da raiz do painel que nunca vão para o usuário. O .debug liga a
// porta de depuração remota do CEP (tools/install-panel.js --dev): é só da
// máquina de desenvolvimento.
var DEV_ONLY_FILES = [".debug"];

// runner é injetável só para teste (evita chamar defaults/reg de verdade fora
// do Mac/Windows reais); em produção é sempre child_process.execFileSync.
function enableDebugMode(platform, log, runner) {
    platform = platform || process.platform;
    runner = runner || execFileSync;
    var results = [];
    CSXS_VERSIONS.forEach(function (v) {
        var entry = { version: v, ok: false, error: null };
        try {
            if (platform === "darwin") {
                runner("defaults", ["write", "com.adobe.CSXS." + v, "PlayerDebugMode", "1"]);
            } else if (platform === "win32") {
                runner("reg", ["add", "HKCU\\Software\\Adobe\\CSXS." + v, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]);
            } else {
                throw new Error("Plataforma não suportada: " + platform);
            }
            entry.ok = true;
        } catch (err) {
            entry.error = err.message;
        }
        results.push(entry);
        if (log) log("CSXS." + v + ": " + (entry.ok ? "ok" : "falhou (" + entry.error + ")"));
    });
    return results;
}

// Coloca a pasta da extensão na pasta de extensões do CEP do usuário, com o
// nome PANEL_ID (a fonte no repositório se chama panel/) — serve tanto para
// instalar quanto para atualizar.
//
// Atualização = troca da pasta inteira, não cópia por cima: copiar por cima
// deixaria para trás arquivos que a versão nova não tem mais. A versão nova é
// montada ao lado ("<pasta>.novo") e só depois troca de lugar com a antiga; se
// a troca falhar no meio (arquivo preso pelo Illustrator aberto, por exemplo),
// a antiga volta para o lugar.
//
// Se o destino é um atalho (symlink/junction para o código-fonte — modo
// desenvolvimento), NÃO mexe em nada: apagar ou copiar "dentro" dele
// alteraria os arquivos-fonte.
//
// fsImpl é injetável só para teste.
function installPanel(panelSourceDir, platform, env, log, fsImpl) {
    fsImpl = fsImpl || fs;
    var destRoot = cepExtensionsDir(platform, env);
    fsImpl.mkdirSync(destRoot, { recursive: true });
    var dest = path.join(destRoot, PANEL_ID);
    var installed = inspectInstalled(dest, fsImpl);

    if (installed.isLink) {
        if (log) log("A pasta do painel é um atalho para " + (installed.linkTarget || "outro lugar") + " (modo desenvolvimento) — nada copiado.");
        return { dest: dest, linked: true, previousVersion: installed.version };
    }

    var staging = dest + ".novo";
    var backup = dest + ".antigo";
    fsImpl.rmSync(staging, { recursive: true, force: true });
    fsImpl.rmSync(backup, { recursive: true, force: true });

    if (log) log("Copiando " + panelSourceDir + " -> " + staging);
    var devOnly = DEV_ONLY_FILES.map(function (f) { return path.resolve(panelSourceDir, f); });
    fsImpl.cpSync(panelSourceDir, staging, {
        recursive: true,
        filter: function (src) { return devOnly.indexOf(path.resolve(src)) < 0; }
    });

    if (installed.exists) {
        if (log) log("Substituindo a versão instalada (" + (installed.version || "versão desconhecida") + ")");
        try {
            fsImpl.renameSync(dest, backup);
        } catch (errMove) {
            fsImpl.rmSync(staging, { recursive: true, force: true });
            throw errMove;
        }
        try {
            fsImpl.renameSync(staging, dest);
        } catch (errSwap) {
            fsImpl.renameSync(backup, dest);
            fsImpl.rmSync(staging, { recursive: true, force: true });
            throw errSwap;
        }
        fsImpl.rmSync(backup, { recursive: true, force: true });
    } else {
        fsImpl.renameSync(staging, dest);
    }
    if (log) log("Painel em " + dest);
    return { dest: dest, linked: false, previousVersion: installed.version };
}

// macOS: o que vem de um download (o .dmg do instalador) carrega o atributo de
// "quarentena", e ele pode passar para os arquivos copiados — com ele, o CEP
// pode não listar o painel ou abri-lo em branco. É o mesmo `xattr -cr` que o
// README manda rodar na instalação manual. Nas outras plataformas não faz nada.
// runner é injetável só para teste.
function clearQuarantine(dest, platform, log, runner) {
    platform = platform || process.platform;
    if (platform !== "darwin") return true;
    runner = runner || execFileSync;
    try {
        runner("xattr", ["-cr", dest]);
        if (log) log("Quarentena do macOS removida de " + dest);
        return true;
    } catch (err) {
        if (log) log("Aviso: não deu para remover a quarentena do macOS (" + err.message + ")");
        return false;
    }
}

module.exports = {
    CSXS_VERSIONS: CSXS_VERSIONS,
    DEV_ONLY_FILES: DEV_ONLY_FILES,
    enableDebugMode: enableDebugMode,
    installPanel: installPanel,
    clearQuarantine: clearQuarantine
};
