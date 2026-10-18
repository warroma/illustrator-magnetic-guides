// Sonda: custo (µs por item) de cada propriedade lida na vigilância, nas
// formas do 1º líquido do documento ativo. Precisa do host carregado.
(function () {
    var reg = $.global.__AL.reg[app.activeDocument.name];
    var g = app.activeDocument.getPageItemFromUuid(reg[0]);
    var items = g.pageItems, n = items.length, out = [];
    function T(name, fn) {
        var best = 1e9;
        for (var r = 0; r < 5; r++) {
            $.hiresTimer;
            for (var i = 1; i < n; i++) fn(items[i], i);
            var t = $.hiresTimer;
            if (t < best) best = t;
        }
        out.push(name + ": " + (best / (n - 1)).toFixed(1) + " us/item");
    }
    T("pageItems[i]", function (it, i) { var x = items[i]; });
    T("typename", function (it) { var x = it.typename; });
    T("hidden", function (it) { var x = it.hidden; });
    T("locked", function (it) { var x = it.locked; });
    T("guides", function (it) { var x = it.guides; });
    T("clipping", function (it) { var x = it.clipping; });
    T("note", function (it) { var x = it.note; });
    T("uuid", function (it) { var x = it.uuid; });
    T("geometricBounds", function (it) { var x = it.geometricBounds; });
    T("area", function (it) { var x = it.area; });
    T("length", function (it) { var x = it.length; });
    T("pathPoints.length", function (it) { var x = it.pathPoints.length; });
    T("pathPoints[0].anchor", function (it) { var x = it.pathPoints[0].anchor; });
    $.hiresTimer;
    var gg = app.activeDocument.getPageItemFromUuid(reg[0]);
    out.push("getPageItemFromUuid: " + $.hiresTimer + " us");
    return "n=" + n + "\n" + out.join("\n");
})();
