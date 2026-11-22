// ==UserScript==
// @name         VTG Map Builder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Records every map tile the game renders on each load and stitches the whole map into one PNG
// @author       Munem2x
// @updateURL    https://raw.githubusercontent.com/Munem2x/vtg-navigator/main/VTGMapBuilder.user.js
// @downloadURL  https://raw.githubusercontent.com/Munem2x/vtg-navigator/main/VTGMapBuilder.user.js
// @match        https://viraltrafficgames.com/vtg/play.php*
// @match        https://viraltrafficgames.com/vtg/showresult.php*
// @icon         https://www.google.com/s2/favicons?domain=viraltrafficgames.com
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// ==/UserScript==

/*
 * VTG Map Builder
 * ---------------
 * GROUND TRUTH (verified live 2026-11):
 *   The play field is a plain HTML table - every cell is a
 *       <td width=".." height=".." background="T/<LAYER>/Tyyxx.png">
 *   and the file name IS the cell's absolute map coordinate:
 *       T/AM/T1224.png  ->  row y=12, column x=24  (id = y*100 + x)
 *
 *   Known tile directories under /vtg/T/  (each one is a complete map,
 *   every coordinate in its rectangle exists):
 *       GM/  23x13   guest arena (play_guest.php)
 *       AM/  50x47   village/farm world (hills, tower, river)
 *       MT/  44x32   manor estate
 *       MM/  50x36   fantasy overworld (mushroom houses, castle, pond)
 *       GO/  ground objects, F/ MI/ SC/ misc, R/ orbs, C/ characters
 *
 *   The directories are INDEXABLE (Apache autoindex), so the whole map can
 *   be listed - and therefore downloaded - in one request:
 *       https://viraltrafficgames.com/vtg/T/AM/   ->  all Tyyyy.png names
 *
 * This script:
 *   - records every tile each page load shows (auto),
 *   - calibrates absolute coordinates from the file names (with a
 *     player-movement fallback if a page ever uses bare names),
 *   - "Full map (dir index)" pulls the entire tile directory at once,
 *   - stitches everything recorded so far into one PNG ("Save map PNG").
 *
 * It never clicks anything - it is passive.
 */

(function () {
    'use strict';

    if (window.__vtgMapBuilderInited) return;
    window.__vtgMapBuilderInited = true;

    const CFG = {
        PLAYER_NAME: 'Munem2x',
        TILE_PX: 64,               // on-screen tile size (CSS px)
        STORE_KEY: 'vtgMap.tiles', // GM storage key
        MAX_WAIT_MS: 30000,        // how long to wait for the map table
        POLL_MS: 500,
    };

    const log = (...a) => console.info('[VTGMap]', ...a);

    // ---------- storage ----------
    function loadStore() {
        try {
            const raw = GM_getValue(CFG.STORE_KEY, '{}');
            return JSON.parse(raw);
        } catch (e) { return {}; }
    }
    function saveStore(obj) {
        try {
            GM_setValue(CFG.STORE_KEY, JSON.stringify(obj));
            return true;
        } catch (e) {
            console.error('[VTGMap] storage full?', e);
            return false;
        }
    }

    // ---------- grid reading ----------
    // Returns { rows, cols, tiles: string[][](relative paths), player, layer }
    // where tiles[r][c] is e.g. "T/GM/T0127.png" (or bare "T0127.png" on old pages).
    function readGrid() {
        let best = null;

        document.querySelectorAll('table').forEach(tbl => {
            // use .rows/.cells so nested tables are NOT swept in
            const grid = [];
            Array.prototype.forEach.call(tbl.rows, tr => {
                const row = [];
                Array.prototype.forEach.call(tr.cells, td => {
                    const bg = td.getAttribute('background') || '';
                    const m = bg.match(/([^/"\\]+\.png)$/i);
                    if (!m) { row.push(null); return; }
                    // keep the full relative path minus a leading "./"
                    let rel = bg.replace(/^\.\//, '').replace(/^\//, '');
                    row.push(rel);
                });
                if (row.some(v => v)) grid.push(row);
            });
            const goodRows = grid.filter(r => r.filter(Boolean).length >= 20).length;
            const cells = grid.reduce((n, r) => n + r.filter(Boolean).length, 0);
            const score = goodRows * 1000 + cells;
            if (goodRows > 0 && (!best || score > best.score)) best = { score, grid };
        });

        if (!best) return null;

        // normalise row lengths
        const cols = Math.max(...best.grid.map(r => r.length));
        const tiles = best.grid.map(r => {
            const out = new Array(cols).fill(null);
            r.forEach((v, i) => { if (i < cols) out[i] = v; });
            return out;
        });

        // locate the player inside this table (for the marker + sanity info)
        const playerImg = document.querySelector(`img[title="${CFG.PLAYER_NAME}"]`);
        let player = null;
        if (playerImg) {
            const td = playerImg.closest('td');
            const tr = td && td.parentElement;
            const tbody = tr && tr.parentElement;
            if (td && tr && tbody) {
                player = {
                    col: Array.prototype.indexOf.call(tr.children, td),
                    row: Array.prototype.indexOf.call(tbody.children, tr),
                };
            }
        }
        return { rows: tiles.length, cols, tiles, player, layer: detectLayer({ tiles }) };
    }

    // "T/GM/T0127.png" or "T0127.png" -> {y:1, x:27}  (ground ids follow id = y*100 + x)
    function tileCoord(name) {
        const m = /T(\d{2})(\d{2})\.png$/i.exec(name || '');
        if (!m) return null;
        return { y: +m[1], x: +m[2] };
    }

    // Which tile directory does this page use?  ("T/GM/T0127.png" -> "GM")
    function detectLayer(grid) {
        for (const row of grid.tiles)
            for (const n of row) {
                const m = /^T\/([A-Za-z]+)\//.exec(n || '');
                if (m) return m[1];
            }
        return null;
    }

    // Calibrate one loaded view: find the offsets (Y0,X0) that make most
    // tile ids fit   id = 100*(row+Y0) + (col+X0) .
    // Returns null when the page does not follow the scheme.
    function calibrate(grid) {
        const diffs = [];
        for (let r = 0; r < grid.rows; r++)
            for (let c = 0; c < grid.cols; c++) {
                const co = tileCoord(grid.tiles[r][c]);
                if (co) diffs.push(co.y * 100 + co.x - 100 * r - c);
            }
        if (diffs.length < 20) return null;
        diffs.sort((a, b) => a - b);
        const med = diffs[Math.floor(diffs.length / 2)];
        const Y0 = Math.floor(med / 100), X0 = med % 100;
        let hit = 0;
        for (const d of diffs) if (d === med) hit++;
        if (hit / diffs.length < 0.4) return null;   // scheme not recognised
        return { Y0, X0, hit, total: diffs.length };
    }

    // ---------- recording ----------
    // Two ways to give every cell an absolute map coordinate:
    //   FAST  - calibrate() from the tile file names (id = y*100 + x)
    //   FALLBACK - track how the player's grid position changed since the
    //              previous load and shift the window by that delta.
    const META_ORIGIN = 'vtgMap.origin';
    const META_PREV   = 'vtgMap.prev';

    function record(grid) {
        const store = loadStore();
        let origin = null;
        const cal = calibrate(grid);

        if (cal) {
            origin = { y: cal.Y0, x: cal.X0 };
        } else if (grid.player) {
            let prev = null, org = null;
            try { prev = JSON.parse(GM_getValue(META_PREV, 'null')); } catch (e) {}
            try { org = JSON.parse(GM_getValue(META_ORIGIN, 'null')); } catch (e) {}
            if (prev && org) {
                const dr = grid.player.row - prev.row;
                const dc = grid.player.col - prev.col;
                if (Math.abs(dr) <= 3 && Math.abs(dc) <= 3) {
                    origin = { y: org.y + dr, x: org.x + dc };
                    log('fallback align: shifted origin by', dr, dc);
                } else {
                    log('player jumped', dr, dc, '- ignoring this load');
                    GM_setValue(META_PREV, JSON.stringify(grid.player));
                    return { added: 0, kept: 0, total: Object.keys(store).length, skip: true };
                }
            } else {
                origin = { y: 0, x: 0 };      // first ever load
            }
        }

        if (!origin) {
            log('no coordinate scheme recognised on this page');
            return { added: 0, kept: 0, total: Object.keys(store).length, skip: true };
        }

        let added = 0, kept = 0;
        for (let r = 0; r < grid.rows; r++) {
            for (let c = 0; c < grid.cols; c++) {
                const name = grid.tiles[r][c];
                if (!name) continue;
                const key = (r + origin.y) + ',' + (c + origin.x);  // absolute cell coord
                if (store[key]) { kept++; continue; }
                store[key] = { t: name, r: Date.now() };
                added++;
            }
        }
        const ok = saveStore(store);
        if (grid.player) {
            GM_setValue(META_PREV, JSON.stringify(grid.player));
            GM_setValue(META_ORIGIN, JSON.stringify(origin));
        }
        log(`record: +${added} new, ${kept} known, ${Object.keys(store).length} total (${ok ? 'saved' : 'SAVE FAILED'})`);
        return { added, kept, total: Object.keys(store).length, cal, origin };
    }

    // ---------- probing / full-map fetch ----------
    // Because a tile's file name IS its coordinate (Tyyxx.png), tiles that the
    // game has never shown us can still be requested directly.  Even better:
    // the site leaves the tile directories indexable, so the whole map can be
    // listed and pulled in one go.
    let CURRENT_LAYER = null;   // e.g. "AM" when the page uses T/AM/Txxxx.png

    function nameFor(y, x) {
        const yy = String(y).padStart(2, '0'), xx = String(x).padStart(2, '0');
        return (CURRENT_LAYER ? 'T/' + CURRENT_LAYER + '/' : '') + 'T' + yy + xx + '.png';
    }
    function urlExists(url) {
        return new Promise(res => {
            const img = new Image();
            img.onload = () => res(true);
            img.onerror = () => res(false);
            img.src = url;
        });
    }
    async function probe(rings) {
        rings = rings || 2;
        const store = loadStore();
        let totalNew = 0;
        for (let ring = 1; ring <= rings; ring++) {
            const b = bounds(store);
            const y0 = b.y0 - ring, y1 = b.y1 + ring;
            const x0 = b.x0 - ring, x1 = b.x1 + ring;
            let ringNew = 0;
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const edge = (y === y0 || y === y1 || x === x0 || x === x1);
                    if (!edge) continue;
                    if (y < 0 || x < 0 || y > 99 || x > 99) continue;
                    const key = y + ',' + x;
                    if (store[key]) continue;
                    if (await urlExists(tileUrl(nameFor(y, x)))) {
                        store[key] = { t: nameFor(y, x), r: Date.now(), probed: 1 };
                        ringNew++; totalNew++;
                    }
                }
            }
            log('probe ring', ring, 'found', ringNew, 'new tiles');
            if (!ringNew) break;      // hit the edge of the world
        }
        saveStore(store);
        return totalNew;
    }

    // Pull every tile the server lists for this page's tile directory
    // (e.g. ./T/AM/).  The directory index is plain HTML - parse the hrefs.
    async function fetchFullMap(layer) {
        layer = layer || CURRENT_LAYER;
        if (!layer) { alert('No tile directory detected on this page.'); return 0; }
        const idxUrl = new URL('./T/' + layer + '/', location.href).href;
        let txt = '';
        try {
            txt = await fetch(idxUrl).then(r => r.text());
        } catch (e) {
            alert('Could not read ' + idxUrl + '\n' + e.message);
            return 0;
        }
        const names = Array.from(txt.matchAll(/href="(T\d{4}\.png)"/g)).map(m => m[1]);
        const store = loadStore();
        let added = 0;
        for (const n of names) {
            const co = tileCoord(n);
            if (!co) continue;
            const key = co.y + ',' + co.x;
            if (store[key]) continue;
            store[key] = { t: 'T/' + layer + '/' + n, r: Date.now(), probed: 1 };
            added++;
        }
        saveStore(store);
        log('full map fetch:', layer, names.length, 'listed,', added, 'new');
        return added;
    }

    // ---------- stitching ----------
    function bounds(store) {
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (const k of Object.keys(store)) {
            const [y, x] = k.split(',').map(Number);
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return { x0, x1, y0, y1 };
    }

    function tileUrl(name) {
        // resolve relative to the current page, exactly like the <td> does
        return new URL('./' + name, location.href).href;
    }

    function render(store) {
        const b = bounds(store);
        if (b.x1 < 0) return null;
        const w = (b.x1 - b.x0 + 1) * CFG.TILE_PX;
        const h = (b.y1 - b.y0 + 1) * CFG.TILE_PX;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#000';
        cx.fillRect(0, 0, w, h);

        const jobs = Object.entries(store).map(([k, v]) => {
            const [y, x] = k.split(',').map(Number);
            return { px: (x - b.x0) * CFG.TILE_PX, py: (y - b.y0) * CFG.TILE_PX, url: tileUrl(v.t) };
        });

        let i = 0, done = 0;
        const MAX_PARALLEL = 8;
        return new Promise(resolve => {
            function pump() {
                while (i < jobs.length && i - done < MAX_PARALLEL) {
                    const j = jobs[i++];
                    const img = new Image();
                    img.onload = () => { cx.drawImage(img, j.px, j.py, CFG.TILE_PX, CFG.TILE_PX); done++; };
                    img.onerror = () => { done++; };
                    img.src = j.url;
                }
                if (done >= jobs.length) {
                    // player marker
                    const p = window.__vtgMapPlayer;
                    if (p) {
                        cx.strokeStyle = '#ff2222'; cx.lineWidth = 3;
                        cx.strokeRect((p.x - b.x0) * CFG.TILE_PX, (p.y - b.y0) * CFG.TILE_PX, CFG.TILE_PX, CFG.TILE_PX);
                    }
                    resolve(cv);
                } else {
                    setTimeout(pump, 50);
                }
            }
            pump();
        });
    }

    async function saveMap() {
        const store = loadStore();
        const n = Object.keys(store).length;
        if (!n) { alert('No tiles recorded yet.'); return; }
        const cv = await render(store);
        if (!cv) return;
        const a = document.createElement('a');
        a.href = cv.toDataURL('image/png');
        a.download = 'vtg-map.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        log('map saved', cv.width + 'x' + cv.height, n + ' tiles');
    }

    // ---------- UI ----------
    function panel(rec) {
        let p = document.getElementById('vtgmap-panel');
        if (!p) {
            p = document.createElement('div');
            p.id = 'vtgmap-panel';
            p.innerHTML = `
                <b>🗺 VTG Map</b>
                <div class="vmi"><span>Tiles</span><b id="vtgmap-n">0</b></div>
                <div class="vmi"><span>Last load</span><b id="vtgmap-add">—</b></div>
                <button id="vtgmap-save">💾 Save map PNG</button>
                <button id="vtgmap-full">⬇ Full map (dir index)</button>
                <button id="vtgmap-probe">🔍 Probe edge tiles</button>
                <button id="vtgmap-clear">🗑 Clear</button>`;
            document.body.appendChild(p);
            p.querySelector('#vtgmap-save').onclick = saveMap;
            p.querySelector('#vtgmap-full').onclick = async () => {
                const n = await fetchFullMap();
                panel({ total: Object.keys(loadStore()).length, added: n });
                alert(n ? ('Added ' + n + ' tiles from the directory index.') : 'Directory index added no new tiles.');
            };
            p.querySelector('#vtgmap-probe').onclick = async () => {
                const n = await probe(2);
                panel({ total: Object.keys(loadStore()).length, added: n });
                alert(n ? ('Probe added ' + n + ' new tiles.') : 'No new tiles at the map edge.');
            };
            p.querySelector('#vtgmap-clear').onclick = () => {
                if (confirm('Clear all recorded map tiles?')) { saveStore({}); panel({total:0,added:0}); }
            };
            GM_addStyle(`
                #vtgmap-panel{position:fixed;left:10px;top:10px;z-index:99998;background:rgba(15,15,25,.95);
                  color:#fff;font:12px/1.5 'Segoe UI',system-ui;padding:10px 12px;border-radius:10px;
                  border:2px solid #4CAF50;min-width:150px;box-shadow:0 6px 24px rgba(0,0,0,.6)}
                #vtgmap-panel b{color:#4CAF50}
                .vmi{display:flex;justify-content:space-between;gap:12px}
                .vmi span{color:#90CAF9}
                #vtgmap-panel button{width:100%;margin-top:6px;border:0;border-radius:6px;padding:6px;
                  cursor:pointer;font-weight:600;color:#fff}
                #vtgmap-save{background:#4CAF50}
                #vtgmap-probe{background:#2196F3}
                #vtgmap-clear{background:#F44336}
            `);
        }
        document.getElementById('vtgmap-n').textContent = rec.total;
        document.getElementById('vtgmap-add').textContent = rec.added ? ('+' + rec.added) : '—';
    }

    // ---------- boot ----------
    function boot() {
        const started = Date.now();
        (function wait() {
            const g = readGrid();
            if (!g) {
                if (Date.now() - started > CFG.MAX_WAIT_MS) { log('no map table found'); return; }
                setTimeout(wait, CFG.POLL_MS);
                return;
            }
            const rec = record(g);
            if (g.layer) CURRENT_LAYER = g.layer;
            // remember the player's absolute coordinate for the map marker
            if (g.player && rec.cal) {
                window.__vtgMapPlayer = {
                    y: g.player.row + rec.cal.Y0,
                    x: g.player.col + rec.cal.X0,
                };
            }
            panel({ total: rec.total, added: rec.added });
            log('grid', g.rows + 'x' + g.cols, 'player', JSON.stringify(g.player), 'cal', JSON.stringify(rec.cal));
        })();
    }

    // expose for debugging / manual calls from the console
    window.__vtgMap = {
        readGrid, record, render, saveMap, probe, fetchFullMap, calibrate,
        store: loadStore,
        coords: tileCoord,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
