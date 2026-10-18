// Executa JavaScript dentro do painel aberto no Illustrator (instalado com
// --dev, porta 8098) via Chrome DevTools Protocol. Pra testes e depuração.
//   node tools/panel-cdp.js "expressão JS"     (aceita await; devolve JSON)
//   require("./panel-cdp.js").connect() → { eval(expr), close() }
"use strict";

async function connect(port = 8098) {
    const list = await (await fetch(`http://localhost:${port}/json`)).json();
    const page = list.find(t => t.type === "page" && /autoliquid/i.test(t.url));
    if (!page) throw new Error("Painel AutoLiquid não está aberto (porta " + port + ").");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("falha ao conectar no painel")); });
    let id = 0;
    const waiting = new Map();
    const consoleLog = [];
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
        else if (msg.method === "Runtime.consoleAPICalled") consoleLog.push(msg.params.type + ": " + msg.params.args.map(a => a.value ?? a.description).join(" "));
        else if (msg.method === "Runtime.exceptionThrown") consoleLog.push("exceção: " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Runtime.enable");
    return {
        consoleLog,
        async eval(expr) {
            const r = await send("Runtime.evaluate", { expression: `(async () => { return (${expr}); })()`, awaitPromise: true, returnByValue: true });
            if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
            return r.result?.result?.value;
        },
        reload: () => send("Page.reload"),
        close: () => ws.close()
    };
}

module.exports = { connect };

if (require.main === module) {
    (async () => {
        const c = await connect();
        try {
            const v = await c.eval(process.argv[2] || "document.title");
            console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
            await new Promise(r => setTimeout(r, 200));
            if (c.consoleLog.length) console.log("--- console ---\n" + c.consoleLog.join("\n"));
        } finally { c.close(); }
    })().catch(e => { console.error("ERRO: " + e.message); process.exitCode = 1; });
}
