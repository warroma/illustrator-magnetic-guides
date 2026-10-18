// Cliente Node da ponte COM (tools/com-bridge.ps1): host(código) → Promise<string>.
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function openHost() {
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "..", "tools", "com-bridge.ps1")], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let buf = "", ready, readyP = new Promise(r => (ready = r));
    const queue = [];
    ps.stdout.on("data", chunk => {
        buf += chunk.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            if (line === "READY") { ready(); continue; }
            const job = queue.shift();
            if (!job) continue;
            const payload = Buffer.from(line.slice(line.indexOf(":") + 1), "base64").toString("utf8");
            if (line.startsWith("OK:")) job.resolve(payload); else job.reject(new Error(payload));
        }
    });
    function host(code) {
        return readyP.then(() => new Promise((resolve, reject) => {
            queue.push({ resolve, reject });
            ps.stdin.write(Buffer.from(code, "utf8").toString("base64") + "\n");
        }));
    }
    host.close = () => { try { ps.stdin.end(); } catch (e) { } ps.kill(); };
    host.loadHostScript = () => host(fs.readFileSync(path.join(__dirname, "..", "host", "liquid-host.jsx"), "utf8") + "\n'carregado';");
    return host;
}

module.exports = { openHost };
