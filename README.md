# VTG (Viral Traffic Games) — map notes

## Files here

| File | What it is |
|---|---|
| `Traffic.js` | Navigator v15.0 — auto-walks toward targets, map-aware (avoids blocked terrain, routes around known obstacles, blacklists unreachable targets), plus a live minimap with your position |
| `VTGMapBuilder.user.js` | Passive map recorder/stitcher (install alongside Traffic.js) |
| `VTG_Map_GM.png` | Full GM map, 23×13 tiles (guest arena, `play_guest.php`) |
| `VTG_Map_AM.png` | Full AM map, 50×47 tiles (village/farm world — **this is Max's map**) |
| `VTG_Map_MT.png` | Full MT map, 44×32 tiles (manor estate) |
| `VTG_Map_MM.png` | Full MM map, 50×36 tiles (fantasy overworld: mushroom houses, castle, pond) |
| `VTG_Map_Example.png` | Stitch of the old-format saved result page (13×23, 64 px cells) |

All maps were pulled from the site's own tile directories, which are
indexable: `https://viraltrafficgames.com/vtg/T/<LAYER>/` lists every file.

## How the game stores the map

* Every play-field cell is `<td background="T/<LAYER>/Tyyxx.png">`.
* The file name is the absolute coordinate: `id = y*100 + x`
  (e.g. `T/AM/T1224.png` = row 12, column 24).
* Known layers: `GM` (23×13 guest), `AM` (50×47), `MT` (44×32), `MM` (50×36),
  plus `GO` objects, `F`/`MI`/`SC` misc, `R` orbs, `C` characters.
* The saved result page in `_files/` uses the older bare `Txxxx.png` paths but
  its images are byte-identical to the AM map — it is a 13×23 window of AM at
  y=1..13, x=27..49 (player at 7,40).

## Walkability (what v15.0 knows)

`Traffic.js` embeds a 2-bit-per-cell map of the AM world (`CONFIG.MAP`):

* `1` blocked — water and the black void border (318 cells)
* `2` avoid — dense forest (263 cells); passable but not preferred
* `0` open — everything else

Routing is 8-way: the navigator builds a BFS distance field from the target
(over open cells only, no corner-cutting between two blocked cells) and picks
the move anchor that reduces the remaining step count the most, breaking ties
by straight-line distance — so it steps NW/SW/NE/SE whenever that is shorter
than going straight.

Important: **hills are painted with the same grass texture as open ground**, so
colour classification cannot detect them (e.g. the "hill" at 12,24 decodes as
open). The script therefore also *learns*: a move that does not change the
player's cell is recorded as blocked (`vtg.walk`), and a target that stops
getting closer is blacklisted for 60 s (`vtg.blacklist`). BFS routing uses the
embedded map plus everything learned so far.

To perfect the map, a one-time crawl of the AM world with a logged-in session
would give exact ground truth — the world art never changes.

## Using VTGMapBuilder

1. Install it in Tampermonkey like Traffic.js (`@match` covers play.php /
   showresult.php).
2. Open a game page. It records the visible grid automatically.
3. Panel buttons:
   * **⬇ Full map (dir index)** — reads `./T/<layer>/` and records every tile
     in the whole map instantly (no walking needed).
   * **💾 Save map PNG** — stitches everything recorded so far into one image.
   * **🔍 Probe edge tiles** — manual ring probe (fallback if index is off).
   * **🗑 Clear** — wipe stored tiles.
4. Console API: `window.__vtgMap.store()`, `.fetchFullMap('AM')`, `.render(store)`.

Note: the game only lets you *walk* on part of each map (hills block movement),
so the recorded map is the world art, not the walkable graph. For pathfinding,
classify tiles (water/cliff/hill = blocked) or read move-anchor availability.
