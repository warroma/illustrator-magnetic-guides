// Sonda: onde o AL_poll gasta tempo (µs, melhor de 10).
(function () {
    var doc = app.activeDocument, out = [];
    function T(name, fn) {
        var best = 1e9, r;
        for (var k = 0; k < 10; k++) { $.hiresTimer; r = fn(); var t = $.hiresTimer; if (t < best) best = t; }
        out.push(name + ": " + best + " us");
        return r;
    }
    var reg = $.global.__AL.reg[doc.name];
    T("doc.groupItems.length", function () { return doc.groupItems.length; });
    T("doc.selection", function () { return doc.selection; });
    T("doc.selection.length", function () { var s = doc.selection; return s ? s.length : 0; });
    T("alActive(doc)", function () { return alActive(doc); });
    var g = T("getPageItemFromUuid", function () { return doc.getPageItemFromUuid(reg[0]); });
    var meta = T("alMeta", function () { return alMeta(g); });
    T("alSources", function () { return alSources(g, [], 0); });
    var srcs = alSources(g, [], 0);
    T("alStyleKey(top)", function () { return alStyleKey(srcs[0]); });
    T("alFindOut", function () { return alFindOut(g); });
    var d = T("alDescribe", function () { return alDescribe(g, meta); });
    T("alJ(describe)", function () { return alJ(d); });
    T("AL_poll()", function () { return AL_poll(); });
    return out.join("\n");
})();
