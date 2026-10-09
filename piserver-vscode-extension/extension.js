const vscode = require('vscode');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

// ---------------------------------------------------------------------------
// Statusbar layout — 6 items, right-aligned, priority 148000-148005:
//   2n|2n  ◯  ◯  «2n» display «2n»  icon «1n» label  2n|2n
//
// marginLeft/marginRight hold the outer margins so content items (LEDs,
// display, button) never carry margin text themselves — their .text can
// change per-state without re-stitching whitespace each time.
//
// ledPython/ledServer are separate items so each gets its own .color; both
// show the same $(piserver-led) glyph, distinguished only by color.
// ---------------------------------------------------------------------------

let pollTimer = null;
let cycleTimer = null;
let isRunning = false;
let heads = [];       // [{ key, host, port, projectName, online }], 1-3 entries
let primary = null;   // heads[0] — the one head Start/Stop and the lock target
let cycleIndex = 0;
let marginLeft, ledPython, ledServer, lcdItem, actionBtn, marginRight;
let pythonRunningColor, serverRunningColor, offlineColor;
let displayBackgroundColor, displayFontColor, blankColor;
let displayWidth;  // fixed content width (chars) the LCD display pads out to

// Dim end of the cycling pseudo-fade — text hard-swaps at the dimmest step
// since StatusBarItem has no real opacity, hiding the cut reasonably well.
const DIM_COLOR = '#8b949e';
const FADE_MS = 400;
const HOLD_MS = 3000;
const BLANK_MS = 200;
const FADE_STEP_MS = 60;

// VSCode only allows these 4 built-in ThemeColors for a StatusBarItem
// background — no arbitrary custom color (e.g. black) via the public API.
const DISPLAY_BG_THEME_COLORS = {
    error:   'statusBarItem.errorBackground',
    warning: 'statusBarItem.warningBackground',
    remote:  'statusBarItem.remoteBackground',
    offline: 'statusBarItem.offlineBackground'
};

// NBSP (U+00A0), not regular space — regular spaces collapse when rendered.
const SPACE    = ' ';
// Pipe is a literal visible divider between outer margin and inner padding.
const L_MARGIN = SPACE.repeat(2) + '|' + SPACE.repeat(2);  // margin | padding
const D_PAD    = SPACE.repeat(4);  // padding each side of display text
const R_MARGIN = SPACE.repeat(2) + '|' + SPACE.repeat(2);  // padding | margin
const BTN_GAP  = SPACE.repeat(2);  // between button icon and label

// LCD display messages — padded (with trailing SPACE) to a shared fixed
// width so the item doesn't visibly resize as it cycles between states.
const CHECKING_MSG = 'checking…';
const OFFLINE_MSG  = 'server offline';
const SHUTDOWN_MSG = 'shutting down…';

// NBSP renders narrower than real glyphs in the statusbar font, so padding
// by the raw character-count gap under-fills shorter messages — a few-char
// name difference between heads visibly "jerks" on cycling. Overpadding by
// this factor approximates equal pixel width instead of equal char count.
// Empirical starting point — nudge if still visibly short/long.
const NBSP_WIDTH_COMPENSATION = 1.4;

function padToDisplayWidth(msg) {
    if (msg.length > displayWidth) return msg.slice(0, displayWidth);
    const gap = displayWidth - msg.length;
    return gap > 0 ? msg + SPACE.repeat(Math.round(gap * NBSP_WIDTH_COMPENSATION)) : msg;
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
    // Color to blend text into whatever lcdItem's actual background is —
    // same ThemeColor if one's configured, else the statusbar's own default.
    blankColor = displayBackgroundColor || new vscode.ThemeColor('statusBar.background');

    heads = loadHeadsFromPiConfig();
    if (!heads || heads.length === 0) {
        // No pi-config.json "body" section found anywhere in the workspace —
        // fall back to the pre-multi-head VS Code settings, single head,
        // original "host: port" text, no cycling.
        heads = [{ key: 'legacy', host: cfg.get('host', 'localhost'), port: cfg.get('port', 8000), projectName: '' }];
    }
    heads.forEach(h => { h.online = false; });
    primary = heads[0];

    // Hardcoded to today's longest head ("127.0.0.1:8003 - PiServer Mock").
    // Anything longer than this gets truncated in padToDisplayWidth() rather
    // than resizing the item — update this if a head's text ever grows past it.
    displayWidth = 30;

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
    lcdItem.tooltip = 'Click to copy this head\'s URL';
    lcdItem.command = 'piserver.copyCurrentHeadUrl';

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
        vscode.commands.registerCommand('piserver.toggleServer', () => toggle(primary.host, primary.port)),
        vscode.commands.registerCommand('piserver.copyCurrentHeadUrl', copyCurrentHeadUrl)
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

// Text for one head's display frame. project-name is optional on any head
// (legacy single-head fallback included) — no name falls back to plain
// "host: port"; a named head shows "host:port - name" instead.
function headDisplayText(h) {
    return h.projectName ? `${h.host}:${h.port} - ${h.projectName}` : `${h.host}: ${h.port}`;
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
// Multi-head cycling display — pseudo-fade via color steps (no real opacity
// API). Text hard-swaps at the dimmest point, the least jarring moment.
// Only runs with >1 active head; one head renders statically.
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
    // Wall-clock-driven, not tick-counted: pollAll()'s HTTP round-trips can
    // delay this interval, letting several ticks fire in a burst. Tracking
    // real elapsed time (not an assumed FADE_STEP_MS per tick) keeps a
    // burst from phantom-jumping the phase forward.
    let lastTick = Date.now();
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = setInterval(() => {
        const now = Date.now();
        const delta = now - lastTick;
        lastTick = now;
        if (!isRunning || !vscode.window.state.focused) return;  // pause in place
        elapsed += delta;
        if (elapsed < FADE_MS) {
            lcdItem.color = lerpColor(DIM_COLOR, displayFontColor, elapsed / FADE_MS);
        } else if (elapsed < FADE_MS + HOLD_MS) {
            lcdItem.color = displayFontColor;
        } else if (elapsed < 2 * FADE_MS + HOLD_MS) {
            lcdItem.color = lerpColor(displayFontColor, DIM_COLOR, (elapsed - FADE_MS - HOLD_MS) / FADE_MS);
        } else if (elapsed < 2 * FADE_MS + HOLD_MS + BLANK_MS) {
            // Text is left exactly as fade-out's last frame — only the color
            // changes, to match lcdItem's own background, so it visually
            // disappears without the string (and thus its width) ever
            // changing shape. NBSP padding alone (tried first) rendered
            // ~30% narrower than real glyphs in the statusbar font, so an
            // all-NBSP "blank" string visibly shrank the item.
            lcdItem.color = blankColor;
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

// Copies the currently-displayed head's URL (http:// included — never shown
// in the LCD text itself) to the clipboard, so it can be pasted straight
// into a browser's address bar.
function copyCurrentHeadUrl() {
    if (!isRunning) {
        vscode.window.setStatusBarMessage('PiServer: offline — nothing to copy.', 3000);
        return;
    }
    const current = heads[cycleIndex] || heads[0];
    const url = `http://${current.host}:${current.port}`;
    vscode.env.clipboard.writeText(url);
    vscode.window.setStatusBarMessage(`PiServer: copied ${url}`, 3000);
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

// Resolves pi-config.json's "body" block, mirroring piserver.py's
// resolve_heads() — host/port/webroot required per active head, no
// inheritance/defaulting; project-name optional/cosmetic. A head missing
// a field, or duplicating another's host:port, is dropped with a named
// warning, kept in sync with main()'s two validation layers.
function resolveHeadsFromBodyConfig(bodyCfg) {
    const seen = new Map();
    const heads = [];

    for (const key of ['head1', 'head2', 'head3']) {
        const cfg = bodyCfg[key] || {};
        const active = cfg.active !== undefined ? !!cfg.active : key === 'head1';
        if (!active) continue;

        const missing = ['host', 'port', 'webroot'].filter(k => !cfg[k]);
        if (missing.length) {
            vscode.window.showWarningMessage(
                `PiServer: ${key} is active but missing required ${missing.join(' and ')} in pi-config.json — skipping that head.`
            );
            continue;
        }

        const binding = `${cfg.host}:${cfg.port}`;
        if (seen.has(binding)) {
            vscode.window.showWarningMessage(
                `PiServer: ${key} and ${seen.get(binding)} both specify ${binding} in pi-config.json — skipping ${key}.`
            );
            continue;
        }
        seen.set(binding, key);

        heads.push({
            key,
            host: cfg.host,
            port: cfg.port,
            projectName: cfg['project-name'] || ''
        });
    }

    return heads;
}

// Finds pi-config.json's directory independent of whatever workspace is
// open — mirrors resolveScriptPath()'s global-setting-first approach,
// since the file always lives next to piserver.py (BASE_DIR in piserver.py).
// Workspace-folder scanning is just the fallback for before that setting
// has ever been populated.
function findPiConfigDir() {
    const configuredScript = vscode.workspace.getConfiguration('piserver').get('scriptPath', '').trim();
    if (configuredScript && fs.existsSync(configuredScript)) {
        return path.dirname(configuredScript);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
        for (const f of folders) {
            if (fs.existsSync(path.join(f.uri.fsPath, 'pi-config.json'))) {
                return f.uri.fsPath;
            }
        }
    }
    return null;
}

// Resolves pi-config.json's "body" block from wherever findPiConfigDir()
// locates it. Returns null (not []) when none exists, so the caller falls
// back to pre-multi-head legacy behavior instead of showing nothing.
function loadHeadsFromPiConfig() {
    const dir = findPiConfigDir();
    if (!dir) return null;
    const config = readPiConfig(dir);
    if (config && config.body) return resolveHeadsFromBodyConfig(config.body);
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

// Interpreter to launch piserver.py with (separate from locating the
// script). Setting wins, then pi-config.json's "path-to-python", then
// plain "python" on PATH.
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

// PowerShell parses a line starting with a quoted string as an expression,
// not an invocation — a second quoted token (the script path) right after
// becomes a parse error. "&" (call operator) forces expression-mode; cmd.exe
// and POSIX shells don't need it.
function buildLaunchCommand(pythonPath, scriptPath) {
    const shell = (vscode.env.shell || '').toLowerCase();
    const isPowerShell = shell.includes('powershell') || shell.includes('pwsh');
    const cmd = `"${pythonPath}" "${scriptPath}"`;
    return isPowerShell ? `& ${cmd}` : cmd;
}

async function startServer() {
    const scriptPath = await resolveScriptPath();
    if (!scriptPath) return;

    const pythonPath = resolvePythonPath(scriptPath);
    const terminal = vscode.window.createTerminal({
        name: 'PiServer',
        cwd:  path.dirname(scriptPath)
    });
    terminal.sendText(buildLaunchCommand(pythonPath, scriptPath));
    terminal.show(false);
}

function deactivate() {
    clearInterval(pollTimer);
}

module.exports = { activate, deactivate };
