/**
 * mock-orchestrator.js
 * --------------------
 * Drives all test panels in index.html.
 * Imports logger.js so the logger auto-activates and catches spoofed events.
 */

import { logEvent, config_server } from "./logger.js";

// ---------------------------------------------------------------------------
// Config — directory toggle: creates dir + files if absent, deletes all if present
// ---------------------------------------------------------------------------
const config_dir_toggle = {
    relative_path: "mockproject/assets/SERVER-MAKE-DELETE",
    files:         ["DELETEME.LOG", "DELETEME.TXT"]
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setStatus(id, cls, text) {
    const el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = "status " + cls; }
}

function logUrl(filename, relativePath) {
    const params = new URLSearchParams({ filename, relative_path: relativePath });
    return `/log?${params}`;
}

// ---------------------------------------------------------------------------
// Column 1 — Server status
// ---------------------------------------------------------------------------
function setBarServer(ok) {
    const dot   = document.getElementById("bar-dot");
    const label = document.getElementById("bar-label");
    if (!dot || !label) return;
    dot.className   = "bar-dot " + (ok ? "ok" : "fail");
    label.textContent = ok ? "localhost:8000" : "offline";
}

async function checkServerStatus() {
    try {
        const r = await fetch("/", { signal: AbortSignal.timeout(2000) });
        setStatus("status-server", r.ok ? "ok" : "fail",
            r.ok ? "PiServer running — localhost:8000" : `PiServer returned ${r.status}`);
        setBarServer(r.ok);
    } catch (_) {
        setStatus("status-server", "fail", "PiServer not reachable");
        setBarServer(false);
    }
}

async function checkPythonStatus() {
    try {
        const r = await fetch("/", { signal: AbortSignal.timeout(2000) });
        setStatus("status-python", r.ok ? "ok" : "fail",
            r.ok ? "Python running — powers PiServer" : `returned ${r.status}`);
    } catch (_) {
        setStatus("status-python", "fail", "Python not reachable");
    }
}

// ---------------------------------------------------------------------------
// Column 1 — MIME types (R)
// ---------------------------------------------------------------------------
async function testMimeTypes() {
    const assets = [
        { label: "index.html",                       path: "index.html",                       expected: "text/html" },
        { label: "assets/styles/styles.css",         path: "assets/styles/styles.css",         expected: "text/css" },
        { label: "assets/app/mock-orchestrator.js",  path: "assets/app/mock-orchestrator.js",  expected: "text/javascript" },
        { label: "assets/app/logger.js",             path: "assets/app/logger.js",             expected: "text/javascript" },
        { label: "assets/app/temporal-extension.js", path: "assets/app/temporal-extension.js", expected: "text/javascript" },
        { label: "assets/data/json/mock.json",       path: "assets/data/json/mock.json",       expected: "application/json" },
    ];
    const ul = document.getElementById("mime-list");
    ul.innerHTML = "";
    let allOk = true;
    for (const asset of assets) {
        let ok = false, ct = "";
        try {
            const res = await fetch(asset.path);
            ct = res.headers.get("Content-Type") || "";
            ok = res.ok && ct.includes(asset.expected);
        } catch (_) {}
        if (!ok) allOk = false;
        const li = document.createElement("li");
        li.textContent = `${ok ? "✓" : "✗"} ${asset.label} — ${ct || "no response"}`;
        li.style.color = `var(${ok ? "--ok" : "--fail"})`;
        ul.appendChild(li);
    }
    setStatus("status-mime", allOk ? "ok" : "fail",
        allOk ? "OK — all MIME types correct" : "FAILED — see list");
}

// ---------------------------------------------------------------------------
// Column 2 — Uncaught errors (C → UNCAUGHTEVENTS.LOG)
// ---------------------------------------------------------------------------
function testUncaughtEvents() {
    // Detached from call stack — genuinely uncaught
    setTimeout(() => { throw new TypeError("Spoofed TypeError"); }, 0);
    setTimeout(() => { new Array(-1); }, 0);                // RangeError
    setTimeout(() => { eval("if("); }, 0);                  // SyntaxError
    setTimeout(() => { decodeURIComponent("%"); }, 0);      // URIError
    // Unhandled promise rejections
    Promise.any([Promise.reject(new Error("r1")), Promise.reject(new Error("r2"))]);  // AggregateError
    Promise.reject(new ReferenceError("Spoofed ReferenceError"));
    // Direct manual entry
    logEvent("Spoofed direct logEvent() at " + new Date().toISOString(), "UNCAUGHTEVENTS");

    document.getElementById("uncaught-list").innerHTML = [
        "TypeError — throw in setTimeout",
        "RangeError — new Array(-1) in setTimeout",
        "SyntaxError — eval('if(') in setTimeout",
        "URIError — decodeURIComponent('%') in setTimeout",
        "AggregateError — Promise.any() all rejected, no handler",
        "ReferenceError — Promise.reject(), no handler (unhandledrejection)",
        "logEvent() — direct call to UNCAUGHTEVENTS",
    ].map(t => `<li>${t} — fired</li>`).join("");
    setStatus("status-uncaught", "ok", "OK — 7 events fired → UNCAUGHTEVENTS.LOG");
}

// ---------------------------------------------------------------------------
// Column 2 — Stochastic errors (C → STOCHASTICEVENTS.TXT)
// ---------------------------------------------------------------------------
function testStochasticEvents() {
    const ts = Date.now();
    // Broken image sources — resource load failure, capture phase
    [1, 2, 3].forEach(n => {
        const img = document.createElement("img");
        img.src = `/does-not-exist-img-${n}-${ts}.png`;
        img.style.display = "none";
        document.body.appendChild(img);
    });
    // Broken script src
    const script = document.createElement("script");
    script.src = `/does-not-exist-script-${ts}.js`;
    document.body.appendChild(script);
    // Broken stylesheet href
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/does-not-exist-style-${ts}.css`;
    document.head.appendChild(link);
    // Direct manual entry
    logEvent("Spoofed direct stochastic event at " + new Date().toISOString(), "STOCHASTICEVENTS");

    document.getElementById("stochastic-list").innerHTML = [
        "network — broken img src #1",
        "network — broken img src #2",
        "network — broken img src #3",
        "network — broken script src",
        "network — broken link href",
        "logEvent() — direct call to STOCHASTICEVENTS",
    ].map(t => `<li>${t} — fired</li>`).join("");
    setStatus("status-stochastic", "ok", "OK — 6 events fired → STOCHASTICEVENTS.TXT");
}

// ---------------------------------------------------------------------------
// Column 2 — Mock data fetch (R)
// ---------------------------------------------------------------------------
async function testMockData() {
    try {
        const res = await fetch("assets/data/json/mock.json");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const container = document.getElementById("mockdata-cards");
        container.innerHTML = "";
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
            const card = document.createElement("div");
            card.className = "card";
            card.innerHTML =
                `<strong>${item.title || item.id || "item"}</strong>` +
                (item.description ? `<p>${item.description}</p>` : "") +
                (item.category    ? `<span class="tag">${item.category}</span>` : "") +
                (item.status      ? ` <span class="tag">${item.status}</span>` : "");
            container.appendChild(card);
        });
        setStatus("status-mockdata", "ok", `OK — ${items.length} item(s) from mock.json`);
    } catch (err) {
        setStatus("status-mockdata", "fail", "FAILED — " + err.message);
    }
}

// ---------------------------------------------------------------------------
// Column 3 — Log readback (R)
// ---------------------------------------------------------------------------
async function testLogReadback() {
    const files = [
        { filename: "UNCAUGHTEVENTS.LOG",   relative_path: "mockproject/assets/logs" },
        { filename: "STOCHASTICEVENTS.TXT", relative_path: "mockproject/assets/logs" },
    ];
    const pre = document.getElementById("readback-content");
    pre.textContent = "";
    let allOk = true;
    for (const f of files) {
        try {
            const res = await fetch(logUrl(f.filename, f.relative_path));
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || "readback failed");
            pre.textContent += `=== ${f.filename} ===\n${data.content}\n`;
        } catch (err) {
            pre.textContent += `=== ${f.filename} === FAILED — ${err.message}\n`;
            allOk = false;
        }
    }
    setStatus("status-readback", allOk ? "ok" : "fail",
        allOk ? "OK — log files read from disk" : "FAILED — see content above");
}

// ---------------------------------------------------------------------------
// Column 3 — Directory toggle: create dir + files if absent, delete all if present (C/D)
// ---------------------------------------------------------------------------
async function testDirToggle() {
    const { relative_path, files } = config_dir_toggle;
    const dirName = relative_path.split("/").pop();
    const pre = document.getElementById("delete-content");
    pre.textContent = "";
    let allOk = true;

    // Determine mode: check if first file already exists
    let deleteMode = false;
    try {
        const check = await fetch(logUrl(files[0], relative_path));
        deleteMode = check.ok;
    } catch (_) {}

    if (!deleteMode) {
        // CREATE: directory first, then each file
        pre.textContent += `creating ${dirName}...\n`;
        try {
            const res = await fetch(config_server.route, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dirmode: true, relative_path })
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error);
            pre.textContent += `${dirName} — ${data.action}\n`;
        } catch (err) {
            pre.textContent += `${dirName} — FAILED: ${err.message}\n`;
            allOk = false;
        }

        for (const filename of files) {
            pre.textContent += `creating ${filename}...\n`;
            try {
                const res = await fetch(config_server.route, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filename, relative_path, content: "" })
                });
                const data = await res.json();
                if (!data.ok) throw new Error(data.error);
                pre.textContent += `${filename} — created\n`;
            } catch (err) {
                pre.textContent += `${filename} — FAILED: ${err.message}\n`;
                allOk = false;
            }
        }

    } else {
        // DELETE: files one at a time, then directory
        for (const filename of files) {
            pre.textContent += `searching for ${filename}...\n`;
            try {
                const checkRes = await fetch(logUrl(filename, relative_path));
                pre.textContent += `${filename} — ${checkRes.ok ? "found" : "not found"}\n`;
                if (!checkRes.ok) continue;
                pre.textContent += `deleting ${filename}...\n`;
                const delRes = await fetch(logUrl(filename, relative_path), { method: "DELETE" });
                const delData = await delRes.json();
                if (!delData.ok) throw new Error(delData.error);
                pre.textContent += `${filename} — deleted\n`;
            } catch (err) {
                pre.textContent += `${filename} — FAILED: ${err.message}\n`;
                allOk = false;
            }
        }

        pre.textContent += `searching for ${dirName}...\n`;
        try {
            const checkRes = await fetch(
                `${config_server.route}?dirmode=1&relative_path=${encodeURIComponent(relative_path)}`
            );
            pre.textContent += `${dirName} — ${checkRes.ok ? "found" : "not found"}\n`;
            if (checkRes.ok) {
                pre.textContent += `deleting ${dirName}...\n`;
                const delRes = await fetch(config_server.route, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ dirmode: true, relative_path })
                });
                const delData = await delRes.json();
                if (!delData.ok) throw new Error(delData.error);
                pre.textContent += `${dirName} — deleted\n`;
            }
        } catch (err) {
            pre.textContent += `${dirName} — FAILED: ${err.message}\n`;
            allOk = false;
        }
    }

    setStatus("status-delete", allOk ? "ok" : "fail",
        allOk
            ? (deleteMode ? "OK — all 3 deleted" : "OK — directory and files created")
            : "FAILED — see log above");
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------
async function runAllTests() {
    ["status-server", "status-mime", "status-python",
     "status-mockdata", "status-uncaught", "status-stochastic",
     "status-readback", "status-delete"]
        .forEach(id => setStatus(id, "pending", "pending..."));

    await Promise.all([checkServerStatus(), checkPythonStatus(), testMimeTypes(), testMockData()]);

    await Promise.all([
        // Thread 1 — directory + DELETEME files toggle (independent)
        testDirToggle(),

        // Thread 2 — fire events, wait for log writes to settle, then read back
        (async () => {
            testUncaughtEvents();
            testStochasticEvents();
            await new Promise(r => setTimeout(r, 1500));
            await testLogReadback();
        })()
    ]);
}

document.getElementById("run-btn").addEventListener("click", runAllTests);
runAllTests();
