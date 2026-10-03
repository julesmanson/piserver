const vscode = require('vscode');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// ---------------------------------------------------------------------------
// Statusbar layout — 6 items, right-aligned, priority 148000-148005:
//
//   2n|2n  ◯  ◯  «2n» display «2n»  icon «1n» label  2n|2n
//
// marginLeft/marginRight are dedicated, static, non-interactive items that
// exist only to hold the outer margins — content items (LEDs, display,
// button) never carry margin text themselves, so their .text can be set
// per-state without re-stitching whitespace into every state string. Each
// margin item is itself split: 2n margin, a literal "|", 2n padding (mirrored
// on the right) — not a single flat 4n block anymore.
//
// Two separate LED items (ledPython, ledServer) so each gets its own .color.
// Both always show the same $(piserver-led) glyph (a single monochrome dot
// from centerdot.woff) — color, not glyph choice, is what distinguishes
// blue/green/red/grey at runtime.
// ---------------------------------------------------------------------------

let pollTimer = null;
let cycleTimer = null;
let isRunning = false;
let heads = [];       // [{ key, host, port, projectName, online }], 1-3 entries
let primary = null;   // heads[0] — the one head Start/Stop and the lock target
let cycleIndex = 0;
let marginLeft, ledPython, ledServer, lcdItem, actionBtn, marginRight;
let pythonRunningColor, serverRunningColor, offlineColor;
let displayBackgroundColor, displayFontColor;
let displayWidth;  // fixed content width (chars) the LCD display pads out to

// Color used for the dim end of the cycling display's pseudo-fade — the
// text itself hard-swaps between heads (StatusBarItem has no real opacity),
// but swapping it right at the dimmest color step hides the cut reasonably well.
const DIM_COLOR = '#8b949e';
const FADE_MS = 375;
const HOLD_MS = 1000;
const FADE_STEP_MS = 60;

// VSCode only lets extensions pick a StatusBarItem background from these
// four built-in ThemeColors — no arbitrary custom background (e.g. black)
// is possible through the public API.
const DISPLAY_BG_THEME_COLORS = {
    error:   'statusBarItem.errorBackground',
    warning: 'statusBarItem.warningBackground',
    remote:  'statusBarItem.remoteBackground',
    offline: 'statusBarItem.offlineBackground'
};

// Spacing constants — built from NBSP (U+00A0), not regular spaces: regular
// spaces collapse when rendered; NBSP does not, so each one renders as a
// real, distinct ~n-width space.
const SPACE    = ' ';
// Left: 2n margin | 2n padding. Right: 2n padding | 2n margin. The pipe is a
// literal keyboard '|' -- a visible divider between the outer margin and the
// inner padding, not another spacing character.
const L_MARGIN = SPACE.repeat(2) + '|' + SPACE.repeat(2);  // margin | padding
const D_PAD    = SPACE.repeat(2);  // padding each side of display text (~2n)
const R_MARGIN = SPACE.repeat(2) + '|' + SPACE.repeat(2);  // padding | margin
const BTN_GAP  = SPACE.repeat(2);  // between button icon and label (~1n)

// LCD display messages — padded (with trailing SPACE) to a shared fixed
// width so the item doesn't visibly resize as it cycles between states.
const CHECKING_MSG = 'checking…';
const OFFLINE_MSG  = 'server offline';
const SHUTDOWN_MSG = 'shutting down…';

function padToDisplayWidth(msg) {
    const gap = displayWidth - msg.length;
    return gap > 0 ? msg + SPACE.repeat(gap) : msg;
}

function activate(context) {
    const cfg  = vscode.workspace.getConfiguration('piserver');
    pythonRunningColor = cfg.get('pythonRunningColor', '#3776AB');  // Python.org brand blue
    serverRunningColor = cfg.get('serverRunningColor', '#FFD43B');  // Python.org brand yellow
    offlineColor      = cfg.get('offlineColor', '#880808');
    displayFontColor  = cfg.get('displayFontColor', '#3776AB');
    const bgChoice = cfg.get('displayBackgroundColor', 'default');
    displayBackgroundColor = DISPLAY_BG_THEME_COLORS[bgChoice]
        ? new vscode.ThemeColor(DISPLAY_BG_THEME_COLORS[bgChoice])
        : undefined;

    heads = loadHeadsFromPiConfig();
    if (!heads || heads.length === 0) {
        // No pi-config.json "urls" section found anywhere in the workspace —
        // fall back to the pre-multi-head VS Code settings, single head,
        // original "host: port" text, no cycling.
        heads = [{ key: 'legacy', host: cfg.get('host', 'localhost'), port: cfg.get('port', 8000), projectName: '' }];
    }
    heads.forEach(h => { h.online = false; });
    primary = heads[0];

    // Fixed display width = length of the longest of the possible messages,
    // across every head's own display text.
    displayWidth = Math.max(
        ...heads.map(h => headDisplayText(h).length),
        CHECKING_MSG.length,
        OFFLINE_MSG.length,
        SHUTDOWN_MSG.length
    );

    // Higher priority = further LEFT in the right zone.
    // 148000-148005 is a deliberately oddball 6-figure range, chosen so no
    // other extension is realistically already sitting on these exact
    // numbers — far outranks VS Code's own built-ins (all <=101) too.
    // VSCode's natural inter-item gap provides the 2n spacing between them.
    marginLeft  = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 148005);
    ledPython   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 148004);
    ledServer   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 148003);
    lcdItem     = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 148002);
    actionBtn   = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 148001);
    marginRight = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 148000);

    ledPython.tooltip = 'Python — PiServer process';
    ledServer.tooltip = 'HTTP server — PiServer response';
    actionBtn.command = 'piserver.toggleServer';

    // Static outer margins — set once, never touched by the state renderers.
    marginLeft.text  = L_MARGIN;
    marginRight.text = R_MARGIN;

    marginLeft.show();
    ledPython.show();
    ledServer.show();
    lcdItem.show();
    actionBtn.show();
    marginRight.show();

    context.subscriptions.push(
        marginLeft, ledPython, ledServer, lcdItem, actionBtn, marginRight,
        vscode.commands.registerCommand('piserver.toggleServer', () => toggle(primary.host, primary.port))
    );

    setChecking();
    pollAll();
    pollTimer = setInterval(pollAll, 3000);
    context.subscriptions.push({ dispose: () => { clearInterval(pollTimer); if (cycleTimer) clearInterval(cycleTimer); } });
}

// ---------------------------------------------------------------------------
// State renderers
// ---------------------------------------------------------------------------
const LED = '$(piserver-led)';

function setChecking() {
    ledPython.text  = LED;  ledPython.color = '#8b949e';
    ledServer.text  = LED;  ledServer.color = '#8b949e';
    lcdItem.text    = `${D_PAD}${padToDisplayWidth(CHECKING_MSG)}${D_PAD}`;
    lcdItem.color   = '#8b949e';
    lcdItem.backgroundColor = undefined;
    actionBtn.text  = '';
    actionBtn.tooltip = '';
}

// Text for one head's display frame. The legacy single-head fallback (no
// project-name) keeps the original "host: port" wording; named heads show
// "port — project-name" since the host is almost always identical across
// heads and would just be repeated noise on every cycle.
function headDisplayText(h) {
    return h.projectName ? `${h.port} — ${h.projectName}` : `${h.host}: ${h.port}`;
}

function renderRunningFrame() {
    isRunning = true;
    ledPython.text = LED;  ledPython.color = pythonRunningColor;
    ledServer.text = LED;  ledServer.color = serverRunningColor;
    const current = heads[cycleIndex] || heads[0];
    lcdItem.text  = `${D_PAD}${padToDisplayWidth(headDisplayText(current))}${D_PAD}`;
    lcdItem.color = displayFontColor;
    lcdItem.backgroundColor = displayBackgroundColor;
    actionBtn.text = `$(debug-stop)${BTN_GAP}Stop`;
    actionBtn.tooltip = 'Stop PiServer';
}

function setOffline() {
    isRunning = false;
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    ledPython.text  = LED;  ledPython.color = offlineColor;
    ledServer.text  = LED;  ledServer.color = offlineColor;
    lcdItem.text    = `${D_PAD}${padToDisplayWidth(OFFLINE_MSG)}${D_PAD}`;
    lcdItem.color   = '#8b949e';
    lcdItem.backgroundColor = undefined;
    actionBtn.text  = `$(play)${BTN_GAP}Start`;
    actionBtn.tooltip = 'Start PiServer in a terminal';
}

// ---------------------------------------------------------------------------
// Multi-head cycling display — a crude pseudo-fade via color steps, since
// StatusBarItem has no real opacity/transition. Text hard-swaps at the
// dimmest point of the cycle, which is the least jarring moment to do it.
// Only runs with >1 active head; a single head just renders statically.
// ---------------------------------------------------------------------------
function lerpColor(hexA, hexB, t) {
    const a = parseInt(hexA.slice(1), 16), b = parseInt(hexB.slice(1), 16);
    const ch = (hex, shift) => (hex >> shift) & 0xff;
    const mix = shift => Math.round(ch(a, shift) + (ch(b, shift) - ch(a, shift)) * t);
    return `#${[16, 8, 0].map(shift => mix(shift).toString(16).padStart(2, '0')).join('')}`;
}

function runCycleFrame() {
    renderRunningFrame();
    lcdItem.color = DIM_COLOR;
    let elapsed = 0;
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = setInterval(() => {
        if (!isRunning || !vscode.window.state.focused) return;  // pause in place
        elapsed += FADE_STEP_MS;
        if (elapsed < FADE_MS) {
            lcdItem.color = lerpColor(DIM_COLOR, displayFontColor, elapsed / FADE_MS);
        } else if (elapsed < FADE_MS + HOLD_MS) {
            lcdItem.color = displayFontColor;
        } else if (elapsed < 2 * FADE_MS + HOLD_MS) {
            lcdItem.color = lerpColor(displayFontColor, DIM_COLOR, (elapsed - FADE_MS - HOLD_MS) / FADE_MS);
        } else {
            clearInterval(cycleTimer);
            cycleIndex = (cycleIndex + 1) % heads.length;
            runCycleFrame();
        }
    }, FADE_STEP_MS);
}

// ---------------------------------------------------------------------------
// Poll — every active head, independently, each tick.
// ---------------------------------------------------------------------------
function pollOne(h) {
    return new Promise(resolve => {
        const req = http.get({ hostname: h.host, port: h.port, path: '/', timeout: 2000 }, res => {
            h.online = res.statusCode >= 200 && res.statusCode < 400;
            res.resume();
            resolve();
        });
        req.on('error',   () => { h.online = false; resolve(); });
        req.on('timeout', () => { req.destroy(); h.online = false; resolve(); });
    });
}

function pollAll() {
    Promise.all(heads.map(pollOne)).then(() => {
        const anyOnline = heads.some(h => h.online);
        if (!anyOnline) {
            setOffline();
            return;
        }
        const wasRunning = isRunning;
        isRunning = true;
        if (heads.length > 1) {
            if (!wasRunning) { cycleIndex = 0; runCycleFrame(); }
            // else: the in-flight cycle animation already owns text/color.
        } else {
            renderRunningFrame();
        }
    });
}

// ---------------------------------------------------------------------------
// Toggle stop / start
// ---------------------------------------------------------------------------
function toggle(host, port) {
    if (isRunning) stopServer(host, port);
    else           startServer().catch(err => vscode.window.showErrorMessage(`PiServer: ${err.message}`));
}

function stopServer(host, port) {
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    lcdItem.text  = `${D_PAD}${padToDisplayWidth(SHUTDOWN_MSG)}${D_PAD}`;
    lcdItem.color  = '#8b949e';
    lcdItem.backgroundColor = undefined;
    actionBtn.text = '';

    const body = '{}';
    const req  = http.request(
        {
            hostname: host, port,
            path: '/shutdown', method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        },
        res => res.resume()
    );
    req.on('error', () => {});
    req.end(body);

    setTimeout(() => doPoll(host, port), 1000);
}

// Directory names skipped during auto-search — either huge, irrelevant, or
// both (OS/package trees we'd never find a project's piserver.py inside).
const SEARCH_SKIP_DIRS = new Set([
    'node_modules', '.git', '.vscode', 'appdata', '$recycle.bin',
    'system volume information', 'program files', 'program files (x86)',
    'windows', 'venv', '.venv', 'site-packages', '__pycache__', 'vsix'
]);
const SEARCH_MAX_DEPTH = 10;
const SEARCH_TIME_BUDGET_MS = 15000;

function readPiConfig(dir) {
    const configPath = path.join(dir, 'pi-config.json');
    if (!fs.existsSync(configPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return null;
    }
}

// Resolves pi-config.json's "urls" block into 1-3 head objects, mirroring
// piserver.py's resolve_heads(): url2/url3 inherit host from url1 if
// omitted, port defaults to url1.port + index (never copied verbatim —
// two heads can't share a host:port), and active defaults to true for
// url1 / false for url2 and url3. project-name is never inherited; a head
// without one is dropped since there's nothing to display or dial.
function resolveHeadsFromUrlsConfig(urlsCfg) {
    const url1 = urlsCfg.url1 || {};
    const baseHost = url1.host || 'localhost';
    const basePort = url1.port !== undefined ? url1.port : 8000;

    return ['url1', 'url2', 'url3'].map((key, i) => {
        const cfg = urlsCfg[key] || {};
        const active = cfg.active !== undefined ? !!cfg.active : key === 'url1';
        return {
            key,
            active,
            host: cfg.host || baseHost,
            port: cfg.port !== undefined ? cfg.port : basePort + i,
            projectName: cfg['project-name'] || ''
        };
    }).filter(h => h.active && h.projectName);
}

// Looks for pi-config.json at the root of each workspace folder and resolves
// its "urls" block. Returns null (not []) when no pi-config.json with a
// "urls" section exists anywhere, so the caller can fall back to the
// pre-multi-head legacy behavior instead of silently showing nothing.
function loadHeadsFromPiConfig() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return null;
    for (const f of folders) {
        const config = readPiConfig(f.uri.fsPath);
        if (config && config.urls) return resolveHeadsFromUrlsConfig(config.urls);
    }
    return null;
}

// Looks for pi-config.json at the root of each workspace folder and reads
// its "path-to-server" key — the project's own record of where piserver.py
// lives, kept alongside the project instead of in VS Code's global Settings.
function findScriptPathFromPiConfig() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return null;
    for (const f of folders) {
        const config = readPiConfig(f.uri.fsPath);
        const candidate = config && config['path-to-server'];
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return null;
}

// Interpreter used to actually launch piserver.py — a different concern
// from locating it. Explicit VS Code setting wins; otherwise read
// "path-to-python" from the pi-config.json next to the resolved script;
// otherwise fall back to whatever "python" resolves to on PATH.
function resolvePythonPath(scriptPath) {
    const configured = vscode.workspace.getConfiguration('piserver').get('pythonPath', '').trim();
    if (configured) return configured;
    const config = readPiConfig(path.dirname(scriptPath));
    const fromConfig = config && config['path-to-python'];
    return (fromConfig && String(fromConfig).trim()) || 'python';
}

// Self-heal: write the just-discovered location back to both places the
// extension reads from, so this search never has to run again for this move.
function persistDiscoveredScriptPath(foundPath) {
    const dir = path.dirname(foundPath);
    const configPath = path.join(dir, 'pi-config.json');
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config['path-to-server'] = foundPath;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf8');
        } catch {
            // Leave pi-config.json untouched if it's malformed; the
            // scriptPath setting below still gets saved.
        }
    }
    vscode.workspace.getConfiguration('piserver')
        .update('scriptPath', foundPath, vscode.ConfigurationTarget.Global);
}

// Bounded, cancellable filesystem walk for piserver.py — last resort, only
// run once the fast lookups (setting, pi-config.json, workspace root) miss.
async function searchForScriptPath() {
    const extraRoots = vscode.workspace.getConfiguration('piserver').get('searchRoots', []);
    const roots = (extraRoots && extraRoots.length) ? extraRoots : [os.homedir()];
    const matches = [];

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'PiServer: searching for piserver.py…',
            cancellable: true
        },
        async (_progress, token) => {
            const start = Date.now();
            const queue = roots.map(r => ({ dir: r, depth: 0 }));

            while (queue.length) {
                if (token.isCancellationRequested) return;
                if (Date.now() - start > SEARCH_TIME_BUDGET_MS) return;

                const { dir, depth } = queue.shift();
                let entries;
                try {
                    entries = await fs.promises.readdir(dir, { withFileTypes: true });
                } catch {
                    continue;
                }

                for (const entry of entries) {
                    if (entry.isFile() && entry.name === 'piserver.py') {
                        matches.push(path.join(dir, entry.name));
                    } else if (entry.isDirectory() && depth < SEARCH_MAX_DEPTH
                        && !SEARCH_SKIP_DIRS.has(entry.name.toLowerCase())) {
                        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
                    }
                }
            }
        }
    );

    return matches;
}

async function resolveScriptPath() {
    // Three fast, explicit fallbacks before resorting to a filesystem search:
    //   1. piserver.scriptPath VS Code setting — deliberate per-machine override.
    //   2. pi-config.json's "path-to-server" — travels with the project itself.
    //   3. piserver.py directly at a workspace folder's root — original auto-detect.
    const configuredPath = vscode.workspace.getConfiguration('piserver').get('scriptPath', '').trim();
    if (configuredPath) {
        if (fs.existsSync(configuredPath)) return configuredPath;
        vscode.window.showWarningMessage(
            `PiServer: the configured piserver.scriptPath ("${configuredPath}") does not exist. Update it in Settings or clear it to fall back to pi-config.json / auto-detect.`
        );
        return null;
    }

    const fromConfig = findScriptPathFromPiConfig();
    if (fromConfig) return fromConfig;

    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const f of folders) {
            const candidate = path.join(f.uri.fsPath, 'piserver.py');
            if (fs.existsSync(candidate)) return candidate;
        }
    }

    // Last resort: search, then self-heal so this only ever happens once per move.
    const matches = await searchForScriptPath();
    if (matches.length === 0) {
        vscode.window.showWarningMessage(
            'PiServer: could not find piserver.py anywhere under your user folder. Add "path-to-server" to pi-config.json, or set piserver.scriptPath in Settings.'
        );
        return null;
    }

    let found = matches[0];
    if (matches.length > 1) {
        found = await vscode.window.showQuickPick(matches, {
            placeHolder: 'Multiple copies of piserver.py found — pick the one to use'
        });
        if (!found) return null;
    }

    persistDiscoveredScriptPath(found);
    vscode.window.showInformationMessage(`PiServer: found piserver.py at ${found} — saved for next time.`);
    return found;
}

async function startServer() {
    const scriptPath = await resolveScriptPath();
    if (!scriptPath) return;

    const pythonPath = resolvePythonPath(scriptPath);
    const terminal = vscode.window.createTerminal({
        name: 'PiServer',
        cwd:  path.dirname(scriptPath)
    });
    terminal.sendText(`"${pythonPath}" "${scriptPath}"`);
    terminal.show(false);
}

function deactivate() {
    clearInterval(pollTimer);
}

module.exports = { activate, deactivate };
