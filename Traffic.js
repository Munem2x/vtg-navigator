// ==UserScript==
// @name         Viraltrafficgames Ultimate Navigator Pro
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Navigation on play.php (now with map-aware pathfinding that avoids blocked terrain) + auto-close on showgame/showresult.php + auto-click prize page link
// @author       Munem2x
// @updateURL    https://raw.githubusercontent.com/Munem2x/vtg-navigator/main/Traffic.js
// @downloadURL  https://raw.githubusercontent.com/Munem2x/vtg-navigator/main/Traffic.js
// @match        https://viraltrafficgames.com/vtg/play.php*
// @match        https://viraltrafficgames.com/vtg/showgame.php*
// @match        https://viraltrafficgames.com/vtg/showresult.php*
// @match        https://viraltrafficgames.com/fc_loginad_showh.php*
// @icon         https://www.google.com/s2/favicons?domain=viraltrafficgames.com
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.close
// ==/UserScript==

(function () {
    'use strict';

    // Prevent double-injection stacking (re-injected script, bfcache, etc.)
    if (window.__vtgNavigatorInited) return;
    window.__vtgNavigatorInited = true;

    // The site redirects the game frame to http://viraltrafficgames.com/... from
    // an HTTPS page. Browsers block that as mixed content, leaving a white frame.
    // upgrade-insecure-requests makes the browser rewrite the insecure frame URL
    // to HTTPS before loading it.
    function injectUpgradeCsp() {
        try {
            const existing = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
            if (existing && /upgrade-insecure-requests/i.test(existing.content || '')) return;
            const m = document.createElement('meta');
            m.httpEquiv = 'Content-Security-Policy';
            m.content = 'upgrade-insecure-requests';
            (document.head || document.documentElement).appendChild(m);
        } catch (e) { /* ignore */ }
    }

    // Also rewrite any hard-coded http://viraltrafficgames.com URLs in the DOM
    // so links/forms/frames never point at the insecure origin.
    function upgradeInsecureUrls(root) {
        try {
            const els = (root || document).querySelectorAll('[href], [src], [action]');
            for (const el of els) {
                for (const attr of ['href', 'src', 'action']) {
                    const v = el.getAttribute(attr);
                    if (v && v.indexOf('http://viraltrafficgames.com') === 0)
                        el.setAttribute(attr, 'https://viraltrafficgames.com' + v.slice('http://viraltrafficgames.com'.length));
                }
            }
        } catch (e) { /* ignore */ }
    }

    injectUpgradeCsp();
    if (document.body) upgradeInsecureUrls();
    document.addEventListener('DOMContentLoaded', () => upgradeInsecureUrls(), { once: true });

    // =====================================================================
    // GROUND TRUTH from actual page HTML
    // =====================================================================
    //
    // play.php  —  the live game map
    //   <form id="frmMap" action="/vtg/play.php" method="POST">
    //     <input name="moveX"> <input name="moveY"> ...session fields...
    //   </form>
    //
    //   Each map cell is a <td width="64px" height="64px"> with a background tile.
    //   Inside some cells there is one <img> tag (57×57px).
    //
    //   IMAGE TYPES identified by src path:
    //   ┌──────────────────────────────────────────────────────────────┐
    //   │ src contains  │ meaning                                      │
    //   ├───────────────┼──────────────────────────────────────────────┤
    //   │ T/C/          │ player avatar  (other players + butterflies) │
    //   │ T/F/          │ NPC / loot     (Chloe, Magic ruby)           │
    //   │ T/MI/         │ magic item     (Magic ring/crown/potion)     │
    //   │ T/I/          │ UI icon        (weapon slot) — IGNORE        │
    //   └───────────────┴──────────────────────────────────────────────┘
    //   All T/C/, T/F/, T/MI/ images with a title ARE valid targets
    //   (except own player and system-UI titles).
    //
    //   MOVE ANCHORS (only rendered in cells adjacent to the player):
    //     <a href="#" onclick="move('moveX', 1)">
    //       <img title="Click to move" style="border-color: white;" ...>
    //     </a>
    //     OR: onclick="move('moveX', -1)"
    //         onclick="move('moveX', 2)"
    //         onclick="move('moveY', -1)"
    //         onclick="move('moveY', -2)"
    //         onclick="moveUser(-1, -1)"   (diagonal)
    //         onclick="moveUser(1, -1)"
    //
    //   IMPORTANT (v14.2 fix): when a reachable cell is OCCUPIED by another
    //   player, NPC, or item, the server puts THAT entity's own <img>
    //   inside the move <a> instead of the usual orb image or a
    //   title="Click to move" image. Example seen in the wild:
    //
    //     <a href="#" onclick="move('moveX', -2)">
    //         <img title="vesna" src="T/C/kiUgeiKhgeyE1.png" ...>
    //     </a>
    //
    //   So move-anchor discovery must NOT depend on what image is inside
    //   the <a> — it must be based purely on the onclick pattern. Anything
    //   else (only matching orb images / "Click to move" titles) will
    //   silently miss these occupied-cell anchors and the script will
    //   walk adjacent to a target forever instead of landing on it.
    //
    //   HOW TO MOVE: click the <a> anchor (NOT the img inside it).
    //
    //   HOW TO REACH A TARGET: the server only renders move anchors in
    //   cells the player can physically step to right now. The script
    //   must step one anchor at a time, each cycle choosing the anchor
    //   that lands it closest to the target. The page reloads after
    //   each step.
    //
    //   IF player is already on target's cell → server handles collection
    //   automatically; the target img disappears on next load.
    //
    //   IF target is in a move anchor's cell (dist=0 after the move) →
    //   that anchor IS the correct action — click it directly.
    //
    // showgame.php  —  outer frameset (frames[0]=header, frames[1]=play.php)
    // showresult.php — static result page, no form, no onclick at all
    //   Close logic: frames[1] has "Click to move" orbs → still playing → reload
    //                frames[1] has no orbs                → game over   → close
    // =====================================================================

    const CONFIG = {
        PLAYER_NAME: 'Munem2x',

        // src path prefixes that identify valid target images
        // (relative to /vtg/ base)
        TARGET_SRCS: ['T/C/', 'T/F/', 'T/MI/'],

        // src prefix for UI icons — always ignore
        UI_SRC: 'T/I/',

        // Titles that are never targets even if src matches
        IGNORE_TITLES: new Set([
            'Click to move',
            'Click to Join',
            'Click to choose magic weapon',
        ]),

        // Regex used to recognize a move anchor purely from its onclick
        // attribute, regardless of what image (if any) is rendered inside
        // it. This is the key to correctly detecting anchors whose cell
        // is occupied by another player/NPC/item.
        MOVE_ONCLICK_RE: /move\(\s*['"]moveX['"]\s*,|move\(\s*['"]moveY['"]\s*,|moveUser\(/,

        TIMING: {
            CHECK_INTERVAL: 7000,   // ms between nav cycles
            CLICK_DELAY:    1200,   // ms before executing the chosen click
            UI_REFRESH:     2000,   // ms between UI stat refreshes
            PATH_REDRAW:    800,    // ms between path overlay redraws
            // close manager
            CLOSE_MIN_WAIT: 3000,
            CLOSE_MAX_WAIT: 20000,
            CLOSE_POLL:     500,
            CLOSE_DELAY_MS: 8000,         // keep the result page open this long before closing
            CLOSE_LOAD_TIMEOUT_MS: 10000, // max time to wait for the result page to finish loading
        },

        DEBUG: false,

        // ── Map awareness (AM world) ────────────────────────────────────
        // Tile file names carry absolute coordinates: T/AM/T1224.png is
        // row y=12, col x=24.  CELL_B64 packs 2 bits per cell (row-major,
        // y then x) for the 50x47 AM world:
        //     0 = open ground   1 = blocked (water / void)
        //     2 = avoid    (dense forest - passable but not preferred)
        // Generated from VTG_Map_AM.png (see Traffic folder README).
        MAP: {
            ENABLED: true,
            // layer -> 2-bit cell map (0 open / 1 blocked / 2 avoid).
            // Add further worlds here as they get mapped.
            LAYERS: {
                AM: {
                    W: 50,
                    H: 47,
                    CELL_B64: 'VWAVAAAAAAIAAAAApWoBUAAAAAKgAAAABFoAVYAAAAAqAAAAAIaABmpUAAAAogAAAABgAFWlQAAAKgAAAAAGAAVaVZAAAAAAAIACYAAAoBkAAAAAAAgAKgAACgKVAAAAAAAAAIAKAAAKYAAAAAACgAgAoAAAoAAAAAAAAACACgAAAAAAAAAAAAAIACAAAAAAAAAAAAgAgAAAAAAAAAAAAAgACAAAAAAAAAAAAAACqoAAAAAAAAAAAAAAlVgACAAAAAAAAAAACVVgAIAAAAAAAAAAAJVVgAAAAAAAAAAAAAKVVgAgAACAAAAAAAAKVWAAAAAoAAAAAAAAJVYAAAAAAAAABAAgAlWAIAAAAAAABVVaACWqgAAAAAAAAFVVIAJYKAAAAAAAAAlVUAAlooAAAAAAAAIEFAACWCgAAAAAAAAoAAAApYAAACAAAAACAAAAJVgAAAmAAAAAAAAAAmqqqqqYAAAAAAAAACYFVVaWgAAAAAAAAACgVWWCoAAAAAAAAAAABWqqqAAAAAAAAAAAAGopqgAACAAAAAAAAAoKoqAAAqgAAAAAAACAKAgAAAKAABQAAAAAAAAAAAAgAAVAAAAFgAAAAAAAAAFVVAABmAAAAAFQAABVWlAAVIAAAAAVAAQVVVVQVaoAAAAVlVUAValVBVqgAAACmVVQAAAVUFUgAAAAapVVAAAAUABCAAFVVqpQAAVQAAACoABaVWqgAAAVAAAAAFVVKlKAAAABUAAAAKVVQiAAAAAABUAAAAJVUCIAAAAAAFUgAAAA',
                },
            },
        },

        // ── Minimap ────────────────────────────────────────────────────
        // Whole world, scaled down, with the live viewport rectangle and a
        // dot on the player's absolute cell.  Position comes from the tile
        // file names, so it works on every load.
        MINIMAP: {
            LAYER: 'AM',   // world this image belongs to
            W: 50,
            H: 47,
            IMG: 'data:image/webp;base64,UklGRhbJAABXRUJQVlA4IArJAAAwtwKdASpYAjQCPqFEm0mmI6KiLDYsoMAUCU1PnqrR/PmcfheUNa8ttutW3q3IX+NIV142cTvUisiTXXWV1D8P/x/5rubZN9+/4v9L6hHIvlTHB/097XwHlZPuf9312f2P1JP8F0dPNX5wfqS/y/pj+lr62HRSetL/mukA//+y1f7L9bPXD9D/jv+v4S/n33Lysv4fG/7v/leZ39X/en/f16f3ne7+y/1/oF/r/739Sn9Tsxd7/5f7dewdgb/pebX8N/xPYD8s+/0/Of+j2Cf8R6RX/V////B6Uf3z/wfvD8Cn9p/4//9/5fbXalV97i//NiNPtKwT/4R451dVCenxzD7aG0v7knX7UC7oKJEoEZna3pVL2dbTesaXv8lCbcdpCLXvHdGn0OcEvlp4rtdYU+rII03uTQj0S2ftRJno+LnOHmWPzQjoWVJE+0X779zxLFmFxNR9GL5d/PVXQBWGavdGhnUPW5DBF7X8bI4WgPNOQ3qVSmvi1fm3b30jYejVld68RcO5dwus3sABSZbMqFn4bD8glaSrh45ffxhet/6rPYc8OKqXVsrC+hZyIKGzUNXnkpOlvpiFdfqcqYWZSbSJd/ehqia5AeJo/FVtpWr7mZHDG/HzfXu6o5nUvxNGnu+kOAxaREi5lyItMD1L1fJUN6ATKt7gmjSGHAC6TrPYNLSy2vPa58DBEdNVza/7AtIq7Q/smb9BdE1H+xRW1O1i3KHDuwSF2WMZ7uDjuqXiezpeXffP5zZt0E3Lrz9f+hgW/0OX3V1T6S52zCAafvurrKvtFCfnO2BaoJk1hwx+mH/2n6K0BGPNYB4LsBS4PaUYGqfCGfBUi6pgLx2WS25v1gvqJl6vO9izPut5VxI9faydyTNlHXRnxGhFJsZUXNWzMW36UxZW0pbO8AsNnWraqhJLC8mieuFin5Qq6M6oeWsGfoh3FGns0qbUxvdvGMnVycG/hYdoV/9grW3ZeoAXiFTKO83PyIKt5WHCh8urzctnK2yCKR4U2HqgKRh6YpUr90LfWKDe3GEYtXNVBoChTabaJ4k6RvlXZzockvMtws2xwHPN9jA42U7qk4iF3WO/M7HU4j/MRWV3HAG4dTI/LAkJeYowCfwWvZuGs1y/lEaYh42hNCk/9x4eMYvKfbNcoPQNLnt9jPzy9PI0iqm16+UaMx98G3zjpuV3Qd6QyPaaFglPXG/sLMVi7r//wHc+M7Yvynh4Jths4STa2chPMvE6Nn9ytv4+Fqjr0zKZhkUSulOsKB+jOMB4KdCy7r3RIxh/ntEfWlkLIIuLKQ9ZFrV0vAY/U940f57gyNRKuuiQKw0rCX12pRuFQo0QwGD1FyUdaNV+IVpHv0OjumF2ONyGdm66UnQR63ewhd1OtsiGpWwQEqjWTxVp95m2bKFN9SXjoNB9vf6qPz15uMtJXKRkfBnElT9w/XbCFLxfS0C+Cb/5DPcEC4ToHyYb9gkzygo0mM2Gr3p44w3zRlPYXeiOzQHxkny20hQufvA5pbEA/S1a8hyMtlWrQQwbOO6zi2XQpUYFBNvq3H80scAG/w2u+fZQR73rc00caH5jlA5amjCkd2lGvykaSC4vwE8kZOKmZgkra7pwe+TOjOA5VrQvoj44C7hGmUE04QwVXU9PRoml3WAHCKyP1lRf+Bk0/PWPjObaFmCnYmIz69JG4Sr/1FdF+lVNBh1bVfuCoUE5KZEX6BR2cjDJO8EBhWm3EUA631IKKL6Ly9VNiWI20qG61MmBlKLKPaK/yb8XtTWT2GoX0m04PmaY1q5GnvBwZK+foG5agUqV7alx3qtaEfgquHMdLO6CXq3dWtKy3eGhl6BaUbiKFf4eaWfGTd5fwFtcvtOpmv9JOmlryRq4dGVPLXrKZvfv4WHZ/D4rRthMIovh86q7H5U6+u1zEkgioYr8RkBR9N7Mfr7+i+QFW5wCXXNwAgPgYSg3jMa8DlbO6/H5BMLJZAEOqek2S+I6eYHE+xAsGQZx6gIOy0e9WlVAuUq9QwJQqq2Y23ITqQ1pho2IcqA2GLbO/Buo9eOA5M8SY6H3+QulTD//Za+1HGPtzFS7byW8HH1TwmRtx0CQTu+kUfx3/Z5Wdj4o0jbFM0PV52gWN8DK+nokER2FK4bbrwTGwa7+5Hm6LCAUkESBfYt99pu7UpAvOZLly3WqaMfXNmjLqNCpvor/n057No37IfN1TQeTY874O3NVhzKvVEAirZi7fMuUHK2ZlqT9YOKMi9NQUwE6d2bXcsMYYQ686Q7oLcz8F6/ER0Yy+TljAV/AfkkXemb8+u9sroyB/mAejztSMHvqVCmFREl3PMJ5I0RIZU0sGmgfa5Tpo5X7o+PAHcjZ0fVOsXwD7/p3cK3mYIx/Ziu3olCOVwG+kw3YKoimpBLOefBCdDAXwCwC43sIPJnoLBeUg+7Xkzw5rmsRwhMzctaBP6F8YkCCv+qpGUp7hiNAZIRU91P9orVQKq9iefNaXQV/mmsvblcbj/JJVO4YnWbihhvS+prI4CHUUA8LmO9RGI+TcRW2OL6gwr1vZjvFZHjh9r/bJp3xbxCIFlH9QGV0DldidrWnaM9Q9iCDfrAEWeekeKJwV4y8Me1SPmeZYtGlO1UXNtNXzvgg26iOtOf5SXoC9Cy+f7sQdeLimyVe4HF3HTp2jkYxRdZIUDqXYOap5/ieTvVQ4rU/8m9BZ7if0pke7h8JM3OQfCnQbnHB+U56mEwuA1xI+pxLtsNZuiCnUbsDaRhocKptsxCNm9+hF+DOQhp8oEZOBgSBNQ5EhsZZQ9e5szpp675TL9YPo03kOAsIYsgPxar4KtYqEJEytmA9IoHa7kO0EGBZ7S5DXgRq0MP9kLsEaVafkpWE6LE0laXGpVV3gBCg+Qu/uCEl9h60oMRFWyYuVFI/W8MRCVPEGFLd3Cftmd9fqSfGRjdHWNhHACVkRKAn93hrwQ5OYIDgxEXh4oCDWgWo4od4G5Y5pLgqVKmSwMvFm4DeW6SVVvb6cDX1Qs5gDxArXfEJU1NZGrmdYZXvLmUYNDd0pUyC48thJl+eFHfRQIyDyg8kmd69Ys5uxjaOallW6r7yzIXmw0idbxS8hfhaAbq5Ow0RYJSAg/yTCJeU46bwkDIcOw2HruV+7WjJ252fxT0fY4PWic1npi7Wye4F4YoDjpqxpQU+W61O1zcoT9TcINmcj1RxB07GVhYyIXz+9n8fIWWO6zjKNjdu0hikdwdBfWhh8BgN6HhK+JiAQj1IEcy6hxfO/6+3EMhOwGWtxXmY5qlaT2x6aLZXCoPxzal4DicwyqFT556SX7ThG3rVX447S5Rn9r4jLp7qDomTUqQ6aycgZcvGkXvkz9KqJ12rtTyow99BHNF+tQ/AqUvGk4uGObtzJWsBbsq3kcdzcZvH+I5rp+B7E21X80h7iAoKJGjRFot9U2rhtgjMtWlfBfljwXD5nJMkYYDdMcLcgJ5bk6wvphNJVsqFy7zCr/o4GuuxA/XqXEw+IkatPx+1dLtcxAR7SA7gtFLcMMoWJL53DpVSxiIqvTF4xvFEBYpPc42RjDKxLQFp+pBpC6Eia5RRPUw8TOfIDJJ5eJIsZU+9//xIwfMsEXtTpaFLj/4nQGnxqtJ0I7W9yZ0Cr07i9zzT9kdZ4Dwume4nyE81VPIya2OqZZQwkwXV6wocfehlzbeEYLQt6Lw7VwcHl63koRGSY+2M2EHVzH0HUsg+hBqMTSVcLKsytw75/vtU7eIwC4zYRPJ+vfi+HvtRtJVPtMLNe4I5AQkrTOZLzvgP93OFy0SaMC7eLP/D+DUu+S1pd8xeH3CKRkdA/iwFFRRi7mByylSK0qnlivKghUo76UzfIGvnc8rVBaDWg+7Ro0tYEGC1tKgUy9jkoU0tbt8Z9siePEFe1mZg/ChQlYiM6hMu45Kuy70mjC9gRiqWCuFr1LJ8xVjM/k/ieKcYXQmJubzi3mXV1E5M9d6e5y8RrJwtV+vhlv1yQwjzdQn32w7z9KEehmgEkevgNSG1ZL3rem3C0qi9KdHfYu1bv2X3CbsVY0kS1yTrFyNneLFpfJUiyEzrgaUtjeJH0Dz0AmX/RFd5oR/K7pdcHdTW/Nxk8KU9yzPvxcHj496Cu6A8lcvtLe9q6QyOQxyAyRiiSclLg+7XN1OKRF193vzojVkmCg/VdGyO7lRhB+Os+e/lWiF4f2ix1ZcK/hEx9KXxYmRP0btH07bqgN+9QTDRVXeMRHky1ilbTuPa/cOKPnPOn7I6YBBzen5Xrs42lVLwf60jhNQ1TqdytxF7BS8WE7QsLIvCcAOWWZ6a3Uer/sgvCXqVT0Lb+NwAgBGK2cIupRt6JcLGgUTuuktXgacuiIu9is2/cG76q52JWXfbwEXEwDbh7oKoZjrkNLub+WHXxw1rRbRgEth55icO73+R0pkAzKkY009Y7BWWRuV/IOKDioAuNvmA7hjEP0HFqZlmqXk5TRDeXdULSJF2pBR2KwPTiVJvowcN0kf/OnCdCuj7Kc8s6XPm7N2w1rYQmXCiW3vGFDjy9S/iFNMbPEz2NIjYsUzI7R7N4aecal5kOJPTYTEoIBOIHQITz+hqmPdt9vxXe9bPRfCcfP5VXPNSy04OYaF//tar0niRF4H+RqN4sQREX0B2yWtiOInwKP5M7R79AXDSCUR0PBIaK396zqxnh3K8WwnNT7+oA6e3rwtwZvfm8jLElztg7oZ7PYEmPt3DnOE0UUWZ8WqO5et2UXg5y19UTl9ErBprxOmRcZ9ySZaCTo70jNnUZMPqKhvmpbysXKsZwzA8tJsOZgaXLaAI7G0oOfwjsb7XNxfn0eypBGE4WH6rSS2pVWDAcjmhQj0eOGt/nDjwKbWJFIwwz/SZ1B7pDHq/QiiKjNEC80ze+0jCJzQcUzJwQMpzroDAZPTkvpAMBNwHOOlJ37Vk9tLmcIyjLqGt3obwxCmac4O4J22NhYzXuyrTwoqGahCP7jqyxOhaIZSuvulRfLOgAv0KKzM+Hv9FnH2B51L7zUdbszp/hQRM2+d7MEBwUpJG3KE6EpZPrdtRVbX9dvBmbPLHD3uQWYZ0F3MLaCDh8U5mMmpdxhcttJBCTv2NVmDXo4tgJya/ayky8wAc+5zfzHz094U+OIioEr7B36+bCyG50SpCshXUzvOuVFBxYxWUVKVbQZt9zYYL0XMMVPqiCwjMLhE0J/M1l+1INA8Y26emQH716NZjKmxew7Mlu8zpCJXSp78cvtBQgrmt4FF9OUWlp64Z2uotjv5Guwg6D5m6VJ/qFAfvpsjYb6vHUtaNufvt9IOeSbdwV8e5iRxbRV2dTPjqfBAvpYkShvUFsLBoMotafB5up0/4SaNta3QfjJ+qKRoSu4/4pK71MtHUtPT7UAe6IhqD7tDaHCHPfmX4En3dm+uSAQLJfo+KRT+DJTlPPGQOr1qu0VqFH3rhgdxJNevnnrW9IgmtDLzdC+eNx0laB0IXCLPjPmbXDXADSwmVOyMP7MHnMFxrAED9b4k4u42Vb/32bVPApA02hL7uZx1hK96s9auLzlfchPiZvmk0CzC2Sj/8XXpkBf9D1aT2G7hkZyIkZ7dfFrxfb+57grm8oU/tW2BSc732sthdhyTHztAdW9I5rxf1/H+B6nf51uMmVyziDuGnKKXj9IvYP3cnGhCjEYK9z1/S+iK0FXFqrNvMnebRp2MUJVKfmWRYZ2PrV363hne7grgknao7Q4F8E2uB/FkmC7Am9drnw869oR6EFDwHI3VQtWk7zLut5XLxwBapB+mglBbpkBhLNgqF/fbtw/93H1osONU3PhbVvyYqUsDLAp2k7kISb5FdNdCaDpc0rxL1Wie1s7qLl5LHXRIevyYXnU5oMeH9jLHP1KHrItYpp3sjh4GbhuRKZKiGJG7YYCBrSqg4XNGjFyjrdcbahDyrXyLuaPHfoWC3zXiDPxBy9CnHFP061SmS0Q5LEQaZEDGul81Fl4i4ZygRdbELZ+Yx/SYKVXT20O/pl8TcvvtCKnnhRzwzOY5kxFtxTxKfX5AUlyRWnS9+ksq+L7tJJGaytoeeuWTjwcmnBcNzxh5pxtMSg66+paRIFJcAa1UL9H8d3AXKSUbZOE+ZyH/lDbDWXwzuvvPWzDTZAEErgkhLXrbOHT3R5hypx0zCm6hQFNP0wNrMGiIR5qPNbj5tPGf0c9TPt+4HXJT7NpA9wmQLBuDzw4BeJQ1X7qVvHeQOnw0AXLPQ1xTRnOR8EZxRTU965I/VX07DJJB8VuTFbqxubpr1xI7dEKYXLrzSvDIxRRsCuPkz4PjFND4QIH37YKrDSQImthG3LmfPFpSUNgtwbnhV8rFePTr3EZbIU1gNLwHiVdriC8t8varlD65pQd5RWN9DS4FFAPj82Dn1btOvaj4d3pvXsCIA3Icad+Fy1vhwecXDqwfm39o5jkPny6zb1heA+2u1bhobVOTGhUWF1x36H2A/lje3M9nc6xMN4s/5NbkUdPQZHgKIlS2dsdVZeyOPW4DgDaJMkels/fnHuiMXv5Uyl+mLFAzDINoRth4LgmlWzbvWnTbvj5p2IVQQTPBY0s2YRgEsMhgjomfb+ZMo0JtxU/Lg0mSjC1DENqksp+eRdJDHMlRbAYfjankFSlVQkhVarzWBgb9CM5SmbbQ/JEIJO/akVBy1l0Ims5HrACz5PNn4k51WUkLWq0GdAWB1C27T6uLIBX5oRaPo7Tp6J2KOTpt16YNModEFdxRTQ4dKhSlGdhnBcbGq99l+ucbeSSAtLb8xib4gy2dO0Nhe6nWuUB8v5oKo0nrZmTjHO/XeNtrDtyYYGUNXYz3QVtIvPGpKHI8idSXeHPx8KMM1Ps7qXP+6E5L+TVvRR94OTa6VeWoo2zIHoxduRWPvdtKHXSatjPhFHMYe5Le3yBuG3dvbm3PdZds3DQxl1gyqepilwVEgxiPkBvhvm1VUYxhSU4O3tpuOb3uC4WwLM0kf5PdCL6YuxnKHxnLMFwCowjzP7jMTrxmOvXIZLmZk4zTG2GsqILpGnupXzW+FOUq1g8b3o+tPukOUkYwr9pXKepYSq+TX2pcx5d/tlW06atZzUEspq0rHsQmKYk3AAfGVFzWC4PT83ELxDbkbC9lgmeQCUmqD4vgFoAfFD+Wqh+ynuKEK1SWfRSAKM2drWt+w3DVzDrDKxsY0uuGGsQH/Jso1YO9lo41sXCwaVmfKqcsIic/2mNH1UWWnyfVZx1ynIhke49RNsUkFKTNIicGxse7y1vAsma6Ss9S6Ec1Pzrb+m+IwC8ad0SjdtslGDLePPjXUsz0J6zCceBKrqrxMIVpILKyJ/bispR7V4wRnp74HVPp4HxBzMBHDqEJX2k+Z3ObuPLQASGRU+ITYVFGMXgMLcGDD/Kx+VSt2weAe4KeLVvdBftzWxNSn+0zeAAD+63iAAaF+sbmzfC3aS6cw86SOjLlvjvZxwEvoe3ktr9eTz0tVNTM7JMelvnRRIrOYq4bTvm6J9YAKu4MtcM4iISKoQAGjofzIeQ8PYfnIwcgtQ1y20i1B9pR4e4Sgg/J7l363HGO6BtAo5s4Rt2DZD5+Baij8zur9OMUxClo3gZkF+01/9XMD+dbnbJhgZYLKkYSH0U9Luoi5atLTYRyuxnzYXatDQrH2rKIHDECq6EVOGIoIxCYZWiQJuutmctoPzhX0TN5sabenbeZPyfgQnlVttW8G2ckClEYikh16jToKNG1MsqGkeqG6W6wJhIyVNW7aSzgDLbWKGiWa4LXud9fALuPBJThKike38C+dowoqOAXhYb75WenrChazFLl9OCvgXwegEYW+bGQdED0BKusDqY81ASL+oRCZTkoqe2DUoxUNwQypEI4SZ63FxNVqmA5o6m7jo9K0BuZRWRVu4cQB4nnzsMwPLNm7XhidLybjuoYvGN4vZv3GqQuY3ilPYhRnzNGmICpsvwGxIJrBv4kTW2uhc0DjJjvmX48I/NfkhluKH9ih7UOfknUtYYcDljD9OIaHAJTyZWyjmgr8NbBmtO5GOwE5Kfeq6ZheliZXtD8PigSD9qB48kCVLaqKEHlkS6zPK9tl1bODH9rrWNi6nBhBP5qtTI9yxO3A5hmevKasmbCiqEtJx+tIpeb6Ge/p0jLUUM7/aQfl/mrC+8f9JwSI/aKMRQ1J3VhyjQ2jPk2RweVOAJX0J8uE/PBqoZ3CeAbHXNeeHkjUR62BIbDZIJPOln5ZOpGMzM3pFWYDd5cRJezgJP2bYINM0yOsCgPQwYuND+52av+Wz2PIGb1OmxkjqlogMw2H/Qierx0hxkzlCTuUvphReeFUP5JQ5XUN2HsZfY2UD8BYxpCKTNSOxOlXrBlfBIwv/6w0pkA8pNHYvlM8Y46mKjC2af7DVsRePU5xVKhjT/r11dZWKalJSHbfE6u6CUv7WknUE5jTVTqU5n58eeok3XraG4CL+rVhy3Uh3oZonRlKmH9avpV97GF4Rpc3TQMlZvpaxehHD5YuZwMbF2I6eLXN4A2PoXEqOcOQFS1WX1fDMyrHdQtsqhODV72jZkZflnM78dKkgW7oNE38L/9E3kp+6WgVIJPB9u5Wx3ho5slirXRov0BO4+gsvPrCYgKg16Xr4hVlCwZnxp0Cl/Dkw/C8QiXU6wMDqyl1DsJD9ZjXz5EsOC3I4iAOwU77bW2kwsh0zGEW5t42ARrUWPfXASZtkygblrGhG6KYoo3N9+4giS0S4VDH8bv9Vid2GEJunlAjeqbuQPxjjHB/7Cgk3bxPYAoMuNP06r+RtMi8xsn78LR2UhbpZYlcKRsoVqgdWnsm7khbCVu+J810FJzkSp72RhyXOroz9nRMYPNx8ZWKXrb8JXdDHJJxh7p1Unze8Kp6vDm492Ww1BBTLjCw05tj+B1QtDXI+vGOI3DrtvCCGMMeHjRTU+vNMA8lSzOdtIlf1ZIvF0dVj2bewrRNLV61TeREio9TZoylnBTZqjZjVjY8si5mbC+DkPojQV50bOKzl1U35RnvUfPEofqYbAlzBweN/gyeQJZ2x7ylAjYdg42uqSEpgFAgJzZFvAG6yyPLjTDa6FJmQZ/fub7aRn68WuHLEiu5AaDM09PGzW99NNiaTrUxob9kolcmQ5vqbl2euRA14XEzGYF0w9wVJulSDKUZ3ZWBrZN45yCKCowKZvBz5eX+4B7JCISmKy/xL/U0m+n3iZZl+3J3pPJ/j7SmbYnjPVQ+OKykPSS2CEEnNiRNtbuUxATaKl/COxSelv8HqzXgnW12ReemoCzBmGr4Bo0TwSGFQQ8fIWpF6LsNfTtQAqK4JppP2blmX3npuWoPCBkOa+v1cm5ZQqSPdTg43IOPu/HOygZy1U0JrRqy55O0IS8AO/bf/HOYzOczLwVIRhnov/2S6zKFfzqPzgx1915s3vcq9oBlQEtb0NAI9qiXg1nduWYbc82ZwI2sJFIIzT9xS2fQ+0rmbfUATcDPkaozqjr41IaX9NatONOWeNCO4G541DlHj0uRQUo8wZVdivP/oDdEs2pA5BUwwWwqsKO2ZpcFdhA/oZcFiaLQqnzEXs7iv2YCkeKX7MI3l5nRMNLDqKWqv20XZxZRMjvdZzMdBDkfnNgBEia5laN94EfG7d7x/731H7wbkCX7CclXfW4y9GaEDGHcYFwC+4CJo261PNqcJxTEn8fSjZ/uRp6PBVCNFlL760PjFreXSjdgpJA9fuRJTCnrIWTBM443tlyNLoB2WxhEvnJ/cNI4hqNu+Wzqy9cNW6Bzfb3EmYGJictRYfXu/XDG1QMepgYXaJMPvCFg35N7bm1h3V6nvqYbKA+/S6ABfqv3r75WdEjDYfp0LPyTetydkauR7fZN7m7IgX1blhlkqxaCb8Ro4uPc2H8mMCc8zFeszxtjtriuKYqrEAUwxMkbU7nY+qc60AR6qpohdHjfi/PRlbiRNHTssb38x0qmRw5ufZRaipW5eaA72ezZU3R7NH2sT4AjImiDu+XcrPy2AWIo3pcUZMNqK+38rJq5/lNXw4OV9fuSGnemuwQyWVVN1XJSqWuoYfKPpDfF3ovk+QH1ag35uQc8zaWVPu+/en9eLy4RDkdYG/uLrhVYAv8247EcRcXN5cFfC6F3oO/0wfIO5cqldFONJJz0MgP0xBpKRuH7YRO0pB0qtzj5iolMmGmSy8Gsts3/5Kc9+DEdKK7SN62CPQytEMuFNQMKQg0h769EMHOobCl4MRltS9v9wpjk4c/C/4LfOHxGy9AvN+iDB9efUyIjN5XknNqn/pbEPLBWBz5GuNXVQtu0VFek2e487ncA6jAeGqh2Ic6BVELIQlTt2w+K15OK8XlPml57tGnmAEptuNNr7/CxY5uc1qWItY105uBUZvCTSWrCIEnvsaaeW9xgDNyCEsvQGPqAFv5bR38KXsQBtvN+ymSCqfPDyOkuroaQ+kZTmORECa3hzA6vCG9OGX8JMqLLCER8ltx7uh46hMDntDQcXv59awlpU0+ohb6gxYxL4wq45UhdN782Wj/QZLcuojW0CFLE3l+euM0ZhDmGUE0IY2HQ+e1wJsHLOBSwlrU8xsQEydnXDP3nUnHy0l3DrsVI+UwZ/kozOsyfs5W/Hu19qCff5dO4wZe2Oe01QSDaGePI9aonx4x49YDw3YJlZQ8cShvRElpDZVAjJe90x77dAtfBqcmbrMvyhPZ5R7HolgJ4KcaWu6bMZ8RzjKt4F8Oop8k30Me6ILkGw5BOzCS8NbS1p1HQ17SAkSDz2wIr/au2x2sl54kXyM3WL9Uzb/+q3LT1NxO4CO0jOY/lfbSWdplvFM/Bod3pnzrGNDR4e4rZQj9Yi392VxJ+msZ/2hAqExe+VbaOXHxg7PpI8yR6Vh1p3bICxTAljOIP0doY9vSWfshUhvRnrRNaVwyTh9d46agS0DWVEIImkBG0qKbOs8Ui/3596exy/7hxvAXqJeieJrOao/Kd+9ghLsGKWhTCyhxObeF1y67JD4sfmmOECD8GmGTpyA/PKWzRIHJz++CeI7eBNNBQ0Ot4pm1nu+YsUL/+scKqHlGyGuSXO88DHS0uXeohBq2G0BPVp3il4AWmgdbxJMRbQuql2q4mNQs6fuJAeVb6Cac3nfGhW1bhYnO7tfpImtGoVzpDYt515cx7BWfZDatqi+ptNbCnMhnBANpq0t9jcTTmafMnzsQblkmV3kNDRqaOf3ljbOuRPGe/EEjfKGGLEX1k3RfmMVjCvx7OOaFv5Y3NtGNcON2ifL5TyNuzBT58L0VAQ+IZUUAX0SbfarHAplLD1vyenvkVrGH95jFzoFB+nZy7IWID7p+F/B+hzllc44vGmZQaAYRtleiFMzanSoZB4ZoZjGTmRf1Qk8kIjyxgE3hL6xxt7iLgWzEWvAImX5iU9jdhFsFtg8Gar3sxFnT6e5wElxyv4sjptfICxmylEJriTDyqJqgNw3r20MsWJOKU1KnVpNEjbkL66Ax6OHpBhDE6iNw99TWuNMYtGQGLlcntD9a/Iu6RafH0bMDwY+3Ozrmwg52IQmk7+7sDDrx2EzGDHZyyKPFZU91ROeIGNeiYSIwsaxQdwf11OBHy+j4KbwRg1L+m5sT3N+lUCkE94e5IwkpKJN7iON3tGKBMeWauFeZhT/v7oVsyL7Wpj70CNSdgJhX6B+PNQpopazihoqrPzwBsGNgcE2G6uL9I4BSmZxSbRyJyLr+DAbXMxSMjKEKH+x5w6avvpAJNRpw5LSfApXNNO432y063JDji/LVwdjEwk0gYGhvAiGBpKDv7DtXS7AKHPBM3Q9n9puGCGX9u4tgci46cWEfvAt/U7HFMdKx+ALlefAf/uCkm5dMflsYhjU+tGwFhEDGLgY+MEqPcj+GeRveoHsngOYkayWDJ3HbTScl1gpxipURLifgFLKpep/jZAKqJI3Z+4iWa9MOP37B2vqSTBX1NJPN6m0epWnMkWuFN0F2HfOfvNIPgabt2DtqUvjaVHMVnn2ZVEa+G4TdYvExnOaljCu9I0SeqGT28I8ehUcH8E39LPHn1XBL3/i51uo+OBp9LRSESvBk3kB3tw02p0fGxcARZgtJJy1pJF7IarBWOxOiviIPVO0tOLDREBgAXBI/5JyekGpqyC5k04pqNzMMY/+3govspP85jc+5SyG/HbIv1++Xp3fz5i3ITstpZOQTMPgZqU2ATp1w6eGbnmst0EzX0hp2mxkSco++9T+EQG0DhLcytRRjFzeHXbmIpEj/H9HKZX0hL54fxA9cVM9i9OP+NuBHoXOHAuEyh8SKIRmsAHt5ZoPTYnx7QkmEP9yxPkB9MkBBFe8Fi9eO1hb89GFwy8zOCQR8HL/JmU+TRm1N2G51UnAmjlSVpYrvdfbCOdn/iS0ihRGp8MHR2R0FY//1nTLMUvAtC+OD4fPHZ88vl7Cnz08vQFTsI+9aM/8t52eA8UBLaJMKl3JGJehGIszrHUMa9yMqAg4Gwgu2NHJY+sgeK5gq+XiVhrnJ3NkRPqjNH7uyhyQw4ELNlzrhDSxym3Qp4RDA/RwZe+V8e3e049HhC5zdNjksccXpG/6zu7Bl7sfi6hr7RKEeH1le/xb/SWyx7Qd87JSwClKttW1MZHmr4AmQrtDzOEhr7t2QYYFaCx+6+4L5eJxOFn9wjE97Clpd1CVkhRkzwxYFE5JAZ91CgM+Hp5Sjt6TrqZV6mWUj53nLS9HzjYYxEl5Ouqx8iXzWa8lBe0C0GhP3yUBMtf2xDpxAveF1Pl3A+MXfPI8ldQO7ybk9tQAa7d4aBSs38v/qJvwDrIwIPDTNR8PKKMPme5wFrdxn6uv2goUbAeG/20KhyNItV+WA75yxkxuFkfJC041/RGDhs6fLoh3PbQfWUP/ZbU7dFOZbkTpM6AhrmQrrHSPPpE5LHp8GqKYwXmEyOyjC7GUhFZN+eZ/Ny72DZ6pg8EiULAAH9eODhxrPwFYEO1+LsNUg1mj/NmL0q1ywf6Yc2jM4mkjV8LH+cmJHhJ5EcmUmWbTOGaU7tKznCcSy21nwI2I8oR+US+aNCJZNB7acf/UrGia5Trs0JGe7j17s9theEJyL1GNTvBJKz8mhYcPYnZHMsE4LeHrfxXQaeTF1zs9XajH2W0N0jEaWiPsXkKIEUSVvrx0BiyPvVejNDn/zi5+7J1siyk0gZZ4Xh2dF/IBbVnL1z43pfUzyyK6CPLNBFTFTjQSe2G6okEBSxlfNbAsLRO1fVYobQh21+xp2KDuyN0AZpZq542v0QidsTlqRMCx+oAeGkR79wVXGWketsohMOk2O80SbR0zZfDTmQfNV9+lafaKndG+X/EYbbLDraAMzzzzLzlOEWT46mJ7DxMmg3TrSaArmIBW9JWcc0Lq5uQ+jgm71+mp32BfjsBOz/2YbZnLpyTdseSXlatI/9edgoEVDlBs3XZCSSw5abPASw9mMLPaz0n3fiaAkBqSXAhu1fo/TasHM1N/UIus1FHHTFG15x98JKoU+RPRXdURLYcJ1OgqCFinW2+rSSDmOppfTAfgojb0Wl2PrMDAz1ZEvIdsYlQrmzeRZiaoqL1jUHpSWQdmpEBL/ok8lL1sRdl6wAl+CXsSWPKX3pJpib3g7UK4fMN4ILqb4V3wpGNoKOCyxUKnk+pNFz9imXfrSXiKlHURwOxDgZBT7kmiffkuOklhf/KWmIARc4ejwarkzqfmsP0AMaP6qw0eNJn7UNQnr7YI0YahCEOzbXGlA9R3KLhYY6yWswRl4gbaTTp9byL+PBrvfi3Y98w+hpC8AAx5zeLRzuGDyVSbxWpABOjgRi8CGxFSAtDqHJP74j2a6o4tXzkpq7IR43MZ+CBBCzR1YtW+1MbSEzha/elafjTEcTCMzKfNOAK8XcvOFU5UeS7DWE8LToV56YoLCeoH3hN9PVu99IWMWGu46Y6zEQJuCbBKocQu8LHvyg4rwU93JGsKr86FER03UUq37Qct3VfRb+Xj7e3JommgScWulB2QOK6kbNnbKssx6kZrUuzBZIjg6/4sZyMvXIAhTzs+VFE1tJCWqjfBWI/A8buN+CjewB2Ft0Rh2P+bxAbt0mcQn4lK5yBvk90BbSiSHoBewRaihUhSQRFxhq095PuIzOvceqNB7ll7VbvOIUwMVEGP6+NZN8og9sdR55MfUzuWTCO9VTpmth4+RebQVmu+d+mX5BZpnjJqIhd5h/Q/fPGJ7o+nWqLuTrY9gOlm0e7rXmlzlpzzJXSK3yNp5ufUU8pdY4rRKwJd7hOvfAoC6W1iOL9sTS0cCL8bn4pk9UKBm5T97jaYIHyTUuAdkkhzBUOYac+DazbDIjQlrOsGr+47SoK0sX1e2dHOwUY+FyoU8W5XByDirWQym4nspzhsQc8ha7L8R++0pCiRHkI3B4iTvgBgUtFPgumHPHkdFd3UpxFSe18CqDNiTXy7Xh0KDFP8WUsT0+EfTbE9w/Td/EDitpsQqah2kTMgH2f+WBnwj7ou4x4uwL5x9eJkTOYXZy3YpYy9uAZGDWWJxGIjyxmD7UOjjduda8sxtuV8P8y73zJq1Wf81W/mxWyAYtNUMwsYIEZp0JTIyZIjt6cftiHfEzz+oZftc8HCAmkRpUxyJxuHn3SM3oLVluQbwB5RrZ81HsNH5+dIhmY3C5i7K8g1gclxG+p21eEyTrZrQEcAoidOuXUMvSv3E5N5OHztIBHoolCl/ErkJ/TFhfSXHKUzzqaLcQoXJTvBFhv9cMNj3U1YidHo9b/KLcydS8nBC9p/8GWOY9s9py0kx0GYphbnLWnNj4YI+iTtaFfXgqjd2UIrMffBz7pfPzA/AYCvgqT8AVnZhLLaIFOIHga72xhhHYVzwxEFOKtQoNPidUxfFaeBgNNScdpW6wmvGdttPpyCZkFrnDcRjHAoWq6UnUh2AurZNbUVD+at9g7IN7SBCM5IJvehNWAL2RRytIY7Zfmo+N0ccvhk9hn7JBmnPwgfpTAMAJauF6eG6bLelkLgOeZE1rIA3EvYXh8R+Rify1pM/wKhB2D3SQ2wej3YgB9NUk/9PhcCkJEcYF52glBIy2NmhClKc6VljCde6IZcL6chd0P1NYHvrPoBkL3luDPTcKES4F+OwElImb3e0Iihv9qessCWfwaKNoMNgfkNkXY6BAT7HNiq39m6f5QD0sU3fuL4uEPaNO9tCT2iicRGzdbpDk/s+jsLf874YcSMyLWIz2eKRTDe3DNFXj0V3tL1D5Wzn21x0bI25mSTJROSWZNj9KiooORm0E/7KsZ/9HsZ3s7Xm6ACFggzqR/HDSlqFJ7aLEIArILXy8Ktz7wkcqdmxGQlS8pLTf53XCC9L9E8G/l4gcocJp/N7pkaHCFCeHl0lOu582EuxLqFNvrhvhZujdskKrIylCDo9yb12rMao2oMPMax0rM7RLdNo84ecvkLrJxkUxD/MWga/ymB7fhLTI9flpm9xc+HkQRNg3HfmlJz0blWMNhTqWLk+7pyfPQ4G1/mzhrcoh0LIQte7zpoMyk0IBQJn2+FrtSHvP63yD4+edwN3xixYverOU9u5umIXnqGqTjYiUh6IapoWCx/lvLxCJzBdzestxAn4CG7ghSMFQlv4ld7Nd2u2YVbbvOno9QA1oyfUdWwVDoB2iyfNU16hWMLu8qeVHaAAulYyFFNe3+gKU71JxLfg/RJ1jUEt3Oo3ci7d1vG7wTMrqct3RtWMiEIXDH3X2Hu+8LtiIVOBh0nxjjhksmy5snfupC3fgwpLlWD+R2czf2t8/nWyU1guEi1jtITQ1J15ZR//286WtFlcES71puKx+vRVMl0CsohdTGFgQACKLq2+9zpEwIqbf4bWTZj4igo+nSIJSm6OMGRgGfwuAEpUL/McImdp9U/6/X9sDO/Zz1KeAg5jn+ErPzzzMgR04hVKeAO8KD5VWuX23qNfWM20QrPE/cdm0eQmuRL72JTP9jp7AIPM4A1MNYJIvbWXgrcBoWJNZl3goEdhr1I54oWB/RPnGbdq8Gs2BakViM1Y2GD/UycbyvG5vGtOoLjFGjf8wR73pdjZl8Uu7mHT+xRIfs65b+sJUeulut34oVnJWUD4i3Kqr+rjRUbLuIF7UIZJrTZP7jZATlKdHM3UfuBfHO8pUbk9G579fWfIcG7Us9OkQXARANwVkwzrrKna98KWjvcj9fowc1ns+gsYoiTns2THM1CzhZf/M61jAN2Idyr75jcdvbraWFX1vGJKGfNVlbeqdmTCwWvZVxDuShCF7BjAxa/Jwk8nsJPHTbOkIV42pV0E9SvRP4fx7cvR7zezDs3giwqbOsagbGGIpbGSyaPX7zRywlDfva/PKstvFOWoWcC01H92Qm5lbJsB1TaUw9RUsIzmNysrIEgE2Wk5rMOUAkDXSRGq9yq9Szri/pXpvzbd2QfrrbQJ/hv/Ogv63Q3Qih2N2SrJEC2ic3jnFddZkGBspMIm7RP7jKzo3+Vk5ghIAMAS97mIXY7VrAl2EszVExbBt7IwRm62WAN1DsZM6AqqousdVc1NomV2um4C/W0LNpQk7n4zqjqxbn6W9P4+nmMxQysQFpkvRAgua+bx0xIHcLcBDpJ0QxVGxKdoBR7jcBNLXAx6yNbXNHk9km+SIWzZG9ucivWru9ZnFMInqtEko1Gbhd0yFBEkSlvY9DCfSTcEQdaCg9LmhvS2umZbpsrjhwjMJh+4ROWhAqNAnC51C/fUsg7UxYszmsnRbqOF48qpOTRH27+zCBEM3//fhqmPMf9jaLOpTaDxgnKG+AastG65loUGuGexvazzN8qz6Gr/YwurkKamW7AMj8Uh377Qoem6JyeAZmRbF5WZbl/UeiCeHw6DTIzonUFLDG9VaZHvOEm7KdoYMRLsXMjGfNmWASEjoEczZPOvL5LUpHJWB5DoR/BuITEpTAoMcwnqDw95AMjNYgMhIntMD1NvP1ximdvqenMsWDdMQ2XSzkbWWZid522UZ0ow/NuxQTjqkJ/Z55aWM16udOKqQQt+x5KuFmmAl81a6yWoIT/YzQ/tf1ZczXTq+Q98sQqC6q18/en6ZlEK5++SE58+qRrE96A2VWUqtPrNzCG5R9/OzucrauRewhJcXlxV1hb9j3rsuChNrVNLJUFY3ewaU2Z/y6NtiJTasHcw9iCUAAFrLBCeMiTZl0IeCpxYBIlscuiImJEQ6XrcMVsWu6rH8Dz7dyMKYF8sW3UMhGk3VjYEqTTpblGfg6s/ghMgE0m/7Wf7h72EockA9aGgLRQ+eHiUlML9yICIJ6uj4h/xpNH06QVhcTSY7aaGuxR8nnIeboDB11xVB5mmHKt0XI0ceMNbqVWoScOg1+uk6Tvqr34K1PNgyGrs4xVKF2jiqGSZ5Bk0bNdaffLxA4mtTPx40TUAMf8sU2gtEyxe8AOwqoDlVR3xoQ5JU8YC9bEb0NHc8nhVdxGI92padPLKZtGaZSaVwvcc52VVBamHtSOf1yEmOxf15R3cbZEoGe61ZtPaqPmL1lrCdBXso+zV9yb0wQv+ytEDN3BIee+hmUNJ8F7dYI6LHxCPbI115rf/9e5Cl42cbopm39snMSoHWeEpkcpEqOMbzqkvk5McQWYHNMdTN+e6d9OZuHcKmXkidXwg1k2behX9oJNmlUnsL2xMEDavL9VWdYOOJ6HPaoQhy6sdVk2O8cGrqWM9b8ybtFbwpGwghy5Xx7oXP81/8EtkVAxk/bSDb2h9+dUhG9M3MOZcxklP8BluHRyP+oWQCJ9eWKVy6pEDvSsHkUcIzYWBVn9g1G2ksVRiZDXEoZvQdGzUD4Re/uNUg+BxGBwaxgZbvUO4LqIADGSulvbeUm7dYsMgnHrgZjgd/6TaRQhFUNXS+pULgK6X0jlZfNkSMxY+fyibwnr/toh2Xaqv2WZxheXiPjTSJ4Iczx0X+9Etp/FN53xSR+7mFIddrg+uHcxNcXZ5+bmQfnfset+CRyHFcN7W2l7i+alz/xi1EXPHdPWwbyw3ArUIx1oeljGdSFbBhQKjuyZZyL1QdfDKRxuPSBVRpExglH4W4+d0aGWRpzibtIT/mP8u3m5p2vIxic6TDhkzwAabr1nS8M4pOUC/Q95WESlj+9R1jcpvCX88vjlWmTAU82jQ133Ss8vkj1Qf+SvHPM85697pXCUjbziPI+ruFcOuI8R8Y9d0lRs+cwMokP8xQPLjFVPzCk6OmqmgSVkcIcZx5JbmRfFVKk5Se+beQsHrmpYsDCdpi/gvZUh9eDMUe/VHhL2nKENTZcnY7WdmmlanoIQD3TnwYMwZm3TM0L9/+u+958UNUBD1zy+Esvnqeg8i0bTFf3lnM3qcnFDfshYUbrPK6D7esyzph2owYeN3kH/fh8lRhSaHvLn212QCbvooXirC29DZzwO6SmOYJFLTU2BRx5Wq2oXXESAJ+aFz1b6FLq3agmmX7mvwJONuHNPeARMY9T6igIHbWp7K/PWfHEvwVA8nNiB3Ym5AZHFCf7EBuETeUImMOx5R/0ZnD4Lur6Fs/dUxvbzWBJtlq4Z25mVNkj8ZtoPCgynWET4E73uubZck22YVlThhQAthAR1PLCmijIW3SmX3p0N8+/py/aRXgPi3QBkCdXkuYuBB6sR7COLSUeT1keXKDredafyvSQ2msaMxvXLWFQY0Fso3Iv5TKSbL+AK0MmXHsRoouW/Y0rqWF9nPNuOddMgSW4sSe3Ok8Ba+qpJ7L6DNwTHTOGyonyBbvFvmIbCVmAvd17RloskVCpGoXBYsF6H+gIs0wdJUmLFnFpmIkSHHzRD44X9YWb3lXmmruUAJFNMsyUCEdkhX9zClRbYI/YUKxgD8FrP4HIOBdqWZTcHK0Z5ozBgMDN3xxSengbyRj38CqwOtXgzPsTaYSewIMJH6bbTCA08oyJBKIwHba+6YHHhqXXVXtlXNYUtf1Y5SNzQCZlLE0+ZwRNRVXRGk/wyslSqGwNwi2VbDv950CYcMIgTMGGEv4TfeAUo2bA5+0KZF7MAQuTuDwpFdAQ+vLxfOCLUDmP4I3IPTNJ56MRyBn42JYokpN4nNEQ0MMce6XLiLvQ2GIHIGmvxvcxEEnl8qYh4xzl7Bv2z5CshMYHXpl0uH/VZdUdN5ZBsOQYW2DjCXJvHkdYxR4125hXC1eCi9OhX8/cDtDPBuahOg2sR2ja2IRXvWJUGojZ0HJMFRGG5afvbcdtkPLoxus8jnnv3RFJLzq+1ING1o3+Fqa44fCNwYQGo9hhG7p+CZfWdNPrK0rehwsmzeOxnNcXzW1k/e3xOJv6WHsSI2qhgGoab3Twrs0IXCCp3sxzWOKqX/ZCRwdCy23Ifq266jsKojRATlAUCFNGcCZxXjE9ktfEuxblQMlZugM1yaTaYdfr31Lr6hndHZ/1nY7lyt2rVkSko7Vjlz+edWP6OCOmQweH/sJ78sKNZuN23dzPOwgVkRA9gZoD5qEtJ3eNyuHMNNSOnzFIDYQQ+BPS+7DmW5olBZcouJ1ghAtpofMD0fOQFhUSbm+oLeTYx3fnkonFeKPTwJKYgWcBOPpxJZzGve2kSUFqb57qwGSOXX0nJp/icJcenQLNskqTNr/PVqmFNRjdhFYbjJ+LYPK6QnumJ5rCreM+SG5VUpLzIU8QJx5xlztTFgGaowBoRU8B53dilUd0bH79lBNUnoQN4N+63MNurD9UjuFxKi0qYxFyvQn0Ws/dwLntQ14MPHvJ5IUDJ6eTCWBiEwaUgK3Am/n8WSabpXcnFbWfMW7uAnoyRM+sqkYu3vndDK7wdcUV0HvnBXnfQz9Gm0bOigiwgm020TK2ISjHdXoOwGy2Cg45jWUzWy08k2iSzcSmUwIV+L/oz0V64QQb4Y4sEfHCb8WCqZK0y8ZAQNiiMw1BwE/LTXUul6wQd94hm4JJtcoSJTRR+/RUSOZEHNNo/a6RqoN27rpf2UzEBxGo6HutjkXa2dzTCuXhqFXk/gxgslLvwQHQ3cZedmDLu32JWP2Z7CaPxhGNVMd7WEnxHMOcO8/L/60fSSv14Dho8xP2IlPwAl0Bfrqg77jUN7YhUoppVU7xr4DLGvOO7oHK4br3oAc+SgYfucFn5nZzbD/pIKk9i+j/vXztQsAsbweS+wDHc9jQ0/oxaYdSilEJYgjqUJnrGwdXsBcOFVvUIY8MV9/MRgyqcBlC/hQlCd9/hALeQezJ+Q06UiEwxgst59Nnbf0YkjDdg3Ki9mGhkUBhvMBqHnC40BPZ2oZ9ZZFuKT575o22E0NyJDI3WfFgrHd77weg3VuzHXWqwuRB63D68MHUKOiGIJETpinyXkxNexZBl23EUgbmyLIDa9SC8Vb3PcJa+6o2Gq14KIpAuUKg1HxVHNCaI078Cumr37tae+NKDWpi0r5r/m/krcgIQdBzbSuR7E+2dK26LSuPZYmucND/USL+ifhbgMtjX+vvNTyq+i1EE8xGE8dPp3CW0IV0O6yzKe0KzIWakQ6ftmLbTUlfywtVKx0CO4Wi74yOd6TmG7dmMYwt5vx0bRE7pjb/zV+AfcKI9hVqFTxuVeLNtCmzS4DERquo/tkJ+mDHNlSB8qpuDiPnbBfLVPkPNW+MNLUdxuEWEN88WExJLs8V0QGRV5+myKLmwhb1UtPpEuToR4rHwqhUQE3ljbct7w1JkYDOnVLKkNbuSPNH96iriJ1hdV7FRWvKbvbpacU5hmstrlzkQzVowXFNRxXdhVkU6EsvipqGTUMbfdELfxvM5D/DILCuUZfd//3xrhS4KsVo0SRQJ9U8qdTYU/sF8/ZX7xGkCoEZ1CocJICoLC5opvJi71Urai8lfuWN9WBcOKf0tVTMeimwBkFsuaHdeqxnp7F/RU1uf+dG62SUY/+F6xBk+iH5g/rnwBbrWAh+nIF0xyRkgbiU6sKSDUQHHXkb8ysuzTmw0biDf6KOngRcuo6465gNJPqYWGLgqAL14JDpdfSI4OXrBYU0jT0PDYOBlyFFTnWIRY3KaoQZA9+1Mx9GRenqYUA9fUSFAWJhXcDgnpKvRaxvhtWhtte//BKqy6FjUS56vUBuHteUzOfsVCqt01myL84MAvNEka2OhkRToptknMkZeQcDgncoRGrNvH9yfuyRv4o06c5hdsr8d1Dt4D5DyMd+6VlIdRrm/xqGUmnkUq3PZf5N5Kq5XqvXkBbZKPmtV5IewOwHmuU1PY6WyURGireKYmp3G3OpTHu95rlv9cmkp0J4Uuk26MMFHxf8ra3B3J0qj5JWg2Ec4slMXuAK/jlV7rKjgfG0z0pYVPRgIBo4Iz/WyYNeVNMeeSYPrKE9DTC+wRldjTRtiUIkJv3pPnNwz4vu5kYyvpGmUA+p6eEawM+uE2JKZsw6nAURpsqL2wfGMzLuom484T5cWeeUo2NQmNX32giMV7AccA0h37PW/iiXa3jMu0refBvU2UNtDQkD/550/u6N6DUXVVZCwF5vB0bDYOKG+3nzqZ63ebBJay/ZZECqyvmnRs5/ovjcpS7uMvLQHWmWZ0n4OreAep2tUoWRkESRsfipjwp7WdIZtX3KCv2O/jENosO2m+nRtIuWyhhVM6dTW+YxvYWlVcsiiq8ceeL5zGZUqMpjPA9dMyANBmEEWK2QpKE/iyGZS5aKTClPUO+wFUiTxGkR5YkKHvYrbCgqFe13E8OrDgA17+keEki+CAdcE9v0DyRN0cT4b4PxTQUcapxLvnc07q3G2ATVuvcTcMztZT0xQ5UvUcIyMm1wKzZJrlDjqQoWn4Bfeo13jPops2Ofd15GW9Gu33QmcaBZGmyiI71F/HyddK1FMyqvhbq8KD3gVSHP44rCtFPeJjWnggSbsAsPK5wRx6cczDXJMXzf296ixgDBtvB9+PYEwKEKrbdWLExpYT4cNhAHPsjTpvBOT1nY0sr0kJrUZJmqGW7br4IzzlRKh8eLeXouF2i9sS3qdZq+Z20moN9Ytf9fk2dStnhQFnyXjpzmd2B3vQzLxNhCIk/KdHzBAA67byG9zTxIx1ScMgum1dE0q0hYU0At6NhwU6xCSFhaSLFhCkxmU6DBW1evbSGWZ3uoC2q9zZ6dUEeDTiyx2Oy/Vu4t+MFOH3XjFmaZnUrmwlw+T5lBPxZKfmwNV1jRL26qzRwmlj7Oa9sBe0W2lcLRbbXRjL02GgGIkllyBWa/NwxS4rWN/18dSfx0gI6pAsbt/LvLew91t6xqrbHEPj9F7kSxaSg7bUponzAfpDvlA9KMRoXUikOkitv5F7Bm2LSYcVZHusDPjznND4voQfCzLO+DdF9OlTQADayq1bTA/0Z4XTdB+JNYrXnCKoYOz+ob05q0oWttYwzDieAEeT28oleWWrzKL9WslOjf/A3v3mg9MZNaRnyG95b3N/vUAUc6ITsXpzoDvEyvsIB7UeWBlCYVPsR8CtwD3AZIsH7g0nu5bKcrLVGfythBV3Q5ctRFSQraiHMsJO77ldsfoOyY6DdjBi3N3oOVTDn8VZAKqJHj4Aexb1fuhUvwnV9A1VJW3iLMEmToKzy5gmVkMnsLwv0Wjb1knn6zSRSIn7kpKXq9b20Dgfc2DoYvQHibayJCpJC3+YbNI5QyDd0Lv6jMAswiKFTwEiV7ZJpMaA18qgCYfbW9txIHZ+YQYukCfvDxcPm3KAP7qfWmhMIBVULegpA/E/53m0X3hb8dTqK+Dxi4Sz0In8dxRjSj9xMqUzTO4hRaRqgIMBXiiuyjNrBtXcSC2O6CHPsUFPDN0lRdNEbCFLxw4tYVXClx5aneiILPviMffikryfT5Xbx+YNkUsDAy8VeJntwysgKbWJVQGjZlrovTHliubJ2n31VLJhHFS4XemqxMRlnjWgRY3902gE3qAKP1IQkaqRzlXIEnB/1DnfSrfAUnEdGdTAbWHgSxAiN4pi38Jb3ho8FE3ESUcgoqZqbXCwXX+NPvWBBddTSd8ltP6o05kF/DNXKy9q15ZHbe/CI/hzRloAj4BqovYrpbDxOT6SWa2VBMZw3Y+OWLOgbuaj+pJWcAezOL7LaSteHRY7Rm4w+vioXtQ60/ep90AX9xZi5QXlTdCrHVk8N549qDkXztwgzVDmLrLQK1glF2gCuV6x5km3r/3sSAFzzYkkKpiYOnLbabVWR7UaBdw4WKB3FAzeYbhe4oFDoQ+KHWmIv6a18po47GLqkNN8Dz9rRbGa7MyqJuWG/u7pE+jLXNqLleIlpRJgQeMlw90SQ1zoYRwaWtWU4r6Q+wQTsoKROultZgjHvwogLxRhpJLbaaadc2LIGyaTn6fBC6AzjEjQEuhTm6wjuyJqwG1S7jIe//aUsCsgxw+MUE5rmTkjgd6bcnA5IFli7LRPjPOWtjIY8dluT0l+49oGpKKC3I6VeoJguZTsNBoxYVfwu2VDFpBTp82EZ5g6ikpnckgwVtQsHWKXpQclSMe+OxkxePSvaL5inVi5mUr7qBNYKgyyvYAeBPSAL/NjkXMMXXFPRRA6v5TNtpX783hNq63P5Uyh0+GWD8nGaWKNXIV860cxeBjMWefCfCAg2rJHND17ElYOh8stCzuS5ucawCjXHI1ynJrcqrX30seo2LrkVzkDgVHW5hAo5799NnC9jwhq0ZQlZLIQ9stgarRCLqDzzpSA+uR9q2v4FWw7lxEizrlRmrJ5jWORDDpOqZtu9ctkpcJDLLl5Gb7OglU6oYtK7aGL5De1BTqkOhidGU3odHQW09sz6msLzg3wwgr4IcgnmGseCXmFhuRRN/FtlLDU+xUc/NbdAohu2N8pe7Msr59Lk99GtPzc/Zgurb+1D63SehTwHuv2Om4EZzHzUG+psft+fd3o1FmAcsolZpOMWL1RCp+jV+bDRKZFPP46QkSJyQ3kCslO3dFwOipDAb1YjzrUHsY/xGD9vdslpScpjn3VlX2KxKZRtmSJme4tEuFCjfB+v66kOEqrlpR6nRGHoQTKKXutPF7l0Mko4YhDEPwx4PnyRtwAm7wAMt/WCvCUgpXQO4EBpzCDQv7lLOAYZD4e/p6UmypbDnv5XelhmNT0cQaihxfE+s4FjNm3nJf+olrzj2TA/7LN5bxI46zu86MzgpbHeGw0RPHNzJfbmO+XwbtkorZZ3eIerI+BEGMo2NVdhDpNa23FPdcxigeuLRsEXW56cjucMjKkLfH7iMfuSTZc8JDjll9fCK2xO1chVOKIy9LPVqBBGfEO51+lLUoDXfMv1sTbwuHtYPjllxiVMWckfHvXz2kYPk53ksB0DJVMa67tc6tC8o32WOCkWYqy5AXIxIq7eUgHcvQRFeF/wwvJuvFU6cB8JH8NaSc9RB1Tibrfx8T9WPJwtOUQ0w4Ok3Jl5f8mgOa7e4cdN0gAWBJe5h8QwnuyIV9Lmsh9k95pXlEiDVbitZev+CJUmQviksCtlHOj5zGcU/jlb2LG4lwhgDT1FinSkEKqyUiTF/1Ct2q1ZXlRrXkRtMIoHM45kXLaU+pK/sTeDuXXdSIzaIe4NZYA1m3SXVuujd8K5IvyrDyU3beVhHajtZA1oPyux065az6ZynmMXVNEXTWwKNLdHW9WQpq03TdjNJo4I5TJzCvSjpZxwk7rqn4dWVU6YTZWYtINSbqjOHVpmVVtnXH5ajaeMtUz72Gl1guBADlOkQ90cevYluKjBsmxs81fU/2UiWHGuJF3G24ji+PGZPYJbJmm8VGcOVFnGmXcXOGdiOT2kTquNNi105wyVPLglolp8GK8gquJbKQb1AknKFeR7sMp0TkPmNLXwUE/VL7B98kleqjw6UpbmWqYaTrVfEpvmYBs3wdZQJQiKoF7UBtQE2PdTQqKfp44KXrFVQRyfi07QWSGV23HjOj+uHAgr6LbGl1pRPJGAumT+h1FdlO6HLQBiyCBmNszRZCqyI/5iXrN56BYppqAxHPYBw+SUzAP5hnfCYcmFX+q8vTtMehn/r7qgm/dwVfHbH1hOshSDj+sRLmIl9JnhHkzxeOS4qseGlAHFCZQCjS5JvMnM+YBbx9UFpGGes5PAmXxq42H6usTVxnAp0+RUOp82zErmkgr7R9dXO8EVHMbib0cwDU2P2PBX2j2D7B1AnBGcUkwQGiwUaU6L7LImA/IV0Al8n+Mm5gUlyXaofvCqGzqyZSvbl9H1QnZ7eC6Jdmq+AxT1a7CyB6VyVf4aQ+zd+zeVtUgyLV0XSjpFvsYc/LS1o+9eE7jAal7+44xjiGFA4qDBe/MC20kk7BD7TFaOwcDmOOcMb6m4KH18b7z9koo4tiMnYi7EZCryfI3m9TGZgypsSlUZ7QTc5jG+eB1Q9S0P4HDROeKlxJF0pelEiJ0HyuAVHIpCeFNnWq3vHZFggJHJs9DqzTRua/HBxh/UZ8b+/lC3AqV0J2oJXoD3eMTogg7ck4SBx4eUh5vW8oJ9Hgtv8L2Jd7v2n/9cRXGJH1tzBj5FiOrSeI0q16/nPDZxyLNxSQDA8X7hVSZHdmMsX90I4ZNCfdkQRtqEIKglnoNjo2AvLuk0bcL2FDzBjb1mDGLtYw3u9hIvv04xP9Rh4wY1Wnr+EuHSgwdtA4oMqZvniEFglMeuHo/9fsHguZQR21sy15ADTsLGHYBr0JA2IEAm4ltF8iLPatjSGI97vylqdQR6O+/uv7DO3SP1SMxWk610tUG249Nagnn9UaOl03LpG6QSP92w6HWLIhjUhqsoTSmYJJr8FpAZEWRpNQGM3ORO3U1rximM3ow5xHb51WLKS5l3U9xK4/OywVIsqY07MQeIRlx8BxoAC9mMJTit0rC14R+83oLKcaxHU4Xr+8qGuScCSk8R8w3Ghf9jLDxDy8RzZCZQ+s3UvH2tpk4OYMP86mVoLJCQX0GL2g58FyWSQfQzSDlsxE0wNR4dNRbyJUD2XtbLSHb0yAqgpy1+jFnmlOEBYZ7p3W7NxPM/aD+1Fo3H7zoiBJMgSbxJ7YGlilIw3OANHlbPcpSHXGv0Uba4SoNZXAJb6E7lzZlZbzOE3zMC4rHW8mB7mULhZGVP4c4VCPVrM9JiUqtHGcBD8xdUEFHXZ2Y8FoGYHYH+z56MSbEA+81R8MHtN+QhBRg0ugqncXIYZBwnH7qAx29cflEpBwXkBH+k9Uf6A9t0vc94FtbAf7pL6RgjN1spx4RpiP4fP5LVlSTji8aAoT2SzSdfds9D5T0TcsNfSF2B9s/r+Ndivtgsqk7hg6By4r3DUs0U/R0RN5feMZJhfOaaHbcU8hHtLUtEGBKXuatJjmNmzGaQU0JTL45wZFuw2b5bHRyAa63dIqQAPYaOCB+rlzJa7LT9OKs0lxiqst93DVQlm97KHgUIB1/WiXZRkyhTMqENo9iovrUj7KcNOrreSGO/OuLJB+6UvVBe1cPOm/6SSsuBnQt9we9AGbHG8E6H5W+fJAoqdNPsbb99pY3j6VvC4wv3SAuJNJ7Vt+qP9EdYk0xtIEcf1nDAq+pYdohAz3GxzvVW+qYU9sn+q3e9wwZzttEAxZq4Zq3LFyExvIbeLv3dKyYzlVArxgNhRjIjtG0S0KsNjMck8LNJtRaCVxN36mQV+wyDt78JTjXUfHBpw7ZF+LBjmXGQ6cN3sMxZ89tY+EhO3HqA+IvK46Lpnq0t9vUCiHKTTJQsR1uyn7yHuosq+eDpPODi1EqGcXGtGjb6wZ97eVBderOaPrqMl9OFP4vM6iOCegP8djFVfRhOnrHZe9Jh1IWZUFx0nzASPDE/ROSlMwjiBiRMJNOQUQl03uSm/pGZ9wwlK9hVXd6Q0ASSdTYwD9sXg/TTCKcENhCmm2YAmiUpYjlh7cpwL7Mc02+oGTEZgiDDuiOzwvfODMjIskjvnCHMd2UxzKVEOwqDC0MgW7dE0UMT1vqeWCcVO9TEEJOncfeanWkqKrYUlb2U1XJaT/rtQTIftI6H1a5KXaUkcj14ij1BK9DIa+mcC3/Zid5Pn/2qszfPGwFyxE9NiI5BqnRy0rq5gIfxVdzfE38TOEKliHXXJOELo9KVqyo/JmmsZeZ6clxHd+ryWBHX/tK/aPS0XfH+OKShzZUTZvnaVmtRGrVFRdKWCy2c9lL9vZQgXPAoOzbLsTAQqu1sAtrSlmJKkpj5ZW8lpFRhZFZsUDk9FAOGbADujRsdeBln8gqAijueIgZEtSxhjsTuref12IHeecDdjcjhS499NYoKYTt6kUXr+92xgbBX66Um3Kp2SIxjnVz4r8O72Ch8UzLFVfqrpVehPYtPMtABhJPRVk1boFh3/8hEdU3wH+VISqOJInxj22Y7gFFXlHcXEkM0GsTAGY1QnKCbCE0g2hNu0fxBTmVlg85XFY6JKPeCWluytY7YnLRUN3cdMKNa+jhIShGdK+13waMI4TS1wkKhlpX9b2XyS1ztaFPAioajncP6TvEQibueYwT0eJkbBFij3nI5b58IGqtIvJiFhhyISzQYSABuXpY0QrrSn//Ns585h91naYUXzjr/h+wRkgesN6rlpne9yUtnUIX3u6JLoJ3CL/dw4t3ZlKH742X5h9jtzFUFp6ycWaJOxGQh/z+c7KgUemGOtRdKo/HYy0VXwsyuIk73+MobGODnm/nPLVePcldKBc3O+fmSVw0N6+7duyFpvbkezvDU0A6oF4weM+ltJ2orYrn8AM+RTT/Hy/mUtahShjPlFH9tbvsPxvJNcPVcpGO1/ECcj4E7C5Oa4lYii6SpsNriecFcI28jRZ4dvs6ix7WKk3ZAzFhK0vMG7wzVFZnpfmezxlhEC5Gn/hgYy6gFAt0YiX4taMmiN6OSisW7DQDc64VikNgNBLEegeoZT6o9QXuQeiy3bgz8p+WgqAnq9u+uqql88JmJiu7SjNkCgdtBR+KO/geKFn5BABRHhkHfbRFmU0ADwwg7n5rKfpN05Vv51dFg1D7KDiytHwabjd9WEQpiJefM7WX6gKnYjD8TkymLuBKZKoEOufez+MoP3b5MP9NshOQTdHhPsOGpQ0piC7BilJOTb2NroasXT5MekvsOiXslKcqqpqFDWzdBEGvuktUDrMkn+OhxE/RM3+W4enRAibmd/fbujP7OKoZFgEJVWsb31niaRV7xc1UZHehhngLq7+X/mNTK8N5oaZr9Gk+46GKe64LmI4GsmlRFJGIMMgsOhOqlC2AeMEtdbsvPlYRSsyeWjWdcauu8GdHbeC1VP91ytIEed9sAU+90Ax+bunb+UgsYaV7qV9mc46/ER6RwX7jaRTCkBySLRkWkkz6WrVoXlsXqB43JiwWjZBM3HvJ+fzDTOoj80vRCQgYgbNdoklXk29DkNoWg8nHkHwNiDBupFbebgzru3ODrmXSVtnKPwtuJN3/8d2eLm3UgJzWuyAWxXxzv9pHPj3Cc1rESX3vbu1s9XV1uoflkLoHGlJvylnhQ3Ai5wByQxSNIiEX5ich2B5mgpItmr40kZud7wdF6Cri+F3NbI0aTYYtp2FWikO/iZBAfnt1mRGIBFRHcta7+Zp4UcC3m465siYVzG8UX72dKPSY6eu1v5kE1I917E3qa2aSqeQasV2HU+la9GpXj6Djakzzg1JZCV1LjvIh5JKTMEngEl6p0Ki8B1oh0E15z7ofWqPH7bljaLBNoDxMJInKSo5/eFTXihqsNtP6mQoBQZIx0CM+tG+qXPwHqeWP8NxBHOIquEbXv+bEDgVbte+Ti50z1eoZqX5c+Q1Qkblfn+gW6m2rqD93N+9+W3hZME6X9xj9OAmlb5A/u9FeUVl2itvEo617qi+2OmnoSNYqv0Yc4R6lHRFHDlmdSAq8p8TL2QpadiDnqUs5SIpGlkbmswWBIOrr0irAc79tqhzDLKKBN8AAAc2u0LZ51067xhbqDSIJ5/RGgC7M0upgGvbfBXkk0s9TUbmDbuwk7k0gkWoFnLatUfIni1RT4RYisMxzJNzAUohg10nvcToOsnAnrebs9fVq/zis54kHXRvEX7jr1spz8naDdrtcVn8bno5B3T2JqBEdbICXRsUYlvLYynAZF9cHw+22fMoxlhT29AzPnEKweuQ3YSLiGdxfnUtsGDCl9FyQ4eZTlwuhbYdtkpcbJ4s8G+sAw9LE8uaIb02QATu6sroqYOz1eYvsqGqhgH8rufgieMeIhR4t4sGPNTezmLRmOeowuIDaqrp0NKglAma5nLinhlCBXAnMQh+qct8pHyEhyxCYlk6oXPI3Mld9W/E++9ed7kCKbXe6MDkWyk1WTXbgDRBnDsGbLVHx0rdevnisCndGRsz9xZbkqppwpi61wUjJgEjamTfQR6NP9TlFMh7nj330wuAkVYKkRc3Kd3TFjx5uzykXUut+7Gxdw5RIKy6o508p5iyR2eGNfbCgYD5uscnv6AXftzSf2+fzZ0I6/o38/SMFQsp1n0xRvvZPTiMg2DrjmWeJxSb8e/McvB4BbqQGIlqWBzoxU8lCH+U+x7nEp2K+/3dCVEYzdmew93OwM2uWnsovecxsuQS3WVm2ljwfrqiiIT5nqphbsn9dWVhIh/lhF0HfwM1a3vFrtPPCKeL+AIhV7TRlECk/GoMJQDegADGQFsAPVpZzq0I4t33rWhEuplIFBHclr+wmyPzV45Ub9Ql8cj9SRomr43ADe1Ew5+mCBCXzFR696jncsR+oYviAu9i2iECl2NfGh3i5MAvmcniuhtqDJR01c40OuaqWbDQ+BfJIhgv92jBqeFM4r0T5Tlgi+znkm4S5p7KboVWbYKBj2GGAixXl+m9FShaZsNEdCtG2yvRfyQuaZYXjJT2LBdqdYpgdY7hJ7mSifNGqzZYSr2GVS9rkf8KUz7EgE8UBnNLAcBFQ18TL4FPsyXkcyYX15/1upW9jMuWHysp9ZWz3LRTI6vJ5X8Ch6uTsHEydtDNHKO57vtMEC35pQexIvyD1JGiavV/IW9dnvhYmTKlIaGPjJG0y0XZhJRjGsjUXzZSgBlwhlyRWh68ehFlDdt4coGTYEeaYS96vJG/ZPstMasT3iJWwCttGnCkqm12jE+wZ+1+A4Xhzuxguonjc8kBfLX4kc0BWiV0FJ4j+StmtJ9O6ek3ScPwjmhYFeHgI3A45e/SxNsBsZxhLOBcDbC50gX8MS5fcKyatV7cnIJLBSarAAiAkvkS5Q1ANKN3lQOA+evdwujLKGjgBhQqI8XFEouAsQPM5Ge1UVacSuFQhvnRC4Kidpsj/uDr0crGBrc1768zxKC6p3UaAE5KLQesagBDQXNboXvUc3TvXIfI3q0X8zE4d3SKArQQwFOEPvNKwXw5EAMEW0nPyfUM6GGaZUQW0jRngUS1meKmc4OdRyHyGJeG298NnpmynbFltFvi73Hy7xduCr/gEijVVXoc5E0AGiLQ8zS5rsk60CHzpReblNDx42O8zcNCMXvk0ij5piVXNRMZYMqavnzaUB9LOdxQ7IPydDobYgdYHX442GPLf75ddvatufsOGT6hKwA0wFqq/Eyq6WSJWtyDkqTmL6HDStLg9u2sn6eagbz4tDvbz0AEwQdRCU42xkvUTqcgYtr9dKTbol6SCKPJ9UALPUAY3+4W8uG5OtGHPYu9T7Cm1a58Qih+tzd/oKQn+yAAAp+U94sg5BIkZ2ESTTfesb3CaWhbg70psY+ae30/HCzNebn89yUu2twAaj9g/oXMaZTUkQUE6Xz/Rg35waPiwclg7yVTXfOXArC02loFzfZBp7TffHrou13DE4N7CQnqS+RhBbzh/7QDOopGT8PLDFd05QCLvVOAenw5Ry5UsEGzHm8a7DG8rwcC+dr5a1TPaYutgxyTqk/uTtN4WcOx8TaIKPYZ6o/4vul92O/F+uullyUjT1Bf3lz9WCzAzMDYGieb8XTUwyVgA9vt2qsQK1ujXxpTEcWkrbq9C42DgzP6448lbps3y0YMV9nqFUaf51IYBxUpz/OSkeB8rLEM1YgLRYdy4iO4m2j3b578uhktgd5jIezDAcdyYn1Eig21M1hr16EYG61peUgoLn/3ZUYNQMp0shHZnfnW2Aj1j/EeyQsez/03QUtP33EocjKxyxh3ZNP2e4ivM0OD4ILl0nvJTYlf6PptUud+JQHN3BFaBcppQ+Iz/1o1mxmFYV1b59UyXhcdBIakoAx9IgO9ARoHnhnxHVDh3h+5qRvt3iEH73ihQIZNUDFZ5eRw7IuATaUCObR3qbbpOHsGE15/YZvlaVcbQF0n6B04/UQUVzA6asRHwD1DF62vF47fkkdrdl7kZFXXB9jKU4oNzksPzlt51aZNGCv6M/K0lq68NXvWj1+Cz5//uW9NN8sGqb1aRFs1YHa2MQv0JjpxHH5cLzwpRcPBwaWkhLyCNtarMtamgssM3yETHOVxFEE28UEEEwrf5Cm8ECzJqZa+wOkVOGkiHjP0j5hMcX+lQTzSiU7qdF+qh793HbOaKiGD5JUx0nAPxubv7/htn+65w8gx6e4nAlvn0+RINcIQl9bkfSPkmCdCqAaIMTzs+s5jMyUasnN9ADgZcewczH2e1eh8u9DIdT4USERTEl8901EkdLXAvx+5GaP/baH10FMYZi0FP8N/6tZzqQusuAH3FWZib6OiRhYyu2eC8f7w/xO5GGVWxK6bP2VbqTzJFEYEEyvg+3Rpwy8Oseh40nAq+PR+J+p2aYirKdbwbBcB+nMYk4knqv+8K97fYOch3vgoSSgmaf3gg0YVMOEkG2pfd9Xunzd27Im/Rj9zDmHfZJl6m1UDd9PRp4gGSAOt7o/0f0k9M1qwMfS2bI9gOapMu67Ih8SDIRJtF/hcVkblN0GTqaV/ZNRdfCy6Voe9eVAGy2ao2/LyxQDC+o4thmNytavnMnhn0oWUQLcyIkaY7VRbiH7Fb3tUyBb0N7t3AsCdbbKt4LRkTwcA6dpwLNNbxp5lj4bj5/Zw0U5xJMzAjSHyzyjJd3s4FmSJgiO+8PgwbyCUhS1rBIL4mxjYvKtJWTokKSYVMAkzUreNn5qQZ5WOGQmQ44b00Fk5ObBVLEBbTdc78ESbAp8IlorPL9UBnOScOLUZjOzK++7czJVcpLoby0KO8cuAoAm6hTpSP7hZ9tQlMyr0Eff1cv6/uAA4kpwWu69T+EdEnPwii085zdhItp3dx0ja/JibXm5DEeHhIcZf6TaHO0WaPpgG7dFg/2AodYq1Ef6mEDhWoQ6bsm44nbKQOlZvQj2+slwgAAAQBGhR2elpPxqkAXNPbE4lKx3902gE3qAEz9Iw8+alH/w07NV7YgmDRtKopkQMV/rVp3aOr5xt3VNYgWFsoPW+x/jIVxklPhzI0HeNr8/PozZlTYWuReeeHkhj9uAg8rIRs7ks1xt1GhDXiPO4rU4UHMFRgxriuwAAa2m5doWUmLDLZ3TBLAybwBzXASRnE+8F7A/df+Jmc4LZcikSX1mENYe2PsjoCwbj/EVL4Kss8T/XcEkdNvkmt+DeAPa9PPGWoXaoVFvYghqzwx7G+nE7tj7UZEEk0A6kTdKCZq0XwmviIDeUmxTPAhXSvMJ57BBZ7m2xh5DscW+54j6Q5jKfJuWhIH9W4NNAo8QDH9y/iA48iLW4CIr30VSPaUEEFMGuRyUHH8gty1qrmWYPQQKAH9KkO7TZGkuTU0TiE7b8aQmxeBUqyJhAUxpCqu+C+V5HWN9ns0iz7aAuS5jtdhOWHtK8EYq7y9az9DreABzwflpptQVkTetEtmnaRfSl1rA0lm06Cz1NWoXA4l62LbUI7EVmSnB6ojE1gnSO+7A8aSjFaLY5viAPSGXzN33hayuJ4nmSBIn4UMIPuViojdNwIANzJ1oZaBjUE7aAC2OpQu7SKTIK8mK4eqo8EKJX42PcgDCc0adXHJcN38utxMjTwzLi4KFw9l8zonqNyWNmc9QDCXgXUzHafqcdx35BpoinyFMZ7VqqEY5/4yBZBtXAMdJ/AvrQR93Q3gQNihrG3KM8ShMn9jRkA9+z8+5J2FKgG4JFoW8pSjZuZ7tbPutsBxDhA5BZBSg2Vhu1ZuauYmXHwwYabdbTdxXykGecgV4Fbehbe+XrIZ7zGt55Fqofb36/BCk6J4WdmWkvWG1k3ySHOGTRLUfeOJ7bAYU9MueAzmSWDFbmk4/GZbDq03V2v4QwLSctuRht2ZsBmt4YgqGHqtSiIlHGSEB1q/8N8mWRwCV5Zxm0W6v/DOYumuT4pPk0SDjCsQ+6C524CXuO0M4Od/nM9edVaRwqzcb+6+dUYeiok2UzDI4THy8w3uJMKVOk8efffpZhcAmfXe5ZbZkUVZnDEMDTsSChyybVBcU6wF91nVXU8Xjxu/vOxCg9TT0lGfZ7usbFrD2lceU+FTzStQl9OkJnWlecrzuVLhmOX+hYDtHmWEJnCTJR20pzEMBiFz3ML8j9DavN3uGY5W8vEXJtV9B6hHcgzdBX80t0g/THeB2j0CyN0gPTh3XrVzHbwfBBhlVB+PmWOefXatbBLU9s6FOZ9z9DAkxUiBE6Za25lSpR4i1mhjAV/3lZU63ExS1j4/9V1Mp6fGjPb0gpInu4pUpchsll386ZWOboi0CllzCextaIAIhP9bY9Gr3bAk32axP30QHXVQ0YDG8sPhXot0c1q7RGKjb1xAz81j+zb1OifFCbI9bzbR5OXVNexfdqdvUjnje5phFXvv7EDsdBl0XEpSsuJ2mTOd3Rfi8bzeKHIg36HIBp5N4+w/1nmsVwAADyir7HL2GJxL9xXAWhB5HEfLXOzKKyh1UGYuK/Y5C+iLXJRNigpxNwdr6j+ahkwLMpVV2tI0lOyjRMYpEvlpULMbaYK5AOVKkzpW5ok3kAgPvc+uGKfcb1rCBbFfxoNeUyZDIRJJ/phYu8khw/mgTC6cW5jRWA5wlv4dKMtNUFYsilmsK75zaAyFjao81YbbnUQP1wzbRZOO6VF7R3J2IGEWDZE/Xh4hd0W56x/BHLc/+QYK+E4R30t8ZKPdDvnLeLiRtl7pSNvvuEyFzZp7ydeAglSK4DZkaOrIlBfHo1REN9NaZm1RYvrK1FFAceFzFi4dx85Gt+QLLP8DxRwehlSJGDgNQk5mFveGCLvjxILEyUo1LfbotT/oQ8niWCQiQ6wHzxY2KSIU8C3ZBqCr1w9LQExXUFHenGGuur7rF1fFhtxdAvn1NNx1V2y4aCBWS0hWcQi6lYhsFAHy48qtUmb0HUO7NpEG8tkXhjCOKvr07q286trY/i2x+msJ3+ERCt88dod241YaNcRoBM6iLTlJvRWuchU7i81mmVfYaXXb9ietUNyhfhJhTwzfM5mmx5pcSz1Ps3D5Hx0KXipoIbKgMPW4XH3+ssE8E/uOqJcSd7OBKsMl8rtwpTZy5CM32cTbMwpHd2DoYbW7cPyeDUMir17KDoL/WHEFdDmDn4eWypEC1KaR7Xmq8ma6APWdAD1L+lJCRBHCmgufA2y+TRUztN6lYc2y8eGy02+xBMP0II21h6Raoe2LydyhJvakQOxcydjESwynDWp2fBvYNwXZLOmO2vfN0AzB7QTDcjXCefVQgoskoxRkqpzQOrRoOfQ/WhwOIIm5xoyWdikybCm/NTTNAH2FLpt57gOx0bxZbpUim+MpFGR1MPFxKNcvdTHevmB927i0510vz5BfNFiTeeK/AmaVMWbS9hPgnSxYkfmZmHBtZCqPTrCIK2eg6U6dJV5vykFqCSWjkpzcoxvrxx9TOa96MgJmNXNTt56VDTbEquoeXFhp1vulieMqhhaSzLUSm7f2Hja1r6f9FTUUCyC//rW3RzN45EkhAmGysNviB0UhCKp4j/bxH2LNYeYXneG0t3B2R2a+0gH4zmtdbfEX1USambfZXwX5yb7dCChgrTp114tvO+7xlf75FTOga+GoW/9zazopSxLbPqFDU/P0hM5tWMUopx+LBvLw2bqgd4pAFD85//AFVUCQnG6WfiQKoLxnapuI8tlmrUg81pSyJ1pVtowrgAYBpMqtwBv1yj8H3VmzJkCW3xvnxhA+EkZUMdWuh1ebCMScpTkeycbuoijkCxGM5jyqXq0Tv9lIFeGD7f3+wbDuaduurOowteqVFbEOF11NK5QiEwXaTKgVacQJYMJp7nyiELQQay5iFi2I2d6Qi9p1+2s5OQzTlfeGNT/Ixpw/gdmbSJssXFMY8cTXNFqOpDdJRIfTF5dhme7CatM5dP1L0vbHDkqz65Fzvta57sBPCVG/zW1tfBc9+Pj/HMKwhf1mHHRnWnoBaCWb8HhPi4fVha+zu6ZNHRs7fsoqwUnhfo87GsZygKayxUYwYTyjxxqu6U5dWbMro5vVRi4aYfE+2ccowKJe/Ap2oI6uonHZ92++VQn79dGrgbShGbI29RHxDEMq5p8XiXW5iOMm53WZs8YEvk1JLTbd6Ph5lumObeMF+MPHwPbC8uMg6ZI9lYEyyvxB7oCPJFe2qECMaPaGO2WSxe9cvptf1aUhzLbBgl1ASXHEhZQVVCHkGQatdhLzi7AX+fuPAcl9T+BT12KFcY+BT9t2hd4I8SUONxjD0OfL/q9LnRilKCZqpnUMiUNF0DsTtziHjVdeyBREfJMSF5WISEFQ8Mjc9OZtFwN11hJ5SuTslPIad8aEBEsQ9W9GW49uXg9G1wjnHnJ5JJSQA12pKND8FJYmegGwrgAApD6QSPkZrmKN8LiPvPeIhgFQceWHwhjH9ra3KzqmZLd5N9tNvd1gyP3a+k8mrndQRbq6ixRtpUcPXB3S7IQ8ysLphSISuk/EByacCpAyNlNgRgjrkiNoP5AF4PmDYH4B+a8/RvQRVAA7nKo3jn+E2sy+AKU5LPZbHp3xQu80AzzTj9D+HZlFjFt3Usn97RE9WKKYsvC9s5cU0kt0+r7ndviV1uyvjSGsVv/29tQmvZRgNUO87C+qiHs1RTvQoFBhqXtZxQ0wcAhHQdLQa6nZ443Kt65iI13BKek7wodtEYvTJNEwQg9fFQde8f1YTbWPeRK0ACNnHHH88AJDziAS37FWvLBBJmYweZfWP7r6JzSu9WMhAIglcp0t7AKzPswGtF+rgtrqJZ8TeS+Sivvw8kawrkTaRLTGDAOuJOdXTVHOGkcN3g0Gxj1UZy+aqtdbNXF23JNubxzIhcXX75Kj3W+r34smblGwH5hRvmqvsOLaybpLy0CzBzr4YpjK0iaM+xRzgf59Hw6x1mfCaAIIMmO9o6/8nXBpgYR1pe8i44zIiEXYvDBmC5aKEQNM5UkyHpGgWFBHsRFdqmDOEYtRVlk7LiUgSddYSIaMDyCMXi2O5j4BVMog3z7X+OdVUMlnXz25//xJyoIemU2q8nUtWn3O0zktLUa69dxb3kQYKwLM3gaam49M4leWGB35INj6DcN1EVpM8VJdF332x7Uhrg5vHSaZboO47rP7A0eGFtiNrAHmRzIW/RHvJ5FYxp7u2ifRYp86JejkPRlEPlMf4FzPwSCo+1ZgKnohT+KABsA7WOfr2ANuNY3OQnCEKEcSL7CzGF2JuAs6w1IgErSj8MEh4E2BTTTcp4pbqarXnwAS9l1kzu4QZu4WR1zWrPstgKc9A/RLRAO5jOkBzlExS8EORS5cj4syFWm8R33PSdOSh4AZunJtjpcT+oh+KXCigLWsgR+iEP7OVawbkzG6ZT0lnAaNDSrpJIJVVxsD2J7IABthKLrGTAnDqfIyoTu9LIpDAVse60DB3sg1v34JJEmceYHr0I5yku5iphZYOX3/rKYtjBAFdoS3gsAb43zE++pcQqi2v0Z89mr/sUUGiTBBADeS+T1lcyrUVSVnLJK/2KUrpJ6de8AQEqxVR6X8r3+CBYS8W23QZDUKMoEmZ59KtmrxKtZVb2alDLaUtV8d+1GJfftpXKxe9szHT3YIKdZs7tTApbT3njAxCqEJHjKWdxtvjltkg+bsQYId5IA41+cgMc2eWzEnFgVRJZk9DWtznapR1Pmt3fU8u6yLDeNUrKODm5g1uCkrMjnmITjgtLS8dHokXszyMZttcqiII05IV1N9m22DLhZzhiS30HVz33cIN7mYXSKQeL0FH7ESbTH6Jba7v9ZDlouxkZEXcWhdVARTa/AZRqQYFqzel/LubXGAOUCFdEGZAPvBCJOvMQdoAjAnhaavmaPm6psCZ6Eygy1y99c0x84azl371D6Akgc8zySSjiUyYYM+zjOjkdHPHXH14AAMHPm8zQKW/mZskxhxcBXQt7p7Zlc7CF10dLN2RenqnT4w8fLXDkZiBfIitE+Plvh4akYt4N/lcHvVT+/am6+u+RP+BALl+Z4Cqx7K9teC8fOWAxLhs2tONOjBg31WvlEWAdWn3H0VXKSeNzW4W6wS1NlEvSsD+ytcqU7vw8seUzgjCY8FXGsxIqV4S/UpClfaXCdJ2tMGJFE1JxLY6AVFjgK360qYOhZMw5KIgw7fRf/pDavUWcH1cd9yjsR0gYs0hPjAaSdiGaCWd2AOhktXhhNelZ4B8SyItccMhYYeIKSpkXQ3IRy5YynBy2J3bgog4GZlj348Tj9W+h5TpCjvvmud3HNO9N5x8eBWEv8SVuwDpSuf0a6KkhHxaGRBnQvIAYp0zXNfXCqOb1Uw2wdCT1jwCfsD2NSIMHufjSlYdV9rLfQMYyWNyctUt2I6m60cWNsxai/se+QroNIPsRYvVQMT4U02a2x/fUEbD9Vvvn88FRYqKdYKzd+3G76cSnZNF21FHQRTJ9xMUqsXJ0obmqzxvhyvHNzYoxgho0N1wQ79mN1Ie9X6qnSJiU1LNhsGP0YG9tYrl24NrlxCK9bAgZSCMf96fu+5K6R3No1zDzWYQkH0fee+k+fZWoHF92E/vaS1yULhbzFZ+9ryI60mjHhkgpowIrWt1vy3nd4O1dZfxn1XE7pJDXfzqCXT5qFwcZT/fY6kzegatDCyFfDHpx8jc5YUE1rNwuqxsAjjaFxFiFayUR05BqSqhXXfD/7PFyVo+CXKjqMPT77r8fEOTHGyKw3IjXge5ezz0ft6CymZOaSKWvCPNtJxkLscfogNnuecKLg9Yl+zl3lCv+2NPX5rMi+uNPkrkUlppS5xdOOsCEMyo6fDPei5uT0T0lLmGKjQoXolf2izIIJ4ahOMiACv8sCZx1tPQ9J4SwJUyQzgLZpVLiW1Zdx9jbXshhnX0qUTC8L0giD8vobRH8+F0q1JRM0DkWFlJK3lqNDJ/jueFIIZeA66EYXISb0PtZB8gcSl9b8QdlxXnKHsvXPWc4zkr51fmO0bQI3weSxexCfC8tvvLpZ8aXAuqfWJPecNFZFF+bAKe+fEg6uJ40sgpX9NTW3I5WOPRzdZiavC2yktthyD+Mk009WgtznV/50vPmSl33VYCZFjgSekLAf4/L4lAiiqt/c5vll6WBaEff2tA0NzSZBHTL90qzP0Glmp6Fv5wdeiJgefqRJ+bknfBYB6y4et++kXlURqm0nn5vgN73xiLDcWMGIp0uei7SxQv6JSKa6boVGJz/BktptVlQhkKEh9ASRTyypKlTfeYlnoMZMEuS8DCdX5cYF0w1Z8cIUTLxpDwgaoX3svkEjrSwjIQ/i8imRMTTQNh+nxf72k2oLOCE4aNJW0TxKOOflUZloP6DR6yZxDjRnvtYImK6FOC9wyWSPzmckRniwgQhB+jzdKkoqs76j5yqFxxcaJnXjAoP5R7CmPFQLwzmbYraaKJrJ4glWZqrqT/Rxeq+cx1NxCx2r7NgAJAScdVE9JUB/aWmjqgCRE1GNHPVwapwBYhRg7bQ2SDJgktRlQyoyWcRBLyiH3k7crS7iDEpTWliYB1ZjFrPvfVbemZ5gxz2GAmwBBgYLBuRkHvbi5Rrum9taq8nceHVGPruSJKOJFeSJanwT+zrg6SlhK5XEVfRFqtCOEUEkcSPbufl6BAAs1bA83l/sjVw4QM1lc+j5JQRMX2ViC3cuOdKvBT7z4YuDMCqtrhaWPpvZlEBP1hvlsM77S8rsLg521GieMacjR+U4adC8g001btJaYSDx9bTfAbs5JNoyLScSO8gDKOXtDQcQ/tJZo6vD/OzVdUWfFr3Ddz4MSIbzdmJvbLCTdmewNV/tf19lgASepTlmgu2xOpZUQzIPktqkQWW00O+qFnjBjc6phCvzWDqxH/OSBgYy4Dwxagzgy4qiPfNJU6XmfPk3b2kRjC0bGAH5IN9DjqG5dzLXdjthfRHU1rgA+dMAc0+Jmu/X45atj6+FxxGuZijoDxhTw5SmxqPh/wZuGfW1bW7HDHc8Pe5sTGvCnLvF41fl9zzzTPJN6q3GeUPPjWeRivKWik2on6otnrq4Rk4q1UEgi3LbxKB7vFfPy94pkjVyNNfEVfPfXLrQ0EhQ4AeZsfuGa5Fd8R1ykhCYpknS3V+mSW8m4zkspJxTB0cDRjeM+u/Zr7T0tj2gRJsSF/WUliUezh1XYOO1kGyapYCls9a1cngp/YWPU5c/+OYDdSuoqRr+WKgQyLtnrN07Uo2LmRMfg5ZBN2kXzwB/s4meIklm4thgXYw+7JnmCd35+I1mFpz99ZTHBc7V6HhGUh0VDskCSoI6HAe2Lvfc2hZ7Yyn9faxan/jcC3uLZ+fMM2gov4H9ecucVYbZMskSoNjSS9HcLQ4DsQWRGnGi6Mhje9u9s4pO3F0lKPlcE0GcBua99KrQohcVOQqryHCmrNZLXGaDyX8YwD7/Jj02GyyoRzJ+nD7gWwe2FarZmfurSc8srR83VQXA8ISDVy/NtFWNrhqWSc2VLqHwriRO56e61Ot3lBFitZJx2uJNyT54PnzpyBT6AAB56/2MZ9dJYQ9V2wtzxKv4SSnYEuJZd//lrlVQrimhnnntRPSQLZvgXCJg/28dz3yeZ4OVh6+JNeH2U+PXZKtnYFOcIe+J0WabxoWwqS91khwkU4ww627i1jjdaLSd1Fqiwxoo1h1Fqeafx6Q7iOcImJLnK5CY5yT/FyErqUE7jOKayo7mUth+NwKrX6P0FqljA6hAnzmI8ApgTVeLtsxihA4x6frCuIG9aShfZ+Xm17yWRckk/ubCpkpo3F9OwyKaeMs7zi569POT3MIZ557TzN+1CqAlGHVrg8oRa7J8I/llxdZdZRS+tZhKKXMm5M0xKB3KkytouYzvf+TFYyofXtvx4cIQASCBJCgYT+aD8i41sl1DquWXp4AC9UASImqmFALhbSFIj0Yp6NwbkK43tDW4n13LnZyKukjqiDX//I6x1p/Hg9EyQDg7WWxDBms3tDZRL6EHi1ISDWnq6K9weDcgD4/v6Oi3wu/yzrhMYVE4Tl9jQOy61QBw8Z53kfUSzYgx/6rgzVPEf3IUBMDWs5DkmutuynbmwxFCxpv2BSvcbUVGWVSKS8t/U46K8K7RzBLXQdcbcWIkAjYo4l12B42iscbzuphffl0Q9tY9IguMoH0me9qxlnZJ23pUjKiHQQ6Jzao8OVcZHLHeTN2u4i93gWfldhN6phs6KYoaRpi2EoQTKq2zrlEsRaZC96G2w8PQwNWGPQngn6fqtXmNFEuUiSCpEni3rbFs68gxxLKoY5VMFKsLp1RqF9a/QSm2CPdTs5aTjVsroZ9aH27/a/d9Y9R6H+iVtmnmTArkGOLVuSYbNzYaCwrSXGuLhyZBMAVp9bkeyIUJQCLJGYtG2iXpOE2/UfOXh/O8FKrVB7Wr2OtPemCvT8YLf/ACo537/LLTOmHGgwDX7d69Hli3D8KnLqd1Zq7ofnwaLDp/kB/2KYY24KV5ivr/qgDZ3OsIBpdUBqTW6os0ty2GMV0Y/dupIxfDWx00Ws/x3RJdVUQ1G4YcUffp0jOAJj9o3YzLjfUf9yuT0O/C/MjMErVZ9wzQQL+1XNI/mdBl1FghFcUPzq7wvszsD5kXIVkFY0uW5Ov1eGR36xUDSJnMltub605YzJfuiiJ5EzHvs1nKVkMZzKd6pSIf+GW9/VkMK/zvrGYgOFNRF+XB5E6UwuyiAenMz1nqV5qhLesvVZZ1iIYaa7uGKfkoQTrsm8ocD8jx/qoGZXqlBxe4P+LHUTyMsf+7g/xvQ5yA1BHM+lHWfb5RguURaIG3OH+Hiuf+ub7Tqquz33WPFimonni8ntU1lvsSQVtQ4o1Z6ONQg6R3MPRA1XBTYuDg/FfTd6t9Ztbc0qlhRyOj1kFT3P8LOP4xLPyNwoNF9xvjbBXL9j1jXCFSGmGfY54b1PamWsfnLJdUNvwECfzVuRrJ15RL8rmWSzgRMK/wZVI8EI2636h8/bPHE1q76yg4sNw7059uvUh93r1/ZNt+o/W9Hspza0MEvVU8RmTrYcueT538FSQWcf7O+H4JGE/qJzLe8JBUCFxGZg4GxSDGmHnJRXN6QOIX8O1rc3sm50lcYHHGPGWh/rgwcHAmPtREK50FAXN5mtzGUTgV5MbB8NpOrZPYcEkML2iGMKf4TtGV30SuuNKrk9lP99ARRNKcpwqxVqET2guVqVlpfTkb9YsyssIdf3aW8/bDMt0nYYKi4O4Y0fxELGBMbUjhpTz9nQndt47i+kuoKRjY0avgXBQHt3Kss/zfPEo3xI/Qr0+oYp3vAk9cL8c0H2f/tm/mL/2m0VvHQtst/3bgd7Ymj53nwT2xa8/owQNtpwR0pNw0TJbA3psZZISv6/5j/KkJgaW8550zbEGE1VXBNcgBd2hGDre1OAAVwdUPGNccf8TiA3CsQo6yqTG03FRFFGSgti1ouJLq5c+sikNquYtBJCBxihY1fiAJ02iBv0g2Len8mPbAu70zZ/FsysOBTJIyLWNdGokmGVlTaYFOF26gtbkC+k5PqJB7tqiKM0rzlOVf7mWFUDUJISkUO+k40UQ3qwGlxvtUfL99lCwZhm4Uzv1ciN4RKKB5GEUZZwODiChqAUuzIRiDx3Id6g9CD5dPSBwtlmYBmDik8Ws3XZ++Wze1BuIJIv9n6u2mm9nslx9jhBmyUKpgxwNrSN7HNaiuEbFCTCc2FCKRoqVmh5A2gqjuR6Zsw8GZSO40uEYh81FI/USSEJLe42uRFuoPW6NpW7P5mLBBa8IlAT+pnxHrr/OShxwgkP8ORMtgKsGtM8l9jb99UKd6MOpu+v3hv/etBpsILpQ3ZFosEUqaSMMc53z6nWHf0jFqq/+Oaz/H5NOstRFNMC+VFRpbqjIo5WOvWR+zXnStRkLPFtP81bPMm3o6liHK19vpPfNcV3CbLyhtA+ZXnC3WLbGYm+QD5C+3rX+7paXtLYrrjiNkRkxofoxZF4k0W6ZkNi4WWOlTpCP88zE8fPZJl6OkB/ye/vGRr4k9boFQWqG/S2kEyeJlcaJI1hZf8x7ZcwUgaLhjEphsSpvCub4lETbDoXHYraBOGKMMRyEWsBAYP0uG5q3csC/4jPaUwhfIB7GLy08cpdhGyd2rF5JsbgkzT61I7jKXkcpoRkHahHYVhmnQbc/iqzWAYx6R1X2djX84IkN15oLaZGlEreJZ1qn8fvmIdBrRjg/jPiMig3HvnLF2sH1q9lTkVOYVTV1K/OPnPWAS/NBCXhACVWtwjeB4s2vARdSt0FcdbYw+grII3Yo1Ie0SUJ+3zGsyjNLZZZFtBQZzVXifPYJZR1vyhTkKniGRCkY4S5H5egQ2kIu6Kor8pweiz6SMqQE3hWm9LO/7/EN8tXdwL+F4ixXz2oGlt1m5eYOpnjXm71C/iBISlF8Y/jwKuhtdsQuvOeiS28QYNlQb5DvCrd89NEklfIhMGZeFfhumUocQ3sdAO+yblTWDEtYP3Bh84H8HAaQuBsGJO3/b+1ZtT6hDRVrDPzWa1LI5dv8xMzdYelChmZyiEpdwny5OM9Mtsizm4tuiiD3qFBVrEAx3of09pqA9cPVmHP69zB61E7xY5wvrz9Hssge0yHgYuqbF2YH9FuCsusuatAMQ3R3p3uoQ9MdVWcq8k/6JfxjAV/4yJ7ymlwkTruaBfdz0ys833NdWX0z+IvD9jdphFxzmGsiE58a1DD7E7ftusuhV5wNpvQbRq02YDO9RN6lZ5hh0nPgQSoP3dcbAI2YKHiqV0LzSFkZqox+Sjlw/nN+KaFBk6gTQQmhVjBrwlYjcfIgiHLXbmOEWnyaEhib+/HGoCPlLCqcXvG3ZU0nTtOMDqYAWScmt6IDXW9JtmKlbtj0Gb461CuXC4i6GkmYqZg/MVezk8YBcJUpG2gxQWJEitsOwZwqhf/+cHJ5ecoHx5ejX8kBP1gVxjdwhAMKiz+Jai1Vybo8dq3mm62Wh7qmYMXjumRfcxv1XBMFUCNH8KU5g4g1EeXryR5kjP/iBsMx5iy3UELAPv9GdJ7KM5qDkWQ3wzXl1Dc7E4F4Nlarlf88F1I/SDjSMEoHwHH0NUPsPVOez/o9SZBVJiD1YWdVzfJSqog1Z3FJr3VqM5KMsDagf2g+qFXIkWGKSXaZeq997yksuqMP4gqEUP2PQ53xXOKjTtdrfA/IRWmf0xBFDtNEn31KZv4+CoEPc7JUg40jBJ6Uq+fvCJRccnWwiWRcdh/vgZ3We+s4bQ3F2RDME61RxaOMwwPNANgYsOG7PY8ihfblkRM0BeFjART0WPkZ3UzF91JDKvyDsggyyowXqNZIZVoRSw0iQY9jZ82etkdRoHXCZgt2DNAIDNBPJdlgyfvqF/LtL5tnHgQ0h+KtTe73gFzUdp8yndVHDRbXxYLbhJO8LqbupymHIUBzZ9yCZinN9JIkzEAEwRRH2U9+i6h1lC7dRbB/NO3F9jI2GhOmcu/h7NmFvsO011ws9//NAc35L8i2c4R1hjPS6nZ4Py+PKs5gJhPP/FHon0K/oQZZW21BI6K7MZC/z20niGSEHEuaMewPagKuR5Gspr9BLNT8u+4ci69qqn0b3P3EXwgJtPCLKy9vw9DX6K1Uc/Yd+ieuUZyWNzBjhUA3/Jh69wrOHDAcpjyF8v4gYAXIQ6bgiIWGiH+BkBC6N0Dl8IFCY2+0A9lOgpWacMSJYCR5bqUrSdkkvE+7XVkpWjQKM6b3p5rEpEvP+SLrdR0EiECdKjsaavrNGhy/wWYa4fIhwfznqPM2TswBWKCllt7c5xrmJjycQGpoOaF+NQ4ulIecWVlKxrByEXbdX01uBbL3KBx0KfJTEFtm5OvBApk95hMLrRRW2MU8Pk1tsNQbfIkRx/XnSPQlJdbH6vgUi2ly3jKvoTZIsC2UIDXrDjfeIADFbB9FBgQDEXAQFSRAAc8wZ/kfQPBAzE6G1VgbQ8f4iYcM391rQnFE5w7eCUG0c4uaqwp4KYRSz/WaSUYH5nLeUx/EE5cCXPDXAzW9UHJdqU4n0dmkCGYcwCI+uvwGxi85wU1yHXwAkDQvHki1N1c2qefC17p9wPOFx5r/NdedFgi98qxcFOD/dv69yR3zkSBfT+izLYgOVmyQrzLIRpRhHZYF6r5N3WHsFck+e37mMgES5ZX0Kp29PfshOpD+wJv/gxutPpFKEtErN3RsJkNmle60uWXhYH6pxRdPSE7vqsrn0zkx1eZ3RCNpOi7QcyvcIjYzHNwl5ZtWwPNyLpTLLk1nz5m0WFP/j/+sQPv/KKbvn4wl7WN6yqXzfPKyUrrbciE1+dDxOslhB1TtShHnt+NME73NW8+xp2WEaP6VnMKjXgt7od7m4GzMk9xrbC4qq5STLvWCh2mjv4FGpI32rHoIBal5F9iJONDC74L2tfOPcGs8jQMzCUL+xDXxZPnPDG7A2wLg/TBFgtS//FLjcsWsMxYAB7Q4i4XqrkqnxM+Gzf9m7CpP85K99eTqPXeS9NPTyqumVquPojq+6FMugX8eiVjE3pbTtrCbv6UkTUzRkx+zam37KSgAGX6TOLkpC8s2LF24oHj7L92WnL6j4FKOqG6DAlbLLbWma2JiNCYwZjmTRwkvOGuGkyEl+rYVH4OsjYVPUNzfB/m+KIG/8JWAHXmoH7LIR2kze5b2fk8UTqfqNtonM1e0nRGu2JSAkw9JqGq/Nr1lv5UDivnbDl3Ovy7TzMC78G/xLYroXMuyA2j0K/gLPYc94J+33LFuVUpB20Jvbt8yAwpNcxZbGLf/XJDJOQqN0rjwtBS7pddZ3QKst9FKoBphlnmo99jc1LNyFih7Jm1czB6xau7KaZDbnCTIhebqcWH7U8G+zfr6TQzD8m56xkKHq/U8i89xor+30cDqJjtVtkVMUgwtyQecvZjQyu8eidqrnQyc+xuauQXfFaeKESNXC/3NRA8amF3b3h8Lfiu15tiHW44M5SOjdgpl9tabnBciKDHEbFN6R2OcS/DMlE+wI8YDzrND3bgdSsNMB613qsj88ny/ThnhojlOgr9KRb4bhOHy2SS5f0yKZnP7AYLUCpykS1icErAAPjoM/376zXGUJCjnuB0t8vlcTJ5/GCC3Thgs/AKe2zz2xjokacLOCC3+thZs5Rt+dIhJBwu554eshgLoT+f1gNCdw9j14FWPolbiCZVNcFt/lofo0ElzqNqnQrKrzxM3GpVnTvBUNxh9BeLxBdMZDu8QRbn1Rda4xq/kLKS4OuJ1AQcsg6Tm0AZKVNHzFBKHbu84h3OroAR0/7EKzD1rgwduFP+vXZa1RL84/kJvinXRspZ6mlE7TUqyLz3knSKXWsl3Hu4VyPYBu4gfmg0LLSNOvuVx3KrtOOkCqunDBepYEmC71NmGMYw5wEQoapFh7EeHQ0dQWw9FObSF/FDSEDo4Q6OSYq8E+jORXeb14fxWmpCGadiwLmt3HjUjBAb4sT4DHLzVxha9XrZ8yn1kWRIp8HOsSJvTpKVNFwQtWzQMGbqTIVjYcet6yEPfos51WR+Dk3d0fzpMteimQbT5nZ4T/Cegce+flRh6CySHMCsn47tYMLkubKje8eOZqnp3QqAhZUPzhGm4hIdELTjPnRDgpZ5z+bXs5Gd6XAn8UrKWyWYXqHbP+SeIStpa/FxTlr9LOi/NnEFFRrufp4HfGvljWx40qDqk37O59VvkfuuJWeQxtvTOTdYlWfjbT2Y/8yGvUoMM/fqwuO8SREliC6XYjaArsm9WVPgGnBr8uZufFuNDHvEaJvPEA8Z4Kb9EjOYp1uErOrBP0xAt5fOUJsIOzQPG0G7h6C6ZHR4L22nmyQxoQZV26oNwgCJhkIswYoE1xRx1cQ6xnDBkUpXmxLSq8a9ByTUA87lnMlekeMsfeYdPy0We4kefPe2/cNcTiYYK7PWr+hEANFcrSg9pdIwla1nPE0wfGCaYs9lT1bpF21ukkTYbVKfPpvQB93jjmbdEmio4eF0slu4hrPXn/uf6tnOiS/cfUD0ZdpI08Y9oZ2HFiGm1POsHrpsqJkOQ1g61Ji6cYQRh52akcDFcQ3lzLPmmupBL8fxOxjtLD7+4dnoTMOYan5nXhEItIvn88YEVj952/1uFybjR+zc6pIF4PP0/pITHRpAZW4rFP5S0puSFk0MNn9tpZKTBdOaFESOcbKVzXPj2TxYtABbam6cAhC29pOu0qP7eYwvABE8VUzQusJt0cTa2qU20fC74o8rsIh0CMoi3AfpBqjgIGml6BSH0gkfIzfNlZYanxnaSPM1msku6et8eInbbKI5jOfq5kk8168ETib9wO8MGzyXHERNPxts+rZ2z+tG3aQeIFz13nLL2O/Z+OcQ9Mh7fouoXCWYKGizrV+tnX2bcvxv0Lh+DvTgfDZzAEnqiIlbyyWCxY/nxE/4jgRwkDzcjhMahzXv6aOevg0X1eeaJJUNZ0VMXzREaYL6kGqpBGjtLpmaCDH2sdtJmI3+wAGTY9RNfOWGzcabSrnkhyKTvVmDGzrcTo4L0ngd9V1ElzleQk3qtw/9FzPf2nORsJIRGeEwRadHed2MPwji60yvn4eABvFLukSzZW5ATWlFiaEIicEgVKmENaSa//7I+SBvXC3Zc/VHUBjb87l48aajWvdkig6kFShFWyRZJ9eVHK/Nl9bNgLYD2TmjjfoLusteIbs56oWkKq6J2WY08B80XYQRCHAcmPhgqscnqDbRhwVmIy7Aho/Oug5LWKjB1A9Mla0KEvJA8Yj0q0PTqcTFwSizthjFjxM1iSdtv5r00zj78e28sQDJZwaOnm82yxzxEiH6Mzc937N3GH0YdGy9hGVXottY0U9lz1JgE0fnNYnk7R2bdd/wVzMaqTNKU5i056+UFx2Irtadgu5Jy7dS3CR6UGp22KrUYtuSDu46P7Z7JBQ/qC+R9ugJKtR/InMtAynsMoRbnYeYpegyPF3OZrinACo/MHwmKRvLuAcu76c8ilrZzC43nAbr+5yMCp7aI6PlcMtL/Dfr30qSMeaIaMQXwCXZdK3zYFp9ALHYVn+eF1WBpoL4wTnwFOgnAqtFLWGuY+O30EiC5bBnXHrm42Z9WT48pzdRJoH8G2JPoLNizmKz/zPSFDEZDWz8vkxSV1+xzj9M6O4tpVm45vdoF8P06h3ANA8s8JkfoInYXuzYwFSz1mOpPTGo5MJb5nkGlDZK6OILQYKhbZMsyHo8OKrpW8Ni2D8pobBLh2l1gcNtI3/qjpaBQ21N+HKVyn0zSSIclkInxcPlblps/5QpR9FFRpR5vFnabFiNocj8tcoOVQsL6G0hBkwPrfEhS+qANIx3JroWEdJMc9CYR2FY3xp5vgR746BCyIdSV20fm94NoFBH6umNsT/OqcPnMX4G8tuSOlz4KiXVfi210ZyOeosfStRCL3UevaxaHEAJta1QkHhJCvUio812zexWPjyCMCqCFJPqqYxzvQlRDTlDvAoY31PLH+G1lR+wnJyuRMw8SiadEn9gG5N+/fqZqx3zWIb+1LyIwpGTEm1JzRbLvzuuI/GJ2hVu8t2oQy12fDhGp9IKYSrmLDiEaXB1SBQ5+4lKPvhejiOF9pILsZW4vSqLjv71bzHt819A1h4krjdu2iWekd+zUVPZlTNgdNK+BZzx/3V0K/v5w83jO96JbV3KuGEt+xEXPXTniKyTMtx7omisfE3brHUKynwTdztlS1aCKQNqpYzMTAdTjMK/cffLQCylXai16ZXK48irt0hQ4StNCXe3O/g86W+xKhpUCVMPY6BRaon9L5O74MwRbknMmDrCNXLBOZOTnn4rk2pACvdSDsSSaZ8MHfAa/rHZxNPZ0wg7B0AUnUi5nDWC+9Pk1rNNrlw9Y+Fa7//XFBeE6ruMczp1yYRXmMpIWpPgJ6jSyIdpxzIB9yxbFw5xkHfwWGpga6c7IFL45AaWq5xTBXQQhUF/mCtvcuhqBgj7thiv8hSGrJ4e2nQIsJOaS475LxrbQpWxRhYXzQduekYVBDuMGG+9ECKTf2n+yv0Y72EHRaF7uUOgCNNCEUT8rEtYrUQFKAXh/pcuExzwPUg9q71XxjN2kUISPEMbZwkAm4dCLJTB3A/sves5zr4/WG1JHZU16Lzs4O54m4dZ5GIJM0Gwf2GUMTkACURI9oEu95PkljT3KVCvaPRuctmYp5jC0Bf9tOW/53TdtWItM8IlyHrnK/ltCED+ym/mwXWkoVhWZYmrvxHQkleNCzwjVFwBNsaUtQ0hUu+arHEkgsEm4kYDyVOGwlrIkw6F4KnCZ1mY8uXiDK6actrAF2I3pYJRH0+6V+zC+HLFkObuMzhntn8ruJ+hJlMxSRGsVoUDN5dNg4K+3nKCoWxghH9PzQHmDqnqoN2F5mzUD8spnq3wY+ju4uLmmg0IZWgqk9ucrsysmz72tm3EOn2Mg+eEC+EVRUJsbUKmN7P8j6HemyDjpE1C+lhR7riU3dYtEH9Bsy7/J7W3tlkFALDQDKaFQlLUljqR9dEDoQUvYXJF6jaHbmPnG1w/gneWwyIJqNaVjR7yVjH6b60HAoUqTtPuEhhpskAuCWsINtJ1IzqEVqwAxB2sSPjbpGcz0rLFluiYuRhQgur9b3bg47iliHVrOfWHiPkgQxBmFfzHyo3LLE57sJ6EVJo+1CpmJNxr/jsABW3lkSYy+FnqnFeqPWDPnG219vR6+lRzSK1wWkDWsxV2XafL8PAsjKtcjasn25YYCpg8Z9WIECeIFkE7NSMvy3zQ4R7K9Ga7iw+XRH+gHfJo1TB8kHCesI5oUjLMMEYPkYRcHU9eyhdUOF/d0c8dbMxUTGcS8mysPNXd1ekSzLR1rXYnL8DFSH4aXG4je1rmHd5eOGT2tROCGAurnTv5YphJv/msZ23b0y9p5kIkqbyeLyn+fhZM4S9GLD0vgUo+6dPRXMU4p+ppXrn6JrbmshXO53TYNqL6cFpBOeKx3w87VsGjHL+SsVlCimGqslLinLQt+jfmxs9jltb4IS/hv3/WnSysneETFwUlcH11+dGUZPIsr2sxqSyg2g3wx9bhvJmKiqmKhsDza1M6TN/71mCiUa6q7DVBFs9FowPMKazhxPcsuarJ5jlMK/YEgWVRkPNV261GV7WynvHtgj9Q90IDHL5bBIEx2S9SbRd4Ya5rYx0b2lKlTOP+lxqm3rR9e48E+ugFZuD9nyBiimTsUHx8se5P7h2LZbsfU8ptxCsEV6byZ5hY3uPhdYnfYObWHgFIG7Vplpww5/pr+kz25clUOrBgW8Ay61+9gyq1/Xaw/RN9vU4QB7ss0UaDPEQmfgMGacz2qBr7i3Ps2O4tWOn/k/qWc9XzXWTKkbjU7dVwR3BbrUb0nUttTecZyPm0hlxCqegcfVWxvkck/sTYAamcG9TRWZJFy8NZSvQTpaDluh/dplvrR2EkVcuw6G6HnRPmXMYw3JFApmgEGmxBMknZnLl553azcQgL40vYJb0qh/4ECIDwu8bk2853vbNg6bSUNVYyeqYHhHzgNKNODrGainM8nWL71P7GkhsKPZLla95gcrKkKErNg9FIhFNcYdBQXFJhckYKJhSBULWB417wAgTAO0CN434dhNAdyi8DVCZTvFkVjW5k757wGNVeNGhIuDl3D2hU4sRedVRTiDYW7t4n+CINrZ5WDhBnDeLfoPdyRN8affxPI2O0MQo3SVjL8vMlgN+GCADzNTYVOP/ClyGMAqsQ3kVuxP+pPyw/a7K7bXyoN2tHEnPQ0AY92VpRZhvDn0SHfXuk5/1LxkewgmcbaLHX3huB0YIciS/5BcEEnPSJpGz00jFSf1yRhEbHPoCxZK43PzoRiILftXITntx77OSVj1FpLH0IupE2BgwbSv6sETCj8ikZcpdOvymy1gwEZfobRSUKErM/oKJEEzBMck1G00C/YRV58d2HzjVhklSwPjPQUTEC/iWZZWLTPIFGtcOqo1mmsmC/rTUKdTlfTvMdnE8mQ+qNIT9b8fza1RAL5r/eTP+AQqyo4jArePs4caiU8koLN9j4eR4rHq6dNFYhqlh/GugIhMhzC58J3cPbF9sOcqFAV0GGVcfrXHeejXVFfHf29MriUCKxX1T5inFTxQ91qJYEtumSDwkIXT2fLOOI9sfvkhi3emnD0asoJTpo8Bn5h17O4QIVKw9W8bs42KIB3D/Mhs/XS82TW6DTjZ3EUrVmctrL+6wtL1SiWEwvxDhBg9RCCluWBCO3usm4NruE3+qgPI2427xDvFxAFk6H8s5KULyD8yPpWFmbG1QLduVS8kPW7mGYSM2pTLL2sgWTF8gsMfZ6L6g7GGVjbKjPzWXhZBjUJiN2MmXDAd5TpeerRtLfjWXJmK/Zg56Gh6gxm0WM27+VQf+IJuCpdZN6rvfi47ZXsgFcTmaJLLmS+zOUfbTUjYoJZHuaUrlXByoiXvd4WXlkbKHvpLusNw1lcAwTMyz7kmGBzaO7cwRtROKP3+g+GVdovGe3pHe96Gdg3jW+q2HaiOWSBVVp0lEXKpd82atlIlRZvE1XmTejKSEWgCgWXqGRViEsSXZvfHN7KGtCs4BFuACr6PwTbqfRYr96VQ4F0kKXzbOPBCZS/G+pDQv04YSh7d8pTEtBpQwmZUQgmdWVgazS0DwmaEYzxDNAYF3AHzCw4ndUgSxpSKJRe9+PQc7oT31P2I37eUJMNNt2sS8SgRTdxBVitp7g1+JHurQREB7rC0do1oDI47dFzMgqj5zOzGuEk6pjChfHUxLmBv9s6eZ4TF7JEFyo/4GzeZncHV63lm1QQ478t3m3VJTmzSOjnYDD7UbvJcT0IkirYK0K3gOPfnYv6mXJaVVbNA2xd9jMqPpnD2uNX0Z67lf7wI3h15bgmUruTE7YtB2M/rVtjWbNLNhXdBKHGrurjA8VvwIKWiT8Jo9L5PryRAKtcpqp8JAA/Da5ITRBd8e7f4hX5Wwv6GQOGms2pCr2zOwmOV3py0ympwsrWnB6rW7FTjaCuAv0EX3MJthhGLFL6qUukd7MtR+LmYx+gF61n8pc04aImihvQGLQ6i/pLlbco9iVQ4G/U/SR/+82loGx67+unrPP9rXvO0RDnDytfv9Nt+RHvDJWZQWRWOdMoNc8RGfoBAhHlnhYaHawRvulaCLoRVM3Ww6HiAJayNVcV3NTXYEzV+xaBfBhBnWV95fZoWH41yxnIAlLdZnbVkvLMaMnymypaeWSJhBfqYFtp0c6S/0S1HoirwphmQjRlKGkFC02YanXxM63lxSOzQg8n3eaBzPrnzvYuxWzxArDkAIkHqY4YVUjllzKE4oYLL/o99LxBx6jGWAQXJpJeTdyGKrxBikk4md3TOMb+Rj2WcAU3/rhbMPEaF9UNYJUfrIJzieq2RcXZ0byee+dg8r/4aAviBZr7lN06yQWo6VEgXSAOGCC7F0QbnB9pdJ2XbhWF3NNOK88HFMUwJGygafmRUjMHPSjIeZeU8R2l0RoR01rYLAHm814NEFZfu9WnGb/thRtAUoar/OFnnfzlDFjJ39R3A4U17Xn4eQnacxf38c8NKv7wp+SptkXs/21p4n97NYFnN3r2jKY4BI+hKCTVv4J/YkZ9vhfCZC0tVQ0yuUnY4JiAlMosuunc/EmVXLLOa7lgSFBmz9CiB9IAssGXHWALaw7cxpK7oVXVT81oD3lS3f3yLv4a2LAnAcq4/5D42UhqnSkyVSZ3q/jxrFvaoHdQnoofQ+ZDAGpx/t8IYeZN0WG4OHLCxrwP+cqkqKnIzSSYJpR3CHQAXlAE3CnAiNoT/4vYOjVZyas2m+ZG2LrlGg5nPb/mKq3oKrhgdhfH8gD+YlXH1jJiTs5quznrTGYsMRJkh0HP9LWw+JZv1H+SCkNjjGa/rFQMxFQE3akIN69Ne/wBRxYZxMLoiQ3nXcCz2n/dztz9ShAfrqatsYVwBI9zPREP2gZTG7r8S3DBXKJaCHG2XsPHQr2uQdGFOeFYeBcKoAJ3sPXCqXEQeyEMnuMgNECxgFUlpQuN4FnLgVfvV86YOvr3HLoNaaI6xqbZuPhtE3DnEAXSSdMg3cXxp0lcPJbygQlHnT1aKXmZQwWN5eQ9FwedYm8gCurVbXBp9KnLMqdSrljbvrkTMPcOkLVhtkLfC+RGzG5HXJQn9nn0ll9ntoyFC4BPiZb2PPlfo6qhCsZkBl8BSfVwLezkwxa2HsZdqleHhlWxrkCiS+YmjYKaVB3S4OPBOB6hgPJo9xErF0pOcdpQNq5yAY4rrj7RFdcKnd6x6VRrJqvl4lYa5ydzZEy7546XMeWGy2dslWJfbZ6TJsV7awnCS5onlYp43FUV1YBsdImfSRhPjiSVVVE5WKLEoUlJt5bdnQbuULADop6MkCewV5nQq1UZdw5Vcb7Q4bXAqriTzpB6vMfEdJXt7f9qniybJBYOXxnUUijZuXHDU3hTmZJRjS+4qhORoHIgm6V27RoloLhD2wgkcIW1K+Qs3D2iK6/xT7jiyKIJkfjy/YGZQBLyhu5FdjYTI3RV55mw2DYOD4OptYcL9ag45cd1pLolUHbOO7gAJSd3ow8VoMwCb/aH7PdVvSuyr6f635NLnc3vbn59AC4tfY//TtRAE/HSP2kOKAFUlLJXY43QiWYC0hd3OsScWNYlrZG+1ds1amGzbZE9Uswud34lYpsnP9znVdGJRd1hfwcm5wrP7HmxY7d5SI+o+3n84ivE6Cmfq52XL9VZNnLtx3A48X4Pgk5Oz1+XpfRII1Vv+vwcWwNEVDMhk+6YFQ4ajIHxE5eA3VhuiclVA+jQFncvg9M3viVncT/J4g9DBSAMGiee01xd/IeSHCPo68fjrjoeE3+03PFWkXTmjAEH5sZD2zl64vJc1e0wXvhLB834krf7h2l0PnbWY/Ktl0PfXoV8+5tU+vHz4C0KTF3qrcMKSVFHVrnplrWqtHWWSJgeRw0E94rvHexn5GQIha/2VXOuAulJW+EeBb6k4OMNCExG7Y1fPdwbQW0lDq37SXO3P8ojmDX6LI/MkVzcwxSQ7xdkN3Wptii77FA/oqm3rqq4hUIC0R2DN7RyvNiph7l9OcCqQ3XeApW0zMr1VhgKEBIbao8U7iU1TOVeh3v343XY4Ymhpdtos++7Kb1rJZ9S88ft3cLyTNMLEMRb9gT25vGUTHhG316wSI65+35xBFLvFtvdYmbGrMQN/YWqqgab5ckx6aXhnoR1ME28/Kq96zDCEwPqewkKXQonWx350RZUM/3IPo22SnnAcZzoJsUr+17bQi1c/ovbYZGD2077K3ozAbbO15of2unmVTXbRjyopAimC4u7sgj50AkQ0KhGIBN82RuwLQQqwtz8VXIE5CU1gCoUgqP/wcRJ0bNLdrY/FfK6qVke0r+eJmnevOG/eWcCEYZY0ySyUc8PYadSFDKvAzZ3rDjvaplfUafn4OHWpMLQEWFuIz1v1u7rpDeEG04hOgtACdQ43R/mDGI+xq8JUfTRLDn709L88FvAP+Tvz/RGhYHZh3xn9uNJjjjb2qqGyiIaeMSoKnjJviDIIyvnowuStkTj1RSthfifeGSY0cmbiVhqZNWNS0o1yEu63b3mDuAmx+j3yl+IdvOZ4VoOATRcqJMMfQsTaF7ZRwy1XwS9QKdRlqiujkuJLlDKQC9/LsOT85uU0oU3VP6UtKNth1o76O5XTZLC+yvy5DMkpKM9ufpU5EziuQ3bimzLiZWkXYTYUK776i4CdR8S/QuZz0MRgEF8stwIZDZlW+mPz8V+JtQP6XNm2qruRoD0hiN/f28OOgXnfZ/8D6AmAI2omturZxuNXQ+a6emEp3h/EboGw8A70b7sHR66n7nHlMOE+P+lPyNk58NYBG6MNAUHLtVynBkShNkoRUenH+QZQpm9jjq7Nl6Ji/LKnsNorcrYBJrUncjquSPDh/RGmO+NKdwXXV4utzga1J8VbDt5+nutO31uxRk/sqzoLtdo9Heqx6HP61enICgqvl/7Y+BKpnB2at1c9blByj5X9Tl/qST3v6ttWLsKqwWSyqz9Gnvo45E6H0zbJ43uIj4atlP1YKrOr1KJnZ/jYREq32DfUBQVWOiNvfupLLeBcj0aEV2nddD8LaS/nzkoGwpGeKUXUb3p0zWya1xl5eYlFqWBKSjxeL+C0I0PqrR0N3VGnBnrtxZeBMKgievAQc5nZk/prYYPX2t5nk1moiW3+z999TXWJvPmMCoTtzmVHSksd71dLPDPZPoB4Mojza9k/+yZFxu8lCMFpfpHWaEOE97WZqSf88AWScN55YnHIOgLrMfqKMazb1l9e7rG8bts/PFUuwXaYxfbF1KznFPeJbfRp7dphg5y5FlHQnRAIhScKf8jS/kuAiG9KS36FWSY85e4mwnGcmlkPYaMwpIwEKoG8NXySPgHw78/cd2ZPjMe4/JPPADSy0ChD2pADHxStD2LL7U/FDV49Usy8ZAB9TH1ZyhOU4/x4OsfqT81s0J8X4GPw04plfEDhZF7twbU5QZFhvhkzj3mFBXNc2h8p11d17QOq/k/IRGvpRhxZ6Kl7g6oWV1V2aKC3kYU22v0b99P62iyXbmORAWkpSysjiaOpR3yM2R/XYVlnibEkU+r5R9kWX28WKvjQpP2cBWk8mEXMQcDCG2nSn4Uok7JEpFAHGuEju3oOeHGLl82hiYBDTGDugG/eWS0leqx2AJNXwExKcNflHnl5EupD0kf3+0NVnKQsHASqcPlLQ/HrGMkvUgiLiweWTFR/1BIx5YkLoXCiFcCecgbZAL8jT02Tn+5zqui+9El/QUBfecwihj/BWtbcmRs8CsWLd06uxX0XIzVll7yAGUd87DEKh47gPf/Ok9rcqbWuLVg7t04V4FvnTJjMjY2Mr+78IUPxC1p54y6TSBfUTWF0uvDcm4ga6/Vw3OtbuFJRLGqdo6K0P5Fo4FB5iUDEVTNhp8mq7H08YFFV32gTBPwCZijukAZyVFW4cw50n2N3Wfa1WYqZeIbARCJ5mowAN53X9uqaGFxmbVeFStJC654CydfdZ3PqKeRkZn9+7nShj6dKId/8vgKJOPIDryn9lA0AXsI5aa9aXtmIMidZUHl7A8DdMm1ow9WKx2LvkAbFdU4pQsUmfg9OvZCBhcd+XKrp2GI93alTbttIbJZO7xLDx/btiw/CbzvfmLLpT5LffubTHF9Mks1Cj2w2Ay2obnDak4cMqpgUqrc1u2CbO/WRjsNPVjFvmTyh+glc/BSOS7Gdd28xnrIVKF5N5JUQvUndk9KfYka1rs/sy3squ3Hv3AJoOK+9UpXjFKPBb4vyS3SoHP3a0ijf9/Rr5MRO24xv89aTrrkrrhGk292CkWQV7khmczhMUE/NmXLulrFVtbNt6tABuswjTUumJbfJaYXhR4n4HwW1BI2DRjqgN1earaFeu6yrwSvknpX2ysZMKKR+UMeQfJmigMDzVVg9IGWArtOU6K3ou+CuZTBg7WcjDFpG/qG5pYxns2dMVMiCzjlvoESKAO564PcxhMN+vfDGeIfEHMEtuHiyRxaVZhKCP7DUGZfL37Vz0bk/s43MaO13y5VZi2qekLhSuCJJAnLM3igzwbHWnmxV8PqWriq2nNvly8xRKIQoyrtDXZJ6086EfiZUJQES5vJu0FKPT9QgXeK7CDhRuO2SKliZ9CUkF0dsUWj9MHN99rnL0kJDxbqbLZlbllZYIef6sKjf9KoozaewHgReBB/Sa63QN2HPYkuImz561Jdgf0HVRM5nl2sqh0eUk1WuhIfuB6Rm39auvI+5PlFw+TQue9oWdwVogj2DjO4ZISVSpFDCgxC52wwSAuCKYQxJyPN36QMs6+Ecn/uBc6Jk/xqm/zUWU21R18KycfHE68aIemuIlUkrZu8WGH3jhkoOivim+XCHTQfUfkHW1F0OePjxFAeo4SGIDWrDW9Sd1oDhMFnd2B1KvmuHp4zhIte1B9PmCqAxpduhwvMEYy5nuwRHLd1A7XwtsiuGRi62stB8Pgya99IRj4jtZYB8mXHWRsljWJZHXUI1fl5LHjpv9O1D/2ZkUIxfsX33Zf2+AGWxJjFO6J4/nCDp0wVDmGkm0658f3HwL+1xq9aQUYd4DT235sWLh2DvZw+cfdFnRv9tAZhviFqeb/sSVdoP4mSSvwmCM4zSX3OxP2B/V3qOqrwEPjtSBQhB3XPKZgRbPzYLeAT/UTOCSSh0EOrzEnXBYz753qmFaFnS69MikxNBbg/K3dnozNXc8S5ew7jCQExBXY2m/TmmNwyBCauiY4xITgTRytilow9p28XRye23TI4lZprZO+J5OsDi5IWDDslGYaGvVlShvhHR9taS3irjDlrS5PJ/+n8msa480E38q+V9r663l1czFJGi0G2y+qWK+tcyoPqk70g2sKy1WmiqhRZPyF0LvLS8CF7YdwrWPFF4Ak+YTZLPR6LSUOrfPQx8kNd8PnjojQOSKuKF7lp42K7m7DZbz77uwoYts0nk0pQxzFGhCqYOAmEnQdU2iNhvAprgq4m5tU+vIOOi7mLOUbFceRrM6FCqTG4l3ejW3JV/8MyWtE2Q3R8BysKJ927e8MdSy6KazdsbGiazcHTh4C1Ye20NMU7/ZvgnVO4+Bf2uNXQ11IF2g/iYXvegC+STT5QwWi3A3cHEoN9oLDm0jhrx0aukPmaZZsJ9rsnNsrObKX3aKX8WsdqKdja+2LQ1MlcAihugRa/ck3tMLxLygdO9iyGuVlX49rDET6lQdpaQ8X+FcAN2ANQyImC+jIRiVMme1OeKfryLUXRkYTTa8n6UginNq5dCRrFMDOyg9CePDyyqVa9KCpQI9Ep1wKqHvWQmKwrmCTiFqkcfSKWFgfHxgBEfNyoRsQHDn3KO0eeiK6Ral/tB9LtzmKe4vsz2184qvEX/ZsCuP/aODKQRyQP66p8AAFbxYytPN4xF3PprLUmCL4aqOxJ5ZYO5v6sGJiMiQWyFoiJ2SHrgp2SytVvEXQ4gLyPOWQemw3g7PvXAzl1OhvN26IUrcrrY9yFA8o4QWNE0fMyyoLF2WCIuoB9Viq/iULt6MeU1YmlDQX0D4DeuaoYuawHPMcy2hheLABY2UpyReMc39MzmXRTg2i3g1+vjI6nF2xxtkH4FdRQhWwf0NztKTdaFczRb0a6GM4XfBRRexSSMJsG7lKdFhE8tIpVMn4zxYK9nOdxSBOxXUpmYt7DsurXVm+q+hNnLAe1nUIpPRbFFK8ANdWgDUjM43uW7zOX7vUBNVdqZCUfF/LaNj622aUFMvqKK1xmfqV0a7y0mOOeGkZVLzOkByVWIEe72bmx8Eoj9/dBpmyduM4DwxrXdn34V9Par6hjmnyHtYPxlsEHgScSzIOd8omll6nFBRY2lhWiLsvY0nDwaQZ8WcjxLT2BS1z1nQRQMMBitiUOrhWWBukPQuv11tbR3+a7TWuIWuTW3Dr/fIo0Zn+lduHvSiYdCKqTJoQaw0m+7GRD3gWD0NQ+WGD16W76NghouDSSW/qWmzWk8wVJ7LhHUPJSjEJZVPmv8eWt/IoBbdbkFzo6dhFtI6378RkzXLKLikm8ANnEC4b1xfD/eleluzb6klrRzevfyhWoTQkuXYRL/eK0q1H2E5/NTvFF9jhWB1gvulEKQ/Pa+PDed0e5gGue5Icdr/k+M4lALPcenZqKr4nD0TlG2tsz5deNK8MnMaoExyifwjdWmQo2mUmJFJ/wfePX/+9OiZRvhb48LvoC7m8ANrBxeR3FuABipSImMNmRYFYWKxwiFWdi26i1F/ccMGqTU0PyUmLBsP2UVXxK2wVjqsAKPzmAOwO//KGTdkoxnKgYSvgWVQbmWM9sjMuLpl44ewsRQEhELRGhHcznNbE/HXj33UMnqbqqV3Cyqy9nqJmov12lkWg3mZC9qhQaXtn0pAnuxgn1VcRaSQ3ruZyXgXxAfPQ5MtlpxqTfAo/h9PZGEMJz6BLKW61qv9UhuQQktDnTJ3E0kQ6FsWsqBdGY+HW09+XbdSB5l8MsIldYVf4c0J+mLO2FiIj/OjdIjHqKUbbsANRUGoT7rlKHff7+W4o+2q1XZl7c7Ck8PWTMw5gZ1FmrC/M0KHDbEWhK/rBtBBtsnj+D8WEXkk4cyTxRElWRu6r+Bq6wfGnpX5dvMtGXKa4YkuUPlWj54Q2eMtbKc0eOsAvgVWYaIk+luHMXkz2eiZDoJB2ytNgwWBw1L38BXL2cjPYvQYn4NtKLNYNseNGdUnQ5NaCBmZ93Dr2s5DH1evM8USfDwJG+wkqFNGjYtrX+APZQZnBdY3etntu7p0ZyPo6qFv77yAQqkYHhv88nr5t63RlYjtBXBW0RmUBdjVLlnKur3VstX+6WffHNWGThDFSXmMq3+amwTlGKRKSjRYXWB23yf4PtZLxfxOytUe37TtDp6yvCNfxQxbvs23afxuB5HL0XFF8uI3h1gOYaif9VmpQjlp60S4XO7KUieILFqfJs9e9CSEU8Rr/pBq7nFAhdN5wL3/ghsnqebWoOGBipBk+kKMxMLbD7W84YmstTS4Gy6siC38ULK+AcO1BbDdQGoPRuX+aCIwWeFENTrTgJvpKqTY3x+d2AEZGSAKDBmahPNDI1ovfYP4LVF7bHI7xna+8gSeQTwcJdf/fiwW8mAKvY9Myu8aSnuap+/B76NlNtkUbEabkRNhU9U7BSmGurINIQwLz5BigIERqOQLLuVX+2N45hot39h9vWKVz8D/qUukaAZ13QcMHobz0XM9d50zy1zW1de6CKyjAOic+w8Q+t3ruwwHuDYGVSCg9B6Dkt5BOZVln8D2sMG99gkyqAgz8z6wiXgW6/tLNDoxVO7wnvmAt8eApBI0wQPglS8pDwjKK9FmeoDHwoMTeNAU/2ETLz7fKSZImYn2LQL4R5x3ji5H7jBdLfKyaDKTwNgTh7UIT/+RZF3tjCGS+eIChshOazhkmIB7b9Xg6ujAGQzxVsPIy0FOsIRAxfcG8JecFUEwWO1tO07Axb3g+2ELuJvLFpLrakiaUABeJhr5rdsrkPVfWrzGzx9x7RchIV6djlDjmVIIWELsOB04xmsX4WV3D9tiShIynbk1W/qhVeYnpJGpkxS3SzGNS4l+FKFROrg4saRnGm+NrPlBohLh251yJB8HR+KvMPJCzbFFJBflZ0fBQodVRNzByBr2/RxMqUj9BczjBRXahA6Zz0rDHOL6hvghQB+YijgW4seyWQfWHdC7VLSUmQN8BrNs2GSqvef1Gmi4t6A+SkzleD5DS3sXL0aQZ6VCvPImSTbUhcCNvBZRefK3PMhnW8w0eLgPsx+91fLMyF99zArG2uq0aqDpVVWxtvuz9B6nvpqUfA0rR4aJXDcGv4KGEmHW8rEkrQHz9ad6FUHFAX81tO4DXTndrUOvwI1X1L8enUhLxm3Y3GTrdEA7+xxcFxZ/RWglubX8xXw9ZCiXLofOaObqPjBiTZvV6DkzvdK18LqcjVATiwMlMhdNOAKLXKVInD88UfUTy0ewFZTXuluQOCotN28SFgRyvgM3UNxMJGX5pvw9VseyNWnYBZWiXFf40u3s2gLy0YJ/1kKJcuh87azH5V0Kt2zh9/IiXkDG+lCZKLm7k0gs3eCckQOW0jShzy+qKq8CD9SesPDKMxPN6e8y675wpoU4hxaBdI2w8A1gwVFkZkKqMYO3wWTaerG54QyvEJuZWw6fRjM4AnXMAeDdLV+bal0qbq2eC7nbUrv6/arr2uz+isnqtWUSJoor6T7EEZMw8VEWOzFyByD8jdEOKAFU1MDLy9FStlkixuGy3e4crzRo7SDRkxjblw40Hz7ELtCDv+EK9efvkBUyCoJB7hrFUR0dyUg8SyZiX9IRFU7J8KqQPd7LZZhlHjrzIV7pU9Pi3uwTZ1ZUY0SkQAPdhiEFSEEef+y4pUV7PXfb/WpGHMnFWp2zSbneHPGn0Az+iDRxYYIkfAXwS4PgWeO90R9v5R+JKE5Td2muDJQRFoPOYtbElFldxbsX9lzDX6Z6nTmslaZC4Gk0X7NfFQaDyw3HnuQEAjOn3V9P9esYDKCpJhf46QAItuU8ZdSTBIYWJJ8QvHOO8YsMYwnTOSnmnjo/btsIWA8D0dbnx/xtNQIfuvedTYtKaIlrrq7uYalZ9Pgish6wO1qpQAB2gwf1qW2QCGFakTokQ0cMPeR/RehUgQVGXitQN5oXfBsNdwBlmg5gBpgaZY56a7iqQvbYZ1L+i+476cm/zkYgMjJB/Q5jtnmETWbHcqOsHsUXorrlE5xf5zUL1v0Xj3A4jrv1O5PFFseY67OUwtDnlkde5FQWSRgAuh5B5+uzVfaRxPzxueCUNVE/Vks6d67/nEEgiUlKJzZuJ956g9i9MQw5Ocu/EFddhuzYqlkFTZRyelBpx0T6YZI43ilLEOdqo1ORD6kJbxPPC2Wd9IQi5Wu6f1Xhq4dvRf0EIaYf64XZKhIpYSjb/qS+gBlX+diGluNSu94deLU/hJD9Bf8a7ftpOCwHLdG3ZuUP9RPY97UzfMhO6eTW3f9DxxH3jDGLDnApOGiU6jLLfvHiOBrpwQgJibQ92URDhyhUOJWNHZxKwTQO/9vBx6ZlFPFt7Jvwde+kWU27ASFKEzM13ikIkgQNMyqHgg47BAtCoM+uzGF9eF/2TKox5zd1kqzMY/RPRrEeaKio3W0GSZLnoRsEhxuOuM15/Y21NeC4z+hvwwvswxC/8QT7YM15zfxM8nUsxjJqi+Bq8gVk7YVXWRbzspa0ByvJYKc5CIRJNzBiPlrrXqDgP9hroKIAjFj16goqaQNwvtzunOSjqmCrWQAQyIDnrsDGMqUzuiJ64qs4rjQ3quVQrVl21YwhLCXTtJkvyFugX62yO8fhT3jxHA104MfSwsC1rk/qjTS87H9oXzWh+oJEnO3VWnoDEmq5jOcWTJpE8lsyfQ7Tx5HUgjMigoHeE45nbPpuMXeY6iS2FeI53s3CcEd/vuahaVV6akNX9+g3CrwN5rpZB2fAtJpNj+54oO6J8T5lrTZKU2vdUkpVis7n9L80bellOkH7vBP8q8rZLNhbRyzfwAi7EJM6kbW12ttdil6+pItjHUkyWRxg6mmtnfa0+VNcRkgAGsT8jlK+eD9gWnFxqIlaPG3F13TLT9ABXLA2X1s5TanqcJAHgwFWruB+O0oG1HDwJbuB4K/13NRZ0NQP5rMhWH0nbRw15Yfe+hn0BJAyplTPFjTe9krLL30n6iduKQ/TdJw07LjbbP+6znkicz0NwAGVbAYlxqWZwU/Vp8i4qOrF6UjB9fRg8Va7X5trCnW/zbT1+c2cs7/PDOxJV29xdn9FZPxC6xv9tAky8AX+GD+lv8W6rwSV06Wrdgjg5NA44TZCP5grMZNucEQgXSAOJlLtg3aein9+amwxNAM2zY4Z3drZoF6iIG3f0QBw9JJaW5nlWJGtkogMAnjByHspIaqJQurOtUKjHOkWwfv7QmFw0P0d7v/mW8i1iQcSQuTheiN+8nj7A/cmFOfvXJf0g/8enuSBT7m1T68fqKMawtVHzyKW0qTSOpKwbzeWx8Eoj+AWvNZH8XhG1eshPBEXHwRDIGAtCHDat6hccwTcFEs4gP3tiK+aSsjwbWRzUkn154p52kj1WNBslJpvfFaJm0n/ZRbKGA0lzobl+gea4J3hwKtbt0qDbmxqsHllyT/utLJX62NBNH7teA3tLf2O7fs1Lw6D7KcgzbuB3/TRvNE+GEqnbKetbkaOMna7p98ylLyw2dx9ZMKU+D5YSt6DYUJBSKtxw+ZvDl2zmdCN8ZucfTF1UJ8EiBptHnEtbOXaQo05Dx0olN57hJvfrifC5SX2EaqLbVho2/pYTWahM4OhEXMQn6XH+8tufC6822E+zVXJhrORgd5TDm1ou/bECd46GP/khBeqSOz1VDgaM5udbJ7IPl2sKSfsW/eQAH3Ry377SmtyP9SSfVGJqKMfuXs/+MKFdOqoOIbkbrMgYPi2FYj/nj7WDfcBWLYF1/GezjD9JeBguM6kfUZ9++LdXaxmrkiXtQVLDOONE4fA7az/mXBudYaDXsTsjOvK4NEyE4U+WwpPcLfrAAFklFnq7oTVAlDdxrcywOPeaIieo7Rl5x42VEl2jwxeZ+YoB4Fp7qnnjx7CDJYvntgQWZmd0NjkDA/pHeEpNqYckTJ2sskUcsLgtud+5P1iRISLyRdasGuDb6D8Toh9uANp6mP61xs7D6SXtfBaE9s6cH9vgW3HiSHK5HOghBQN7Rzy/EirT9UvlButWfjLVCdOrnIlhnDn5sv4rB47bF4pNNhO1h3YHAL3HXYm2y4vWsp3jyo4v5kZTjzkoJ/O4PkAhJ3erFYErhGdNAIoMDAMjdFxRihQn+qIu23xVUNgrkZxQETxo8qPRlcu/2nlLRnMpMRLmghQ1T/8M2MlWEjmRMlFTS2x92t3SYFW2feVn0sKYeyDN2oxIpRiyM4DKfWYceCyrqeOV0opLa9paYHyyIeI4a4/zhzpKG0T3Bl/spTVAn2uEViYmr2hpriEAzCF3FdkMKl4twgVX+9rC42dgmcIyJdYGEszcySojGVP19/4jp7fwoO/d7/6vQR1coBxcq0A8N/JvsqRt39XiQGNLvDRvW0HXR8gCWlpEBAUB4RRbgsOQkCwI5Ok0C70e+N3xZhkcaeYGoCT/F/2kLj5shDiHmXMYyKF7u+NOPAtDLtBHcvBuwP1z0xAc70V7dlnQBJs9rNAxtJp4CEPeRUQU3BIDLChFwUXSKbEX30bQ9MoyClgBn4g+lxt0hHz+5VuTN/iDHqpd2rqF86AL62iH9Y5EjGNcUDpvLQQsS3TPaoBj3yeojoCmvYGsMeYlKyMnnpPaTV5dvr31r2dFKh2hqNEsFfDmox149bUIkrEsktKsyDawCkxaT1rMUOfGweOQsc5GVz05RvvY7XEuOGLabKrn0r8qFRRzsoZTFLOkCpDe9fNYV6/cS6bmZFj2CkgxKjTVgq8nhbBY2SCVnxi9/AkBRIrWahuUUiVVAUu88GUSEPCUKKye0hQ3lhpI11VNatvWe0dq8JbuFA4LvrKys7ICncru1gU4b/Pz9PmAX87TFYqB00tKMI8+sbCJcp/8OjPP9DcWAKJIeoyy4nCLlobuy+Mw7530k0ZRGhvXwa79UcH9eRjXfnCgea5HG+Bn1Cx1yeRjMOh3SkV9bqlj2qdTWrFw4qNwAgIUTf9utiFLNAHUs1HKwon3bsmw4w4UKVSYXvRb/up/ce/3Ngw5MX8V/rv1Wf5dPhsOxOaDPT8PjlZA6IC9DohBvrugrXsBEnr0iRKdRQu50q4mt3BtBbSUOrjp0v83EtsVq5dUFnDFqqV3fbWgOTHFFhUCMfp+KkmAyzPVQXSwLAQ1s7z2hS//YGMF0BgU1m7Y2NE1m3FMyX153pCFznh/7RvZmWrnj9PXenF7RDI8NbpI85iJqyDT5ZgUgDt/ypyHPc0QVco5qzmc2kcNeN2TCPZSqvJEhnGRBhbW6q8WV/ksxpJ3Hv1tm0oPsjA325YpEhCL4kv+ce4kObdRVfwULznU0pK4Aulym2oz36oqsBCyY7/unMvvmAyljq7L+r9EnkZ1uDsqE9NOiPLHfAX1bV2tdjxmHebKtIt/bLZ4d+6998aE7oWy4LjhSTNwpPbZ3ewVVUWYQWRJiAWMj2LycMR4/g5M0xjz5m+KG8d64sd/4vwOOCn/9UudeXWR5cpuF7vAupA+zy4032PGXVRiq8HsRkiztxRgzkV1E5nyt6EpK1Lw4TaKbgWUZ7LnkPpsG5ROAe9HtiblwUVPy34zmXjd1oH5IaouyBvFL4jWbVGZeNwjAtH/3ghh5s+T+TCHD1DfPnOfM0t1BgdPNPLSN8EIG862xS3Nc9VV0dm4Pb5EU5bZgoTJSI/MhN7JMNDSCnuSXriIs85uOPULBD8KE/P8io/wlHvo/i3zxgf90YcTNKsL7HMUKjMh0KM6nLQZMjYg+O89LuJn+IFm4iBTlDrfpcRY3uXSnVK/oYcke6kUDrAOikeE7kqLgjjvRXpMX++5FuF0PCVJt30o5YW/VraBSBeZ8KO6LwlS6RoMcfX/kiOQdrQ2p4T1nCavrBPcO0PzK9Vn1WnAMti8QvWQ8dOE/9KqkVw2olNdb4PLKTM3OGbcrlFQgie8h2xLo6RNeEAiLIuIZ0QUsZIMFx91sbzxrPPQG5DCIDAUleJk0S9iLEjs53im2LPXiEx1fW417u/bMdq+ZzNkQ0lawFN0eIrKRvi44GPWlxGX3jBEfmz1vdFgiS2arlw8KyKCJRHyAqEw0TlOx1MErNNZC43eV7Ylap+YUp6bdP2/B5/e5SXlOjv6JotNir9s6H6pTb9DkeRyaLOi4r5KJuziqTZMll8GdmsJ8LkOueAQGtBtDrHO7bDzUDLkmcH9m/gakmrEZ0T1FxIoFEvYk2PF1h+J0desBFmwnkl/+byg+dW3JEhVCVooqg+weStlYq7cMqVgUnBPJIZR06Dg2TYkpMPVYt7aIuKKkFAUNFEopRSmradU2NhkFHDNkAYfNPGyYLnTFj9XzqPZSmShlqJDQ9C3eyoDBD+huVjZ7z4HfEg4oUszAwF6J3Rcvw29Fisk2THG70F1+KoQ3btB6BCLKiYHeLUCQI/SSsRy6SYeXP20ajWwoyGFs4inBv58DeXtqdFppVX1gQLW5acQgG9nzRK/JWOh2aCLcsUrDiYn4JOr1amJZBpvjR5u34bYkguPLw2ehmBUq2qBzDlrf+dTe54Tieln+kKSl79UbLFwf4P62SyUfHFth+/YnPxkxaK2R4PvyyCu1qxXH3kKT2/v+Ymp6UzBu9EdsgPCWAn1GAcKu9G6l7qr8LQZl6a/i0HBBhn+THknktwbh4Ri1I1IWxVQBPilLFU4RXBThZQtMLOwxE/GMrxoMbqgqOfSWwZzEKW7ZJO1CJCBnjJ419SCT8w3A0oPaO/rdt9wFYtgXYIe3ut1OLg3cnlXf7lX9Jyi+DRsOa1JeTdWqwhhseS/QqOye6lm0DWNTzwwDR4kVAqRhUWaJihwk7T9U8sKRnIPSkLandxqHFHSnLmNSx5EAbWFd7sDJ59w/nheQW8/Qg46fwbc8UkCjT06vyR9/HeelWpes9Lw0Z081cMKe+rXehY3pABB70nwme1Y5QZZkrNBP6/UW8NsHvmpDn0Vdr/eP/f8+W8HkEcm0PNz3RzyW3oDvmpxIVodLxwJLvseEoo2VtOQWk9xjUXU6GTFpebflNjQt4/fBcdLLMgFrlguBhgfllGZ1I0P4+mkc8r+LSpe7Hc5Gtg39vQDbSJk7Zzz1OXMmZFjAMi/ClS/rWBChCG7vPDOvqpx+kTvHXdE1WJ9NgQeHrs/MilPyUvagzIaCbExfjF4g1coIoawzSwqOZTl5c6+CsaT+l2eZ4f6auCbO8UxQZSJA4G90iS8sM91/V01rUuReeCmj2lLQjjPRBi/a4nLIewvjC+PbJEuZRp80IsPRB0W4ecyN7rNDwV4UaY8RP/Eh+OwH+9CT8J8U2CmpeJw0MS6UvMYO7XpM9fFzzoZ9xBq9+VZvM0pPYmtFVXvmSk5IZILGAoxowi++16XUKMhrqIvf39DnQHNqvsiutfa3L0zR6E+LwvHZetD+FMCfBHAoJ7zd4CRqR1aE0oWpaZgE8OETFKA4ELpwgEbEnSNKWjjl0mBQYSgWgV8Bu+f8urflM492O780GTUqSD+qKFYXuworzeJTyzzb/OqnrJ2wxVFdmMUnC829BnUWogDDMgPnYVtqDR4AOapdFPJ7zEaEcVuqsFEfAhEKMNj/GUuWYOalTQm+wn7ajfM3gpcdb2/jiPvjM258c8cESAG9anOWViPXeABjjUxFG+kWvxQ+emQfK38nRYMRO1qfbypm8XybmR+rXeI027lpL5WSo8mtkduYDAtInxRGozGBQThVvXHZVPhLb25GGAbjpM6sS80/KLIvzM2ACid655RveHZIWlHogWFhlLFwzXhLBbpSJ2ypAR8VHdlx0/FlZINKesKFrMUuX3IvFZ6KBYfEqr9nuPAkrOtlcUfxxhDRwPkkIiM5kFOz8GxOjH8sFgUmzS4slgwCYam40WbJMaLW03ilJCHVLCqm2hLuxlK6Ah0jvgMk7DXkmMKYWDk6BMhOu6rUMBAuwAFDzJF6CopwnLxO7OYl+VF69ParjpCYodIdJAwyPGng/LIKJW80WR8PoXd/2/CwJHSMC8WbBlZ6+0Yxcicvo9x5x+esNqwz2ohkEgan6X4wp37w9s19vsn2FMQN64lPWRltl1n6BCjeR/fZu5ApAdGAn6LYwTGUq35a3KJx1nirznmC++M1X31rm+Fikx49kgVdF+7y27mmUzusHz2MxJCJvQlY5900GuCWRFUJ8B4lz+6ihmCunTFq2aRp+x5EdtjgUlFeZOpoLqwHQ+lMry+bSizfvXWgMYPC4sdpDjYCz5zzVlrpFzfITi6Pm5XCbQbQ3QoizbHcZ+/eWdGfCWOaVzD5vUAFVXow7RGPeq1OWcseobVwSnK64yCj98FNA96wfM1NCq93rCaB0SflrM9KY1+H87+asa4ptDD/ePCuy0EpnVATgNFpZwvf/9EqDH/pE992Ppczt0mNlqAFhD5k9Wo4tsWPsmlGgEROaolgn37GKefDTRNkuS8RvaJMZIVgt1ZFJcmeN0ruwrcA7Sb3AgsrZz47aRytuWSImw3W1rqRWVyRMAU3/RBbEEdpFeeMnlFX6ehtgV8+hPKOcjcOE128qqtl+SExuz/jen8dvQm2vG02QNPLDjN0mA/Icb/tTxukeu5pJqjrib9GAUQeC/MuAS0ZG0sCKS541H/O7rSVsHqi8CnHOR0hqhv5Apc793ZCXu9kkqni/YdO0iez97IynLnJhx2+xePzmIUMB2FCf2M3p7/z76a4MhYGUaRrNDvksvZp8FCuAuE6wklRWLSamgAtyC8hHz/XZkfF6sMtaQ3EEdzi6FaHsMfqmT5XUtQgp9N12Q4xOd6nfiaJus0VCJcktSpjqHL5VtfhrI6b4O2yi3nhgLUp27YfFou2AO2ne8UADACZBfP/IdCZoklHuuFEdmRWOUqMaJAQv2N7YzkB+hZazL9vTo/6EIAFogNa4GmGzRpapqD9F6s1quopVCqhSehi6pr/NYjxXKs1/bv//ph5kIjO7Z3cJQDCYDPOzC7vM23ppJLhzBdHj59YsBqfS3WoZqvZymgnDVWeDRUhCDX2/mYkHUs/s0vKCqwgMCfdp5b1Z9WyT9a0mjXQkuXJz2pjuHOt3k6Vpu2WpITd6Zrtvz45moClX5ALMy8IUa00pIMVaiFlUjeQJoZwCPrG+kUe3fV3C+uL5RPHAhbTeOXmVAhiLScqCS4xnbnmZ77GACw1vrXl00n1WKr+JRyhfKHf0INpHpW956XeEciIQbARLM0mr8XfTVqqKiNU3a5R1+QC6kftm6yRlxm8uVJZgkNzmagMfok89ZMb8Oe9VHUhK/2lRMT3kcDPl2rDmqVz+GC3W+msIXPApx0NNko+RTLz5VFI+yTwx7tMO0WxAkNFBjSlbR7suujFF4ci2RNZOkxem8sd4JaEmIn+ahX99Ds0OZUa1YGX4jaYhhCHSs/BbbLL41PhwU0ry0qzmnPdKuUynHHQkzqHvcDVzUpKsbqxNggksQWMgcM8tXPv+T6wFY86tAAHlK+Uvi8VNogkKh3U7KEdt8RWcgWIV8gRp/uYblC3aKVKrTm478E+C9mtrA+zku7Ub2QIY6iJVxIzShaWOZ+eAMPB/aXjejM8VdQmX/Slx8xAVjHBRJmOSUP9sG9uv5h/f3QOFiIrvyhUgt0a8mrEto0yg2yOGKmDe1OoAbC2e8OvC3GgPlgwS6if9OwlxKAl0IMKPK24+Dkker/DDEZhiHcG9PMms3aaJBbafvYM5xmhZRU0RWktEHVhz2oOrHLujAPYvea6tue7zZbYyMGbiTkOkgaGh1sKuNxJQL93mR+3qIZbJiKBvpkAGe5/o1fdnq7TOI4CdgyPBRVm5N3KvqLRdGd6g/G0UMIjEGnAF6FiosfKU2lbQS/lcYb5YyaRrqkryBIRR2PL2WTTFi64gm+Let9smxiWBKqO9G48zXpSJITuEVNLmIQPOwD+ssX8AE2FPT8AGuh0x1KAwIWDpx5HmwybSa7vkKQ/b2pj4d1xcA6z3TC3nggnMNNFUhioJoz+I1iSv9HG1hfgcA/MsAWLHSIjxV9KwWQAOss2r9BDHDqUT2EV3386RmjoecJYZQ5UP4x5epj56bERy9D0NkqVtRuTKnHYATxQpDTLL3rxabHoSOJ4AgbGyougENsqwhccI7iVHNKe39BescZRqstvVfk6pH2UK/x/mlrBhy1p5GDowXD/+Q++5pi5dnILXN85o8EE8oljWDWwjWL4+zNU4VI+ncJopAdYQTXmuSADrMFry+D1h8DCSDeQCPGQ9WgN1bl21rYVACgJGqniSBxMAA',
        },

        // Stuck handling
        STUCK: {
            NO_PROGRESS: 4,      // loads without improving distance before blacklist
            BLACKLIST_MS: 60000, // how long a target is skipped
        },
    };

    // =====================================================================
    // LOGGER
    // =====================================================================
    const L = (() => {
        const on  = CONFIG.DEBUG;
        const ts  = () => new Date().toISOString().slice(11, 23);
        const p   = lvl => `[VTG v15.0][${ts()}][${lvl}]`;
        return {
            d: (...a) => on && console.debug(p('DBG'), ...a),
            i: (...a) => on && console.info (p('INF'), ...a),
            w: (...a) =>       console.warn (p('WRN'), ...a),
            e: (...a) =>       console.error(p('ERR'), ...a),
        };
    })();

    // =====================================================================
    // STYLES
    // =====================================================================
    function injectStyles() {
        GM_addStyle(`
            #vtg-panel {
                position: fixed; top: 10px; right: 10px; z-index: 99999;
                background: rgba(15,15,25,.96); color: #fff;
                font-family: 'Segoe UI', system-ui, sans-serif;
                border: 2px solid #4CAF50; border-radius: 12px;
                padding: 14px 16px; min-width: 220px;
                box-shadow: 0 6px 24px rgba(0,0,0,.6);
                user-select: none;
            }
            #vtg-panel h3 { margin: 0 0 10px; color: #4CAF50; font-size: 15px; text-align: center; }
            .vtg-row { display:flex; justify-content:space-between; font-size:12px; margin:4px 0; }
            .vtg-lbl { color: #90CAF9; }
            .vtg-val { font-weight: 700; }
            .vtg-val.g { color: #4CAF50; }
            .vtg-action { font-size:11px; color:#aaa; text-align:center; margin-top:6px;
                          min-height:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .vtg-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:700; }
            .vtg-badge.run   { background: #4CAF50; }
            .vtg-badge.pause { background: #FF9800; }
            .vtg-badge.err   { background: #F44336; }
            #vtg-btn-pause {
                margin-top: 5px; width: 100%; border: none; border-radius: 6px;
                padding: 7px; cursor: pointer; font-weight: 600;
                font-size: 12px; color: #fff; background: #FF9800;
            }
            #vtg-btn-reset {
                margin-top: 4px; width: 100%; border: none; border-radius: 6px;
                padding: 7px; cursor: pointer; font-weight: 600;
                font-size: 12px; color: #fff; background: #F44336;
            }

            /* ── Path overlay ── */
            .vtg-overlay    { position:absolute; top:0; left:0; pointer-events:none; z-index:9000; }
            .vtg-m-player   { position:absolute; width:60px; height:60px; border:3px solid #2196F3;
                              border-radius:50%; transform:translate(-50%,-50%);
                              animation:vtg-pulse-blue 1.4s ease-in-out infinite; box-sizing:border-box; }
            .vtg-m-target   { position:absolute; width:60px; height:60px; border:3px solid #F44336;
                              border-radius:50%; transform:translate(-50%,-50%);
                              animation:vtg-pulse-red 1.4s ease-in-out infinite; box-sizing:border-box; }
            .vtg-m-lbl      { position:absolute; background:rgba(244,67,54,.85); color:#fff;
                              font-size:10px; font-weight:700; padding:2px 6px; border-radius:4px;
                              white-space:nowrap; transform:translate(-50%,-140%); pointer-events:none; }
            .vtg-dot        { position:absolute; background:#FFD54F; border-radius:50%;
                              transform:translate(-50%,-50%);
                              animation:vtg-dot-pulse .9s ease-in-out infinite alternate; }
            .vtg-m-next     { position:absolute; width:52px; height:52px; border:3px solid #4CAF50;
                              border-radius:50%; transform:translate(-50%,-50%);
                              animation:vtg-pulse-green 1s ease-in-out infinite; box-sizing:border-box; }
            @keyframes vtg-pulse-blue {
                0%,100% { box-shadow:0 0 0 0 rgba(33,150,243,.7); }
                50%     { box-shadow:0 0 0 12px rgba(33,150,243,0); }
            }
            @keyframes vtg-pulse-red {
                0%,100% { box-shadow:0 0 0 0 rgba(244,67,54,.7); }
                50%     { box-shadow:0 0 0 12px rgba(244,67,54,0); }
            }
            @keyframes vtg-pulse-green {
                0%,100% { box-shadow:0 0 0 0 rgba(76,175,80,.8); }
                50%     { box-shadow:0 0 0 14px rgba(76,175,80,0); }
            }
            @keyframes vtg-dot-pulse {
                from { opacity:.4; transform:translate(-50%,-50%) scale(.7); }
                to   { opacity:1;  transform:translate(-50%,-50%) scale(1.1); }
            }
        `);
    }

    // =====================================================================
    // ── A)  PLAY.PHP — Navigator ──────────────────────────────────────────
    // =====================================================================
    function runNavigator() {
        L.i('Navigator v15.0 — play.php');
        injectUpgradeCsp();
        upgradeInsecureUrls();
        injectStyles();

        // ── State ──────────────────────────────────────────────────────────
        const state = {
            moves:   GM_getValue('moves', 0),
            paused:  false,
            status:  'Running',
            action:  'Waiting...',
            busy:    false,
        };
        function save() {
            GM_setValue('moves', state.moves);
        }

        // ── UI ─────────────────────────────────────────────────────────────
        const panel = document.createElement('div');
        panel.id = 'vtg-panel';
        document.body.appendChild(panel);

        function renderUI() {
            const bc = state.paused ? 'pause' : (state.status === 'Error' ? 'err' : 'run');
            const bl = state.paused ? 'Paused' : state.status;
            const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
            panel.innerHTML = `
                <h3>🎮 Navigator v15.0</h3>
                <div class="vtg-row"><span class="vtg-lbl">Status</span>
                    <span class="vtg-badge ${bc}">${esc(bl)}</span></div>
                    <div class="vtg-row"><span class="vtg-lbl">Moves</span>
                    <span class="vtg-val" id="vtg-moves">${state.moves}</span></div>
                    <div class="vtg-action" id="vtg-action">${esc(state.action)}</div>
                <button id="vtg-btn-pause">${state.paused ? '▶ Resume' : '⏸ Pause'}</button>
                <button id="vtg-btn-reset">🔄 Reset</button>`;
            document.getElementById('vtg-btn-pause').onclick = () => {
                state.paused = !state.paused;
                state.status = state.paused ? 'Paused' : 'Running';
                if (state.paused) clearOverlay();
                renderUI();
            };
            document.getElementById('vtg-btn-reset').onclick = () => {
                if (confirm('Reset stats?')) {
                    state.moves = 0; save(); renderUI();
                }
            };
        }
        function patchUI() {
            const m = document.getElementById('vtg-moves');
            const a = document.getElementById('vtg-action');
            if (m) m.textContent = state.moves;
            if (a) a.textContent = state.action;
            const b = document.querySelector('#vtg-panel .vtg-badge');
            if (b) {
                const label = state.paused ? 'Paused' : state.status;
                b.textContent = label;
                b.className = 'vtg-badge ' + (state.paused ? 'pause' : (state.status === 'Error' ? 'err' : 'run'));
            }
        }
        renderUI();
        const uiTimer = setInterval(patchUI, CONFIG.TIMING.UI_REFRESH);

        // ── Minimap ──────────────────────────────────────────────────────
        const MINI_SCALE = 4;   // css px per cell at 100% zoom
        let miniBox = null, miniView = null, miniDot = null, miniLbl = null, miniImg = null;
        let miniBig = false;

        function buildMinimap() {
            if (miniBox) return miniBox;
            const { W, H, IMG } = CONFIG.MINIMAP;
            const box = document.createElement('div');
            box.id = 'vtg-minimap';
            box.innerHTML = `
                <div class="vmm-title">🗺 map <span class="vmm-coord"></span>
                    <button class="vmm-btn" title="resize">⤢</button>
                    <button class="vmm-btn" title="hide">–</button></div>
                <div class="vmm-body">
                    <img class="vmm-img" src="${IMG}" alt="map">
                    <div class="vmm-view"></div>
                    <div class="vmm-dot"></div>
                </div>`;
            document.body.appendChild(box);
            miniView = box.querySelector('.vmm-view');
            miniDot  = box.querySelector('.vmm-dot');
            miniLbl  = box.querySelector('.vmm-coord');
            miniImg  = box.querySelector('.vmm-img');
            miniImg.style.width  = (W * MINI_SCALE) + 'px';
            miniImg.style.height = (H * MINI_SCALE) + 'px';
            box.querySelectorAll('.vmm-btn').forEach(b => {
                b.onclick = () => {
                    if (b.title === 'hide') {
                        box.style.display = box.style.display === 'none' ? '' : 'none';
                        return;
                    }
                    miniBig = !miniBig;
                    const s = miniBig ? MINI_SCALE * 2 : MINI_SCALE;
                    miniImg.style.width  = (CONFIG.MINIMAP.W * s) + 'px';
                    miniImg.style.height = (CONFIG.MINIMAP.H * s) + 'px';
                    miniDot.style.width = miniDot.style.height = (s + 4) + 'px';
                    updateMinimap(window.__vtgCal, window.__vtgPAbs);
                };
            });
            GM_addStyle(`
                #vtg-minimap{position:fixed;right:10px;bottom:10px;z-index:99997;
                  background:rgba(15,15,25,.94);border:2px solid #4CAF50;border-radius:10px;
                  padding:6px 8px;box-shadow:0 6px 24px rgba(0,0,0,.6);
                  font:11px/1.4 'Segoe UI',system-ui;color:#fff}
                #vtg-minimap .vmm-title{display:flex;gap:6px;align-items:center;
                  color:#4CAF50;font-weight:700;margin-bottom:4px}
                #vtg-minimap .vmm-coord{color:#90CAF9;font-weight:400}
                #vtg-minimap .vmm-btn{margin-left:auto;background:#333;border:0;color:#fff;
                  border-radius:4px;cursor:pointer;width:18px;height:18px;line-height:1;padding:0}
                #vtg-minimap .vmm-btn + .vmm-btn{margin-left:0}
                #vtg-minimap .vmm-body{position:relative;line-height:0}
                #vtg-minimap .vmm-img{display:block;image-rendering:pixelated;background:#000}
                #vtg-minimap .vmm-view{position:absolute;border:2px solid rgba(255,255,255,.85);
                  background:rgba(255,255,255,.08);box-sizing:border-box;pointer-events:none}
                #vtg-minimap .vmm-dot{position:absolute;background:#ff2222;border:2px solid #fff;
                  border-radius:50%;transform:translate(-50%,-50%);box-sizing:border-box;pointer-events:none}
            `);
            return box;
        }

        // cal = {Y0,X0} window origin on the absolute grid, pAbs = player cell
        function updateMinimap(cal, pAbs) {
            const box = buildMinimap();
            const { W, H, LAYER } = CONFIG.MINIMAP;
            const s = miniBig ? MINI_SCALE * 2 : MINI_SCALE;
            const known = detectLayer() === LAYER;
            if (!cal || !pAbs || !known) {
                miniLbl.textContent = known ? 'no map coords' : 'different world';
                miniView.style.display = 'none';
                miniDot.style.display  = 'none';
                return;
            }
            miniView.style.display = '';
            miniDot.style.display  = '';
            // viewport rectangle (clamped to the world)
            const vx = Math.max(0, cal.X0), vy = Math.max(0, cal.Y0);
            const vw = Math.max(0, Math.min(23, W - vx)), vh = Math.max(0, Math.min(13, H - vy));
            miniView.style.left   = (vx * s) + 'px';
            miniView.style.top    = (vy * s) + 'px';
            miniView.style.width  = (vw * s) + 'px';
            miniView.style.height = (vh * s) + 'px';
            // player dot
            const inside = pAbs.y >= 0 && pAbs.x >= 0 && pAbs.y < H && pAbs.x < W;
            miniDot.style.display = inside ? '' : 'none';
            if (inside) {
                miniDot.style.left = (pAbs.x * s + s / 2) + 'px';
                miniDot.style.top  = (pAbs.y * s + s / 2) + 'px';
            }
            miniLbl.textContent = `${pAbs.y},${pAbs.x}`;
        }

        // ── Path overlay ───────────────────────────────────────────────────
        let overlay = null;
        function getOverlay() {
            if (!overlay || !document.body.contains(overlay)) {
                overlay = document.createElement('div');
                overlay.className = 'vtg-overlay';
                document.body.appendChild(overlay);
            }
            return overlay;
        }
        function clearOverlay() {
            if (overlay) overlay.innerHTML = '';
        }
        function tdCenter(td) {
            const r = td.getBoundingClientRect();
            return { x: r.left + window.scrollX + r.width / 2,
                     y: r.top  + window.scrollY + r.height / 2 };
        }
        // drawPath(playerTd, targetTd, label, nextStepTd?)
        // Draws:
        //  - blue ring on player cell
        //  - red ring + label on target cell
        //  - straight dotted line player → target (shows desired direction)
        //  - green pulsing ring on the actual next-step cell (nextStepTd)
        //    so the user can see exactly which anchor will be clicked
        function drawPath(playerTd, targetTd, label, nextStepTd) {
            const ov = getOverlay();
            ov.innerHTML = '';
            const p = tdCenter(playerTd);
            const t = tdCenter(targetTd);

            // Player ring
            const pm = document.createElement('div');
            pm.className = 'vtg-m-player';
            pm.style.left = p.x + 'px'; pm.style.top = p.y + 'px';
            ov.appendChild(pm);

            // Target ring + label
            const tm = document.createElement('div');
            tm.className = 'vtg-m-target';
            tm.style.left = t.x + 'px'; tm.style.top = t.y + 'px';
            ov.appendChild(tm);

            const lbl = document.createElement('div');
            lbl.className = 'vtg-m-lbl';
            lbl.textContent = label;
            lbl.style.left = t.x + 'px'; lbl.style.top = t.y + 'px';
            ov.appendChild(lbl);

            // Dotted line player → target
            const DOTS = 8;
            for (let i = 1; i < DOTS; i++) {
                const f    = i / DOTS;
                const size = 4 + 5 * Math.sin(f * Math.PI);
                const dot  = document.createElement('div');
                dot.className = 'vtg-dot';
                dot.style.cssText = `width:${size}px;height:${size}px;`
                    + `left:${p.x + (t.x - p.x) * f}px;`
                    + `top:${p.y  + (t.y - p.y) * f}px;`
                    + `animation-delay:${(f * 0.5).toFixed(2)}s`;
                ov.appendChild(dot);
            }

            // Next-step highlight (green ring on the cell about to be clicked)
            if (nextStepTd && nextStepTd !== playerTd && nextStepTd !== targetTd) {
                const n = tdCenter(nextStepTd);
                const nm = document.createElement('div');
                nm.className = 'vtg-m-next';
                nm.style.left = n.x + 'px'; nm.style.top = n.y + 'px';
                ov.appendChild(nm);
            }
        }

        // ── Grid helpers ───────────────────────────────────────────────────
        function gridPos(td) {
            const tr    = td.parentElement;
            if (!tr) return null;
            const col   = Array.prototype.indexOf.call(tr.children, td);
            const tbody = tr.parentElement;
            const row   = tbody ? Array.prototype.indexOf.call(tbody.children, tr) : -1;
            if (col < 0 || row < 0) return null;
            return { col, row };
        }

        // ── Anchor parser ──────────────────────────────────────────────────
        // Returns {dx, dy} movement vector from onclick string, or null.
        function parseOnclick(onclick) {
            if (!onclick) return null;
            let m;
            m = onclick.match(/moveUser\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
            if (m) return { dx: +m[1], dy: +m[2] };
            m = onclick.match(/move\(\s*['"]moveX['"]\s*,\s*(-?\d+)\s*\)/);
            if (m) return { dx: +m[1], dy: 0 };
            m = onclick.match(/move\(\s*['"]moveY['"]\s*,\s*(-?\d+)\s*\)/);
            if (m) return { dx: 0, dy: +m[1] };
            return null;
        }

        // ── Absolute map coordinates ────────────────────────────────────
        // Tile file names carry the cell's absolute coordinate:
        //     T/AM/T1224.png  ->  row y=12, col x=24   (id = y*100 + x)
        function tileCoord(name) {
            const m = /T(\d{2})(\d{2})\.png$/i.exec(name || '');
            return m ? { y: +m[1], x: +m[2] } : null;
        }

        // Fit the visible window onto the absolute grid by solving
        //     id = 100*(row+Y0) + (col+X0)
        // for the offsets that satisfy the most cells.
        function calibrateView() {
            const diffs = [];
            document.querySelectorAll('td[background]').forEach(td => {
                const co = tileCoord(td.getAttribute('background') || '');
                if (!co) return;
                const pos = gridPos(td);
                if (!pos) return;
                diffs.push(co.y * 100 + co.x - 100 * pos.row - pos.col);
            });
            if (diffs.length < 20) return null;
            diffs.sort((a, b) => a - b);
            const med = diffs[Math.floor(diffs.length / 2)];
            let hit = 0;
            for (const d of diffs) if (d === med) hit++;
            return hit / diffs.length >= 0.4 ? { Y0: Math.floor(med / 100), X0: med % 100 } : null;
        }

        // 2-bit cell map per layer: 0 open / 1 blocked / 2 avoid
        let CURRENT_LAYER = undefined;      // undefined = not detected yet
        function detectLayer() {
            if (CURRENT_LAYER !== undefined) return CURRENT_LAYER;
            const td = document.querySelector('td[background]');
            const m  = td && /^T\/([A-Za-z]+)\//.exec(td.getAttribute('background') || '');
            CURRENT_LAYER = m ? m[1] : '';
            return CURRENT_LAYER;
        }
        const CELLS = {};
        function loadCells(layer) {
            if (CELLS[layer]) return CELLS[layer];
            const def = CONFIG.MAP.LAYERS[layer];
            const arr = new Uint8Array(def ? def.W * def.H : 0);
            if (def) {
                try {
                    const bin = atob(def.CELL_B64);
                    for (let i = 0; i < def.W * def.H; i++) {
                        const bp = i * 2;
                        arr[i] = (bin.charCodeAt(bp >> 3) >> (6 - (bp & 7))) & 3;
                    }
                } catch (e) { L.e('cell map decode failed', e); }
            }
            CELLS[layer] = arr;
            return arr;
        }
        function cellAt(y, x) {
            if (!CONFIG.MAP.ENABLED) return 0;
            const def = CONFIG.MAP.LAYERS[detectLayer()];
            if (!def) return 0;                     // unmapped world: no hints
            if (y < 0 || x < 0 || y >= def.H || x >= def.W) return 1;
            return loadCells(detectLayer())[y * def.W + x];
        }

        // ── Learned walkability (persists across page loads) ────────────
        const WALK_KEY = 'vtg.walk';
        function loadWalk() {
            try { return JSON.parse(GM_getValue(WALK_KEY, '{}')); } catch (e) { return {}; }
        }
        function walkMark(w, y, x, ok) {
            const k = y + ',' + x;
            if (w[k] !== (ok ? 1 : 0)) { w[k] = ok ? 1 : 0; GM_setValue(WALK_KEY, JSON.stringify(w)); }
        }

        // BFS distance field from `to` over the known world.  Returns an
        // Int32Array (W*H) of step counts, -1 = unreachable.  `walk` is the
        // learned map.  8-way: diagonals are real moves (moveUser).
        function bfsDist(to, walk) {
            const def = CONFIG.MAP.LAYERS[detectLayer()];
            if (!def) return null;                 // unmapped world
            const { W, H } = def;
            const key = (y, x) => y * W + x;
            const dist = new Int32Array(W * H).fill(-1);
            if (to.y < 0 || to.x < 0 || to.y >= H || to.x >= W) return dist;
            dist[key(to.y, to.x)] = 0;
            const q = [to];
            let head = 0;
            const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1],
                          [1, 1], [1, -1], [-1, 1], [-1, -1]];
            while (head < q.length) {
                const c = q[head++];
                const d = dist[key(c.y, c.x)];
                for (const [dy, dx] of DIRS) {
                    const ny = c.y + dy, nx = c.x + dx;
                    if (ny < 0 || nx < 0 || ny >= H || nx >= W) continue;
                    const k = key(ny, nx);
                    if (dist[k] !== -1) continue;
                    if (cellAt(ny, nx) === 1) continue;       // water / void
                    if (walk[ny + ',' + nx] === 0) continue;  // learned blocked
                    // no cutting a corner between two blocked cells
                    if (dy !== 0 && dx !== 0 &&
                        (cellAt(c.y + dy, c.x) === 1 || cellAt(c.y, c.x + dx) === 1))
                        continue;
                    dist[k] = d + 1;
                    q.push({ y: ny, x: nx });
                }
            }
            return dist;
        }

        // ── Move anchor discovery ────────────────────────────────────────
        // v14.2 FIX: gather anchors purely by onclick pattern, NOT by what
        // image is rendered inside them. When a reachable cell is occupied
        // by another player, NPC, or item, the server renders THAT
        // entity's own <img> inside the move <a> instead of an orb image
        // or a "Click to move" titled image. Requiring an orb/title image
        // to recognize the anchor made those occupied-cell anchors
        // invisible to the script, so it would path to the nearest tile
        // instead of landing directly on the target.
        function findMoveAnchors() {
            const anchors = [];
            document.querySelectorAll('a[onclick]').forEach(a => {
                const oc = a.getAttribute('onclick') || '';
                if (CONFIG.MOVE_ONCLICK_RE.test(oc)) anchors.push(a);
            });
            return anchors;
        }

        // ── Target detection ───────────────────────────────────────────────
        // Uses src.includes() NOT src.startsWith() because the browser resolves
        // relative URLs to absolute: "T/C/abc.png" becomes
        // "https://viraltrafficgames.com/vtg/T/C/abc.png"
        // so startsWith('T/C/') would never match.
        function isTarget(img) {
            const src   = img.getAttribute('src') || '';
            const title = (img.title || '').trim();
            if (CONFIG.IGNORE_TITLES.has(title)) return false;
            if (title === CONFIG.PLAYER_NAME)     return false;
            if (src.includes(CONFIG.UI_SRC))      return false;
            return CONFIG.TARGET_SRCS.some(p => src.includes(p));
        }

        // ── Main navigation cycle ──────────────────────────────────────────
        // KEY FACT from real HTML:
        //   Targets (players, items, NPCs) are bare <img> tags with NO click
        //   handler of their own — UNLESS their cell happens to also be a
        //   move anchor (see v14.2 note above), in which case the <a> that
        //   wraps them IS the click target.
        //   img.click() by itself sends nothing to the server — it is
        //   useless. The ONLY way to collect/hit a target is to submit
        //   frmMap (walk onto its cell) via the wrapping <a>, when one
        //   exists.
        //
        // STRATEGY:
        //   1. Find all move anchors (by onclick pattern, any content).
        //   2. Find nearest target.
        //   3. If a move anchor lands exactly on the target cell → click it
        //      directly (collect / interact).
        //   4. Otherwise click the anchor that minimises remaining distance.
        //   5. Fallback: click any anchor to advance.
        function navigate() {
            if (state.paused || state.busy) return;
            if (document.hidden) return;
            state.status = 'Running';

            // 1. Player
            const playerImg = document.querySelector(`img[title="${CSS.escape(CONFIG.PLAYER_NAME)}"]`);
            if (!playerImg) { L.d('player not found'); return; }
            const playerTd = playerImg.closest('td');
            if (!playerTd)  { L.d('player td missing'); return; }
            const pPos = gridPos(playerTd);
            if (!pPos)      { L.d('player gridPos failed'); return; }

            // 2. Move anchors
            const moveAnchors = findMoveAnchors();
            if (!moveAnchors.length) { L.d('no move anchors — page still loading?'); return; }

            // 3. Where are we on the absolute map?
            const cal  = calibrateView();
            const pAbs = cal ? { y: pPos.row + cal.Y0, x: pPos.col + cal.X0 } : null;
            const walk = loadWalk();
            if (pAbs) walkMark(walk, pAbs.y, pAbs.x, true);

            // A click that did not change the player's cell means the game
            // refused the move -> remember that cell as blocked.
            let last = null;
            try { last = JSON.parse(GM_getValue('vtg.lastmove', 'null')); } catch (e) {}
            if (last && pAbs && last.to && last.from &&
                pAbs.y === last.from.y && pAbs.x === last.from.x &&
                Date.now() - last.t < 120000) {
                walkMark(walk, last.to.y, last.to.x, false);
                L.w(`move refused -> (${last.to.y},${last.to.x}) marked blocked`);
            }
            GM_setValue('vtg.lastmove', 'null');

            L.i(`player col=${pPos.col} row=${pPos.row} abs=${pAbs ? pAbs.y + ',' + pAbs.x : '?'} | ${moveAnchors.length} anchors`);
            window.__vtgCal = cal; window.__vtgPAbs = pAbs;   // used by the minimap zoom button
            updateMinimap(cal, pAbs);

            // 4. Targets (skip ones standing on known-blocked cells)
            const targets = [];
            document.querySelectorAll('img').forEach(img => {
                if (!isTarget(img)) return;
                const td = img.closest('td');
                if (!td) return;
                const pos = gridPos(td);
                if (!pos) return;
                const dc   = pos.col - pPos.col;
                const dr   = pos.row - pPos.row;
                const dist = Math.sqrt(dc * dc + dr * dr);
                const abs  = cal ? { y: pos.row + cal.Y0, x: pos.col + cal.X0 } : null;
                targets.push({ img, title: img.title || '?', td, pos, dc, dr, dist, abs });
            });
            targets.sort((a, b) => a.dist - b.dist);

            // blacklisted targets (recently unreachable)
            let bl = {};
            try { bl = JSON.parse(GM_getValue('vtg.blacklist', '{}')); } catch (e) {}
            const now = Date.now();
            for (const k of Object.keys(bl)) if (bl[k] < now) delete bl[k];

            // no-progress detection: same target, distance not improving
            let hist = [];
            try { hist = JSON.parse(GM_getValue('vtg.hist', '[]')); } catch (e) {}
            if (targets.length) {
                let stuck = 0;
                for (let i = hist.length - 1; i >= 0; i--) {
                    const h = hist[i];
                    if (!h.title || h.title !== targets[0].title) break;
                    if (h.dist > targets[0].dist + 0.01) break;
                    stuck++;
                }
                if (stuck >= CONFIG.STUCK.NO_PROGRESS) {
                    bl[targets[0].title] = now + CONFIG.STUCK.BLACKLIST_MS;
                    GM_setValue('vtg.blacklist', JSON.stringify(bl));
                    L.w(`no progress on "${targets[0].title}" for ${stuck} loads -> blacklisted`);
                }
            }

            const usable = targets.filter(t => {
                if (bl[t.title] && bl[t.title] > now) return false;
                if (t.abs && cellAt(t.abs.y, t.abs.x) === 1) {
                    L.i(`target "${t.title}" sits on blocked terrain - skipping`);
                    return false;
                }
                return true;
            });
            L.i(`${usable.length}/${targets.length} usable targets`);
            usable.slice(0, 3).forEach(t =>
                L.i(`  "${t.title}" col=${t.pos.col} row=${t.pos.row} dist=${t.dist.toFixed(2)}`)
            );

            // Landing cell of every anchor (grid + absolute)
            const landing = new Map();
            for (const anchor of moveAnchors) {
                const vec = parseOnclick(anchor.getAttribute('onclick'));
                if (!vec) continue;
                const gc = pPos.col + vec.dx, gr = pPos.row + vec.dy;
                landing.set(`${gc},${gr}`, {
                    anchor, gc, gr,
                    abs: cal ? { y: gr + cal.Y0, x: gc + cal.X0 } : null,
                });
            }

            let chosen = null, chosenLabel = '—', bestTd = null;

            if (usable.length) {
                const best = usable[0];
                bestTd = best.td;

                const direct = landing.get(`${best.pos.col},${best.pos.row}`);
                if (direct) {
                    chosen      = direct.anchor;
                    chosenLabel = `✓ ${best.title} (landing on target)`;
                    L.i('CASE A: anchor lands on target cell');
                    drawPath(playerTd, bestTd, best.title, chosen.closest('td'));
                } else {
                    // Case B: route around known blocked terrain (BFS from the
                    // target; take the anchor that most reduces the remaining
                    // step count, ties broken by straight-line distance -
                    // which naturally prefers diagonal steps).
                    if (CONFIG.MAP.ENABLED && pAbs && best.abs) {
                        const dist = bfsDist(best.abs, walk);
                        const def  = CONFIG.MAP.LAYERS[detectLayer()];
                        const W    = def ? def.W : 0;
                        if (dist && dist[pAbs.y * W + pAbs.x] > 0) {
                            let pick = null, pickD = Infinity, pickE = Infinity;
                            for (const v of landing.values()) {
                                if (!v.abs) continue;
                                const d = dist[v.abs.y * W + v.abs.x];
                                if (d < 0) continue;
                                const e = Math.hypot(best.abs.y - v.abs.y, best.abs.x - v.abs.x);
                                if (d < pickD || (d === pickD && e < pickE)) {
                                    pickD = d; pickE = e; pick = v;
                                }
                            }
                            if (pick) {
                                chosen      = pick.anchor;
                                chosenLabel = `→ ${best.title} (route)`;
                                L.i(`CASE B: route step (${pick.abs.y},${pick.abs.x}) dist=${pickD}`);
                            }
                        }
                    }
                    // Case C: greedy - closest landing, preferring open cells
                    if (!chosen) {
                        let bestScore = Infinity;
                        for (const v of landing.values()) {
                            const remDC = best.pos.col - v.gc;
                            const remDR = best.pos.row - v.gr;
                            let score  = Math.sqrt(remDC * remDC + remDR * remDR);
                            const c    = v.abs ? cellAt(v.abs.y, v.abs.x) : 0;
                            if (c === 2) score += 1.5;    // dense forest
                            L.d(`  anchor (${v.gc},${v.gr}) score=${score.toFixed(2)}`);
                            if (score < bestScore) { bestScore = score; chosen = v.anchor; }
                        }
                        chosenLabel = `→ ${best.title} (${best.dist.toFixed(1)} cells)`;
                        L.i(`CASE C: greedy step, best score=${bestScore.toFixed(2)}`);
                    }
                    if (chosen) {
                        const nextTd = chosen.closest('td');
                        drawPath(playerTd, bestTd, best.title, nextTd);
                    }
                }
            } else {
                clearOverlay();
            }

            // Fallback — no targets, click any anchor (prefer open ground)
            if (!chosen) {
                let bestScore = Infinity, pick = null;
                for (const v of landing.values()) {
                    const c = v.abs ? cellAt(v.abs.y, v.abs.x) : 0;
                    if (c < bestScore) { bestScore = c; pick = v.anchor; }
                }
                chosen      = pick || moveAnchors[0];
                chosenLabel = '→ advance (no targets)';
                clearOverlay();
            }

            // remember the move so a refusal can be detected next load
            const chosenLand = [...landing.values()].find(v => v.anchor === chosen);
            if (pAbs && chosenLand && chosenLand.abs) {
                GM_setValue('vtg.lastmove', JSON.stringify({
                    from: pAbs, to: chosenLand.abs, t: Date.now(),
                }));
            }

            // record this load for the next no-progress check
            if (pAbs) {
                hist.push({
                    y: pAbs.y, x: pAbs.x, t: now,
                    title: chosenLabel && usable.length ? usable[0].title : null,
                    dist: usable.length ? usable[0].dist : null,
                });
                while (hist.length > 24) hist.shift();
                GM_setValue('vtg.hist', JSON.stringify(hist));
            }

            // Execute
            state.busy = true;
            L.i(`CLICK: ${chosen.getAttribute('onclick')} | ${chosenLabel}`);

            setTimeout(() => {
                if (state.paused) { state.busy = false; L.d('paused before click — cancelled'); return; }
                try {
                    chosen.click();
                    state.moves++;
                    state.action = chosenLabel;
                    save();
                    patchUI();
                } catch (err) {
                    L.e('click failed:', err);
                    state.status = 'Error';
                    renderUI();
                } finally {
                    state.busy = false;
                }
            }, CONFIG.TIMING.CLICK_DELAY);
        }

        // ── Path redraw interval ───────────────────────────────────────────
        // Redraws path to nearest live target every PATH_REDRAW ms.
        // Starts immediately — if map not ready yet it just finds nothing and returns.
        const pathTimer = setInterval(() => {
            if (state.paused) return;
            const playerImg = document.querySelector(`img[title="${CSS.escape(CONFIG.PLAYER_NAME)}"]`);
            if (!playerImg) return;
            const playerTd = playerImg.closest('td');
            if (!playerTd) return;
            const pPos = gridPos(playerTd);
            if (!pPos) return;

            // Find nearest target
            let nearest = null, nearestDist = Infinity;
            document.querySelectorAll('img').forEach(img => {
                if (!isTarget(img)) return;
                const td = img.closest('td');
                if (!td) return;
                const pos = gridPos(td);
                if (!pos) return;
                const dc = pos.col - pPos.col, dr = pos.row - pPos.row;
                const dist = Math.sqrt(dc * dc + dr * dr);
                if (dist < nearestDist) { nearestDist = dist; nearest = { img, td, dist }; }
            });

            if (!nearest) { clearOverlay(); return; }

            // Find next move-anchor step toward nearest target
            const anchors = findMoveAnchors();

            let nextTd = null, bestRem = Infinity;
            const nPos = gridPos(nearest.td);
            if (nPos) {
                // Check for direct landing first
                for (const anchor of anchors) {
                    const vec = parseOnclick(anchor.getAttribute('onclick'));
                    if (!vec) continue;
                    const lc = pPos.col + vec.dx, lr = pPos.row + vec.dy;
                    if (lc === nPos.col && lr === nPos.row) {
                        nextTd = anchor.closest('td');
                        bestRem = 0;
                        break;
                    }
                    const remDC = nPos.col - lc, remDR = nPos.row - lr;
                    const rem = Math.sqrt(remDC * remDC + remDR * remDR);
                    if (rem < bestRem) { bestRem = rem; nextTd = anchor.closest('td'); }
                }
            }

            drawPath(playerTd, nearest.td, nearest.img.title || '?', nextTd);

        }, CONFIG.TIMING.PATH_REDRAW);

        // ── Teardown (bfcache / unload) ────────────────────────────────────
        let navId = null;
        function cleanup() {
            if (uiTimer)   clearInterval(uiTimer);
            if (pathTimer) clearInterval(pathTimer);
            if (navId)     clearInterval(navId);
            clearOverlay();
        }
        window.addEventListener('pagehide', cleanup);
        window.addEventListener('beforeunload', cleanup);

        // ── Start nav loop ─────────────────────────────────────────────────
        // Wait until the map is truly ready:
        //   1. frmMap form exists
        //   2. Player img is present
        //   3. At least one move anchor is present
        // Poll every 500ms until all three are true, then start the nav loop.
        // This prevents the script from firing on a half-loaded page and
        // clicking random anchors before targets are visible.
        const readyStart = Date.now();
        (function waitForReady() {
            const ready =
                !!document.getElementById('frmMap') &&
                !!document.querySelector(`img[title="${CSS.escape(CONFIG.PLAYER_NAME)}"]`) &&
                findMoveAnchors().length > 0;

            if (!ready) {
                if (Date.now() - readyStart > 60000) { L.w('map never became ready — giving up'); return; }
                L.d('page not ready yet — waiting...');
                setTimeout(waitForReady, 500);
                return;
            }

            L.i('page ready — starting nav loop');
            navigate();

            const go   = () => { if (!navId) { navId = setInterval(navigate, CONFIG.TIMING.CHECK_INTERVAL); L.i('nav interval started'); } };
            const stop = () => { if (navId) { clearInterval(navId); navId = null; L.i('nav interval paused'); } };
            document.addEventListener('visibilitychange', () => document.hidden ? stop() : go());
            if (!document.hidden) go();
        })();
    }

    // =====================================================================
    // ── B)  SHOWGAME.PHP / SHOWRESULT.PHP — Close manager ─────────────────
    // =====================================================================
    // showgame.php:   outer frameset. frames[1] = play.php (live game).
    // showresult.php: static result page. No form, no onclick at all.
    //
    // Logic (same as the original Close script, just with polling):
    //   frames[1] has move anchors (or "Click to move" orbs) → still running → reload
    //   frames[1] has neither                                 → game over     → close
    // =====================================================================
    function runCloser() {
        L.i('Close manager starting');
        injectUpgradeCsp();
        upgradeInsecureUrls();

        let settled     = false;
        let pollId      = null;
        let deadlineId  = null;
        let closeTimer  = null;
        const startedAt = performance.now();

        function cleanup() {
            if (pollId)     { clearInterval(pollId);    pollId     = null; }
            if (deadlineId) { clearTimeout(deadlineId); deadlineId = null; }
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        }

        function settleReload() {
            if (settled) return;
            if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
            settled = true;
            cleanup();
            L.i('settle: reload');
            location.reload();
        }

        // Game over — give the result page time to render and the user time to
        // see it before closing. Keep polling during the delay so a revived
        // game cancels the close.
        function settleClose() {
            if (settled || closeTimer) return;
            L.i(`game over — closing in ${CONFIG.TIMING.CLOSE_DELAY_MS / 1000}s (re-checks active)`);
            closeTimer = setTimeout(() => {
                closeTimer = null;
                if (settled) return;
                settled = true;
                cleanup();
                L.i('closing window');
                window.close();
            }, CONFIG.TIMING.CLOSE_DELAY_MS);
        }

        function evaluate() {
            if (settled) return true;
            try {
                const fw = window.frames[1];
                if (!fw) { L.d('frames[1] not present'); return false; }
                const doc = fw.document;
                if (!doc || doc.readyState === 'loading') { L.d('frame loading'); return false; }
                // v14.2+: occupied cells render the occupant's own <img> inside
                // the move anchor, so "Click to move" orbs are NOT guaranteed
                // while the game is still running. Treat any move anchor (by
                // onclick) as the authoritative "still playing" signal.
                const hasOrbs  = !!doc.querySelector("img[title*='Click to move']");
                const hasMoves = !!doc.querySelector("a[onclick*='move('], a[onclick*='moveUser(']");
                const playing  = hasOrbs || hasMoves;
                L.i('hasOrbs:', hasOrbs, 'hasMoves:', hasMoves);
                playing ? settleReload() : settleClose();
                return true;
            } catch (e) {
                L.w('frame access error:', e.name);
                return false;
            }
        }

        pollId = setInterval(() => {
            if (performance.now() - startedAt < CONFIG.TIMING.CLOSE_MIN_WAIT) return;
            evaluate();
        }, CONFIG.TIMING.CLOSE_POLL);

        deadlineId = setTimeout(() => {
            if (!settled) {
                L.w('deadline reached');
                if (closeTimer) return;
                if (!evaluate()) settleReload();
            }
        }, CONFIG.TIMING.CLOSE_MAX_WAIT);
    }

    // =====================================================================
    // ── C)  PRIZE PAGE (fc_loginad_showh.php) — Auto-click the link ──────
    // =====================================================================
    // This function runs only on the prize page. It detects the presence of
    // the link "Open VTG prize page" and clicks it once. If the link is not
    // found within a reasonable time, it reloads the page.
    function runPrizePage() {
        L.i('Prize page manager started');
        let found = false;
        let interval = null;

        const getReloads = () => { try { return parseInt(sessionStorage.getItem('vtg_prize_reloads'), 10) || 0; } catch { return 0; } };
        const setReloads = n => { try { sessionStorage.setItem('vtg_prize_reloads', String(n)); } catch {} };

        const checkLink = () => {
            if (found) return;
            // Look for the link that points to showgame.php inside the timer div
            const link = document.querySelector('div#timer a[href*="showgame.php"]');
            if (link) {
                found = true;
                if (interval) clearInterval(interval);
                L.i('Prize link found – navigating to showgame.php');
                // Navigate using top to respect target="_top"
                window.top.location.href = link.href;
            }
        };

        // Check immediately and then every 500ms until found
        checkLink();
        interval = setInterval(checkLink, 500);

        // Safety timeout: stop polling after 30 seconds
        setTimeout(() => {
            if (interval) clearInterval(interval);
            if (found) return;
            const n = getReloads() + 1;
            if (n > 3) { L.w('Prize link never appeared – stopping'); return; }
            setReloads(n);
            L.w('Prize link not found within 30s – reloading page');
            location.reload();
        }, 30000);
    }

    // =====================================================================
    // ENTRY POINT
    // =====================================================================
    const url = window.location.href;

    if (url.includes('/vtg/play.php')) {
        document.readyState === 'loading'
            ? document.addEventListener('DOMContentLoaded', runNavigator, { once: true })
            : runNavigator();

    } else if (url.includes('/vtg/showgame.php')) {
        // Outer frameset — use frames[1] to detect if game is still running
        window.addEventListener('load', runCloser, { once: true });

    } else if (url.includes('/vtg/showresult.php')) {
        // Result page — wait for it to finish loading, give the user a few
        // seconds to see it, then close the tab.
        function closeAfterDelay() {
            const start = Date.now();
            const tryClose = () => {
                if (document.readyState === 'complete') {
                    L.i(`result loaded — closing in ${CONFIG.TIMING.CLOSE_DELAY_MS / 1000}s`);
                    setTimeout(() => {
                        try { window.top.close(); } catch (e) { window.close(); }
                    }, CONFIG.TIMING.CLOSE_DELAY_MS);
                } else if (Date.now() - start >= CONFIG.TIMING.CLOSE_LOAD_TIMEOUT_MS) {
                    L.w('result load timeout — closing');
                    try { window.top.close(); } catch (e) { window.close(); }
                } else {
                    setTimeout(tryClose, 250);
                }
            };
            tryClose();
        }
        if (document.readyState === 'complete') {
            closeAfterDelay();
        } else {
            window.addEventListener('load', closeAfterDelay, { once: true });
        }

    } else if (url.includes('/fc_loginad_showh.php')) {
        // NEW: handle the prize page — run only once when the page loads
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', runPrizePage, { once: true });
        } else {
            runPrizePage();
        }
    }
})();