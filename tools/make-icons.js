// Gera os ícones a partir do próprio motor (kernel polinomial do
// liquid-core): duas gotas que se fundem.
//
//   node tools/make-icons.js
//
// Saída:
//   panel/icons/icon-{normal,rollover,dark-normal,dark-rollover}[@2X].png
//       ícone do painel recolhido na doca, 23x23 e 46x46. Normal/RollOver =
//       temas claros da UI do Illustrator; Dark* = temas escuros. Mesmas cores
//       e traço dos ícones do AutoGrids.
//   installer/build/icon.png
//       ícone do instalador (512x512); o electron-builder gera o .ico/.icns.
//
// Só usa zlib do Node: o PNG é escrito à mão (RGBA 8 bits, sem filtro).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const core = require("../engine/liquid-core.js");

const root = path.join(__dirname, "..");

// ---- PNG ----
const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

// ---- o desenho: duas gotas, coordenadas numa grade de 23 unidades ----
const BIG = { x: 8.3, y: 13.9, r: 5.3 };
const SMALL = { x: 16.3, y: 7.1, r: 3.7 };
const KERNEL = core.KERNELS.poly;
const K = KERNEL.setup(2.3, { tension: 2 });

function blobField(x, y) {
    const a = Math.hypot(x - BIG.x, y - BIG.y) - BIG.r;
    const b = Math.hypot(x - SMALL.x, y - SMALL.y) - SMALL.r;
    return KERNEL.fn(a, b, K);
}
// O smooth-min não é uma distância exata na ponte (o gradiente fica < 1 ali);
// dividir pelo gradiente deixa o traço com a mesma espessura em todo o contorno.
function blobDist(x, y) {
    const e = 1e-3;
    const f = blobField(x, y);
    const gx = (blobField(x + e, y) - blobField(x - e, y)) / (2 * e);
    const gy = (blobField(x, y + e) - blobField(x, y - e)) / (2 * e);
    const g = Math.hypot(gx, gy);
    return g > 1e-6 ? f / g : f;
}

// cobertura (0..1) por supersampling SSxSS dentro de cada pixel (menos
// amostras no ícone grande, onde cada pixel já é pequeno)
function render(size, layers) {
    const SS = size > 64 ? 3 : 8;
    const scale = 23 / size;
    const rgba = Buffer.alloc(size * size * 4);
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let r = 0, g = 0, b = 0, a = 0; // pré-multiplicado
            for (const L of layers) {
                let hits = 0;
                for (let sy = 0; sy < SS; sy++) {
                    for (let sx = 0; sx < SS; sx++) {
                        const x = (px + (sx + 0.5) / SS) * scale;
                        const y = (py + (sy + 0.5) / SS) * scale;
                        if (L.inside(x, y)) hits++;
                    }
                }
                const cov = (hits / (SS * SS)) * (L.alpha == null ? 1 : L.alpha);
                // "over": a camada nova por cima
                r = L.color[0] * cov + r * (1 - cov);
                g = L.color[1] * cov + g * (1 - cov);
                b = L.color[2] * cov + b * (1 - cov);
                a = cov + a * (1 - cov);
            }
            const i = (py * size + px) * 4;
            if (a > 0) {
                rgba[i] = Math.round(r / a);
                rgba[i + 1] = Math.round(g / a);
                rgba[i + 2] = Math.round(b / a);
            }
            rgba[i + 3] = Math.round(a * 255);
        }
    }
    return encodePNG(size, size, rgba);
}

function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

// ---- ícones do painel (contorno, como os do AutoGrids) ----
const STROKE = 1.4; // em unidades da grade de 23 (1x)
const outline = function (x, y) { return Math.abs(blobDist(x, y)) <= STROKE / 2; };
const PANEL_ICONS = {
    "icon-normal": "#505050",
    "icon-rollover": "#1b1b1b",
    "icon-dark-normal": "#b8b8b8",
    "icon-dark-rollover": "#ffffff"
};
const iconsDir = path.join(root, "panel", "icons");
fs.mkdirSync(iconsDir, { recursive: true });
for (const name of Object.keys(PANEL_ICONS)) {
    const layer = [{ color: hex(PANEL_ICONS[name]), inside: outline }];
    fs.writeFileSync(path.join(iconsDir, name + ".png"), render(23, layer));
    fs.writeFileSync(path.join(iconsDir, name + "@2X.png"), render(46, layer));
}
console.log("Ícones do painel em " + path.relative(root, iconsDir));

// ---- ícone do instalador: quadrado arredondado escuro + gota cheia azul ----
function roundedSquare(x, y) {
    // quadrado de 21 unidades centrado, cantos de raio 4.5 (mesmo desenho do AutoGrids)
    const c = 11.5, half = 10.5, rad = 4.5;
    const qx = Math.abs(x - c) - (half - rad), qy = Math.abs(y - c) - (half - rad);
    const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
    return out <= 0;
}
// a gota cabe numa área menor dentro do fundo: escala 0.72 em torno do centro
function scaled(fn, s) {
    return function (x, y) { return fn(11.5 + (x - 11.5) / s, 11.5 + (y - 11.5) / s); };
}
const appLayers = [
    { color: hex("#2b2b2b"), inside: roundedSquare },
    { color: hex("#4a9eff"), inside: scaled(function (x, y) { return blobDist(x, y) <= 0; }, 0.72) }
];
const buildDir = path.join(root, "installer", "build");
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, "icon.png"), render(512, appLayers));
console.log("Ícone do instalador em " + path.relative(root, path.join(buildDir, "icon.png")));
