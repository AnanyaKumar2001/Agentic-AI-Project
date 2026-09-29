/* CDR & IPDR Agent Console — vanilla JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
    return el;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fileUrl = (p, dl) => "/files/" + p.split("/").map(encodeURIComponent).join("/") + (dl ? "?download=1" : "");
  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
  const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s`; };
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour12: false });
  const md = (text) => (window.marked && window.DOMPurify)
    ? DOMPurify.sanitize(marked.parse(text || ""))
    : `<pre>${esc(text)}</pre>`;

  const TABS = [
    { key: "report", title: "Report" },
    { key: "visuals", title: "Visuals" },
    { key: "analysis", title: "Analysis" },
    { key: "links", title: "Link Analysis" },
    { key: "normalized", title: "Normalized" },
    { key: "powerbi", title: "Power BI" },
    { key: "scripts", title: "Scripts" },
  ];

  const state = {
    config: null,
    selected: new Set(),
    runId: null,
    run: null,          // derived run view state
    es: null,
    files: {},
    tab: "report",
    open: {},           // tab -> selected file path
    onlyChanged: false,
    lightbox: { list: [], i: 0 },
  };

  /* ------------------------------------------------------------ setup --- */
  async function init() {
    state.config = await (await fetch("/api/config")).json();
    renderChips();
    $("#rawFiles").textContent = state.config.raw_files.length
      ? "Raw files in workspace: " + state.config.raw_files.join(" · ")
      : "No raw .xls/.xlsx/.csv files found in the workspace root.";
    if (!state.config.claude_found) showError("Claude Code CLI ('claude') was not found on PATH — runs will fail.");

    $("#runForm").addEventListener("submit", (e) => { e.preventDefault(); startRun(); });
    $("#prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startRun(); }
    });
    $("#prompt").addEventListener("input", () => { state.selected.clear(); syncChips(); });
    $("#stopBtn").addEventListener("click", stopRun);
    $("[data-all]").addEventListener("click", () => {
      state.selected.clear(); syncChips(); $("#prompt").value = "Run all agents"; $("#prompt").focus();
    });
    $("#runSelect").addEventListener("change", (e) => e.target.value && openRun(e.target.value));
    $("#onlyChanged").addEventListener("change", (e) => { state.onlyChanged = e.target.checked; renderTabs(); renderTab(); });
    setupLightbox();

    resetRunView(null);
    renderTabs();
    await loadFiles();
    const runs = await loadRunList();
    const first = state.config.active || (runs[0] && runs[0].id);
    if (first) openRun(first); else renderTab();
    setInterval(tick, 1000);
  }

  function renderChips() {
    const box = $("#agentChips");
    box.innerHTML = "";
    for (const a of state.config.pipeline) {
      box.append(h("button", {
        type: "button", class: "chip", "data-agent": a.name, title: a.blurb,
        onclick: () => {
          state.selected.has(a.name) ? state.selected.delete(a.name) : state.selected.add(a.name);
          syncChips();
          const names = state.config.pipeline.map((p) => p.name).filter((n) => state.selected.has(n));
          $("#prompt").value = names.length ? `Run the ${names.join(", ")} agent${names.length > 1 ? "s" : ""}` : "";
        },
      }, a.name));
    }
  }
  function syncChips() {
    document.querySelectorAll("[data-agent]").forEach((c) => c.classList.toggle("on", state.selected.has(c.dataset.agent)));
  }
  function showError(msg) { const e = $("#formError"); e.textContent = msg || ""; e.hidden = !msg; }

  /* ------------------------------------------------------------- runs --- */
  async function loadRunList() {
    const runs = await (await fetch("/api/runs")).json();
    const sel = $("#runSelect");
    sel.innerHTML = "";
    if (!runs.length) sel.append(h("option", { value: "" }, "— no runs yet —"));
    for (const r of runs) {
      const label = `${r.started.replace("T", " ")} · ${r.status} · ${r.prompt.slice(0, 40)}`;
      sel.append(h("option", { value: r.id }, label));
    }
    if (state.runId) sel.value = state.runId;
    return runs;
  }

  async function startRun() {
    const prompt = $("#prompt").value.trim();
    if (!prompt) return showError("Type an instruction, e.g. \"Run all agents\".");
    showError("");
    $("#runBtn").disabled = true;
    const res = await fetch("/api/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model: $("#model").value }),
    });
    const data = await res.json();
    $("#runBtn").disabled = false;
    if (!res.ok) { showError(data.error); if (data.id) openRun(data.id); return; }
    await loadRunList();
    openRun(data.id);
    state.tab = "report"; renderTabs();
  }

  async function stopRun() {
    if (state.runId) await fetch(`/api/runs/${state.runId}/stop`, { method: "POST" });
  }

  function openRun(id) {
    if (state.es) { state.es.close(); state.es = null; }
    state.runId = id;
    $("#runSelect").value = id;
    resetRunView(id);
    const es = new EventSource(`/api/runs/${id}/stream?from=0`);
    state.es = es;
    es.onmessage = (m) => { onEvent(JSON.parse(m.data)); scheduleRender(); };
    es.addEventListener("end", () => { es.close(); state.es = null; scheduleRender(); loadRunList(); });
  }

  function resetRunView(id) {
    state.run = {
      id, status: id ? "starting" : "idle", prompt: "", started: null, ended: null, cost: null,
      result: null, resultError: false, changed: new Set(), hasChanged: false,
      instances: {},                  // tool_use_id -> {agent, desc, status, tools, last, t0, t1, report}
      orch: { tools: 0, last: "", t0: null },
      feedCount: 0,
    };
    $("#feed").innerHTML = "";
    renderPipeline(); renderStatus();
  }

  /* ------------------------------------------------------- event model --- */
  function onEvent(ev) {
    const r = state.run;
    if (r.started == null) r.started = ev.t;
    switch (ev.kind) {
      case "status":
        r.status = ev.status;
        if (ev.prompt) r.prompt = ev.prompt;
        if (!["starting", "running"].includes(ev.status)) {
          r.ended = ev.t;
          for (const i of Object.values(r.instances)) if (i.status === "running") { i.status = ev.status === "completed" ? "done" : "failed"; i.t1 = ev.t; }
          loadFiles();
        }
        feed(ev, "status", `Run ${ev.status}${ev.prompt ? ` — “${ev.prompt}”` : ""}`, ev.status === "failed" ? "err" : ev.status === "completed" ? "ok" : "");
        break;
      case "init":
        r.orch.t0 = ev.t;
        feed(ev, "orchestrator", `Session started (model ${ev.model})`, "log");
        break;
      case "agent_start":
        r.instances[ev.id] = { agent: ev.agent, desc: ev.description, status: "running", tools: 0, last: "", t0: ev.t, t1: null, report: "" };
        feed(ev, ev.agent, `▶ started: ${ev.description}`, "");
        break;
      case "agent_end": {
        const i = r.instances[ev.id] || (r.instances[ev.id] = { agent: ev.agent, desc: "", tools: 0, t0: ev.t });
        i.status = ev.status === "completed" ? "done" : "failed";
        i.t1 = ev.t;
        if (ev.usage && ev.usage.tool_uses != null) i.tools = Math.max(i.tools, ev.usage.tool_uses);
        feed(ev, ev.agent, `${i.status === "done" ? "✔ finished" : "✖ " + ev.status}${ev.summary ? ": " + ev.summary : ""}`, i.status === "done" ? "ok" : "err");
        break;
      }
      case "agent_report":
        if (r.instances[ev.id]) r.instances[ev.id].report = ev.text;
        break;
      case "tool": {
        const i = ev.agent_id && r.instances[ev.agent_id];
        const tgt = i || r.orch;
        tgt.tools++; tgt.last = `${ev.tool}: ${ev.detail}`;
        feed(ev, ev.agent, h("span", {}, h("b", {}, ev.tool), " ", ev.detail), "");
        break;
      }
      case "tool_error": {
        // A command inside an agent failed; agents usually fix and retry, so it doesn't fail the agent.
        const i = ev.agent_id && r.instances[ev.agent_id];
        if (i) i.warnings = (i.warnings || 0) + 1;
        feed(ev, ev.agent, "⚠ " + ev.detail, "warn");
        break;
      }
      case "say":
        if (!ev.agent_id) r.orch.last = ev.text.split("\n")[0];
        feed(ev, ev.agent, ev.text.length > 400 ? ev.text.slice(0, 400) + "…" : ev.text, "log");
        break;
      case "result":
        r.result = ev.text; r.resultError = ev.is_error; r.cost = ev.cost;
        feed(ev, "orchestrator", `Final report ready${ev.cost != null ? ` · cost $${ev.cost.toFixed(2)}` : ""}`, ev.is_error ? "err" : "ok");
        break;
      case "files_changed":
        r.changed = new Set(ev.files); r.hasChanged = true;
        feed(ev, "system", `${ev.files.length} output file(s) created or updated`, "ok");
        loadFiles();
        break;
      case "error":
        feed(ev, "system", ev.text, "err");
        break;
      case "log":
        feed(ev, "system", ev.text, "log");
        break;
    }
  }

  function feed(ev, who, what, cls) {
    const ol = $("#feed");
    const stick = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 20;
    ol.append(h("li", { class: cls }, h("span", { class: "ts" }, clock(ev.t)), h("span", { class: "who", title: who }, who), h("span", { class: "what" }, what)));
    state.run.feedCount++;
    while (ol.children.length > 1500) ol.firstChild.remove();
    if (stick) ol.scrollTop = ol.scrollHeight;
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderPipeline(); renderStatus();
      if (state.tab === "report") renderTab();
    });
  }

  /* ----------------------------------------------------------- status --- */
  const running = () => ["starting", "running"].includes(state.run.status);

  function renderStatus() {
    const r = state.run;
    const pill = $("#statusPill");
    const label = { idle: "Idle", starting: "Starting…", running: "Running", completed: "Completed", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted" }[r.status] || r.status;
    pill.textContent = label;
    pill.className = "pill pill-" + r.status;
    $("#stopBtn").hidden = !running();
    $("#runBtn").disabled = running();
    $("#feedCount").textContent = r.feedCount ? `(${r.feedCount} events)` : "";
    const dl = $("#dlRun");
    dl.hidden = !(r.hasChanged && r.changed.size);
    dl.href = `/api/zip?scope=run&run=${encodeURIComponent(r.id || "")}`;
    dl.textContent = `Download this run's files (${r.changed.size})`;
    tick();
  }

  function tick() {
    const r = state.run;
    if (!r || !r.started) { $("#runMeta").textContent = ""; return; }
    const end = r.ended || Date.now() / 1000;
    const done = Object.values(r.instances).filter((i) => i.status === "done").length;
    const total = Object.keys(r.instances).length;
    $("#runMeta").textContent = [
      r.prompt && `“${r.prompt}”`,
      `elapsed ${fmtDur(end - r.started)}`,
      total && `${done}/${total} agent tasks done`,
      r.cost != null && `$${r.cost.toFixed(2)}`,
    ].filter(Boolean).join(" · ");
    if (running()) document.querySelectorAll("[data-elapsed]").forEach((el) => {
      const i = r.instances[el.dataset.elapsed];
      if (i) el.textContent = fmtDur((i.t1 || Date.now() / 1000) - i.t0);
    });
  }

  function renderPipeline() {
    const r = state.run;
    const box = $("#pipeline");
    box.innerHTML = "";
    const byAgent = {};
    for (const [id, i] of Object.entries(r.instances)) (byAgent[i.agent] ||= []).push([id, i]);
    const stages = [...state.config.pipeline];
    for (const a of Object.keys(byAgent)) if (!stages.find((s) => s.name === a)) stages.push({ name: a, title: a, blurb: "Ad-hoc subagent" });

    const orchState = running() ? "running" : r.status === "completed" ? "done" : ["failed", "stopped", "interrupted"].includes(r.status) ? "failed" : "idle";
    box.append(h("div", { class: `stage orch ${orchState}` },
      h("div", { class: "row" }, h("span", { class: "name" }, "Orchestrator"), stateLabel(orchState, r.status)),
      h("div", { class: "blurb" }, "Interprets your instruction and dispatches the agents below"),
      h("div", { class: "last", title: r.orch.last }, r.orch.last || (r.id ? "" : "Waiting for an instruction")),
    ));

    for (const s of stages) {
      const inst = byAgent[s.name] || [];
      let st = "idle";
      if (inst.some(([, i]) => i.status === "running")) st = "running";
      else if (inst.some(([, i]) => i.status === "failed")) st = "failed";
      else if (inst.length) st = "done";
      else if (r.id && !running() && r.status !== "idle") st = "skipped";
      const tools = inst.reduce((a, [, i]) => a + (i.tools || 0), 0);
      const warns = inst.reduce((a, [, i]) => a + (i.warnings || 0), 0);
      const lastActive = inst.filter(([, i]) => i.status === "running").map(([, i]) => i.last).filter(Boolean).pop()
        || (inst.length ? inst[inst.length - 1][1].last : "");
      box.append(h("div", { class: `stage ${st}` },
        h("div", { class: "row" }, h("span", { class: "name" }, s.title), stateLabel(st)),
        h("div", { class: "blurb" }, s.blurb),
        inst.length ? h("div", { class: "stats" }, `${inst.length} task${inst.length > 1 ? "s" : ""} · ${tools} tool calls` + (warns ? ` · ${warns} failed command${warns > 1 ? "s" : ""} (retried)` : "")) : null,
        h("div", { class: "last", title: lastActive }, st === "running" ? lastActive : ""),
        inst.length ? h("div", { class: "instances" }, inst.map(([id, i]) =>
          h("div", { class: "inst", title: i.desc }, h("span", { class: `dot ${i.status}` }),
            h("span", { "data-elapsed": id }, fmtDur((i.t1 || Date.now() / 1000) - i.t0)),
            h("span", {}, i.desc)))) : null,
      ));
    }
  }

  function stateLabel(st, runStatus) {
    const txt = { idle: "Idle", running: "Running", done: "Done", failed: runStatus === "stopped" ? "Stopped" : "Failed", skipped: "Not run" }[st];
    return h("span", { class: "state" }, st === "running" ? h("span", { class: "spinner" }) : null, txt);
  }

  /* ------------------------------------------------------------ files --- */
  let filesLoading = null;
  async function loadFiles() {
    if (filesLoading) return filesLoading;
    filesLoading = fetch("/api/files").then((r) => r.json()).then((f) => {
      state.files = f; renderTabs(); renderTab();
    }).finally(() => { filesLoading = null; });
    return filesLoading;
  }
  // Pick up files progressively while a run is in progress.
  setInterval(() => { if (state.run && running()) loadFiles(); }, 8000);

  const isNew = (p) => state.run.changed.has(p);
  function filesFor(tab) {
    let list = state.files[tab] || [];
    if (state.onlyChanged && state.run.hasChanged) list = list.filter((f) => isNew(f.path));
    return list;
  }

  function renderTabs() {
    const nav = $("#tabs");
    nav.innerHTML = "";
    for (const t of TABS) {
      const n = t.key === "report" ? null : filesFor(t.key).length;
      nav.append(h("button", {
        class: "tab" + (state.tab === t.key ? " active" : ""), role: "tab",
        onclick: () => { state.tab = t.key; renderTabs(); renderTab(); },
      }, t.title, n != null ? h("span", { class: "count" }, n) : null));
    }
  }

  function renderTab() {
    const body = $("#tabBody");
    body.innerHTML = "";
    if (state.tab === "report") return renderReport(body);
    if (state.tab === "visuals") return renderVisuals(body);
    return renderBrowser(body, state.tab);
  }

  function tabToolbar(tab, count) {
    const zipHref = state.onlyChanged && state.run.hasChanged
      ? "/api/zip?scope=files&" + filesFor(tab).map((f) => "path=" + encodeURIComponent(f.path)).join("&")
      : `/api/zip?scope=${tab}`;
    return h("div", { class: "tab-toolbar" },
      h("span", { class: "muted small" }, `${count} file${count === 1 ? "" : "s"}`),
      count ? h("a", { class: "btn sm", href: zipHref }, `Download all ${TABS.find((t) => t.key === tab).title} (.zip)`) : null);
  }

  function byFolder(list) {
    const m = new Map();
    for (const f of list) { if (!m.has(f.folder)) m.set(f.folder, []); m.get(f.folder).push(f); }
    return m;
  }

  /* ----------------------------------------------------------- report --- */
  function renderReport(body) {
    const r = state.run;
    if (!r.id) { body.append(h("div", { class: "empty" }, "Enter an instruction above and press Run. The orchestrator's final report will appear here.")); return; }
    if (r.result) body.append(h("div", { class: "md", html: md(r.result) }));
    else body.append(h("div", { class: "empty" }, running() ? "Agents are working — the final report will appear here when the run finishes. Output tabs update as files are written." : "This run did not produce a final report. Check the live activity log above."));

    const reps = Object.values(r.instances).filter((i) => i.report);
    if (reps.length) {
      body.append(h("h2", { style: "margin:18px 0 4px" }, "Agent reports"));
      for (const i of reps) {
        body.append(h("details", { class: "report-agent" },
          h("summary", {}, h("span", { class: `dot ${i.status}` }), `${i.agent} — ${i.desc}`),
          h("div", { class: "md", html: md(i.report) })));
      }
    }
    if (r.hasChanged) body.append(changedFilesCard(r));
  }

  function changedFilesCard(r) {
    const paths = [...r.changed].sort();
    const info = new Map(Object.values(state.files).flat().map((f) => [f.path, f]));
    const list = h("div", { class: "cf-list" });
    const filter = h("input", { type: "search", placeholder: "Filter files…", class: "cf-filter" });
    const fill = (q) => {
      list.innerHTML = "";
      q = q.toLowerCase();
      let lastFolder = null, shown = 0;
      for (const p of paths) {
        if (q && !p.toLowerCase().includes(q)) continue;
        const folder = p.slice(0, p.lastIndexOf("/"));
        if (folder !== lastFolder) { list.append(h("div", { class: "cf-folder" }, folder + "/")); lastFolder = folder; }
        const f = info.get(p);
        list.append(h("div", { class: "cf-row" },
          h("span", { class: "cf-name", title: p }, p.slice(folder.length + 1)),
          h("span", { class: "cf-size" }, f ? fmtSize(f.size) : ""),
          h("a", { class: "btn sm", href: fileUrl(p, true), title: "Download " + p }, "Download")));
        shown++;
      }
      if (!shown) list.append(h("div", { class: "empty" }, paths.length ? "No files match the filter." : "This run did not create or change any output files."));
    };
    filter.addEventListener("input", () => fill(filter.value));
    fill("");
    return h("div", { class: "cf-card" },
      h("div", { class: "cf-head" },
        h("h2", {}, "Files created or updated ", h("span", { class: "count" }, paths.length)),
        h("div", { class: "cf-actions" }, paths.length > 8 ? filter : null,
          paths.length ? h("a", { class: "btn sm primary", href: `/api/zip?scope=run&run=${encodeURIComponent(r.id)}` }, "Download all (.zip)") : null)),
      list);
  }

  /* ---------------------------------------------------------- visuals --- */
  function renderVisuals(body) {
    // Show each image once; SVG twins of PNGs become an extra download button.
    const all = filesFor("visuals").filter((f) => f.kind === "image");
    const pngs = new Set(all.filter((f) => !f.path.endsWith(".svg")).map((f) => f.path.replace(/\.\w+$/, "")));
    const imgs = all.filter((f) => !(f.path.endsWith(".svg") && pngs.has(f.path.replace(/\.svg$/, ""))));
    const svgFor = (f) => all.find((x) => x.path === f.path.replace(/\.\w+$/, ".svg") && x.path !== f.path);
    body.append(tabToolbar("visuals", filesFor("visuals").length));
    if (!imgs.length) { body.append(h("div", { class: "empty" }, "No visualizations yet. Run the viz-generator agent.")); return; }
    state.lightbox.list = imgs;
    let idx = 0;
    for (const [folder, list] of byFolder(imgs)) {
      body.append(h("div", { class: "folder-title" }, folder + "/"));
      const grid = h("div", { class: "gallery" });
      for (const f of list) {
        const my = idx++;
        const svg = svgFor(f);
        grid.append(h("div", { class: "viz" },
          h("div", { class: "thumb", onclick: () => openLightbox(my) },
            h("img", { src: fileUrl(f.path) + "?v=" + Math.round(f.mtime), loading: "lazy", alt: f.caption || f.name })),
          h("div", { class: "meta" },
            h("div", { class: "n" }, f.name, isNew(f.path) ? h("span", { class: "badge-new" }, "NEW") : null),
            f.caption ? h("div", { class: "c" }, f.caption) : null),
          h("div", { class: "acts" },
            h("button", { class: "btn sm", onclick: () => openLightbox(my) }, "View"),
            h("a", { class: "btn sm", href: fileUrl(f.path, true) }, "Download " + f.name.split(".").pop().toUpperCase()),
            svg ? h("a", { class: "btn sm", href: fileUrl(svg.path, true) }, "SVG") : null)));
      }
      body.append(grid);
    }
    const index = filesFor("visuals").find((f) => f.path === "visuals/index.md");
    if (index) body.append(h("p", { class: "small muted", style: "margin-top:14px" }, "Captions come from ", h("a", { href: fileUrl(index.path, true) }, "visuals/index.md"), "."));
  }

  function setupLightbox() {
    const lb = $("#lightbox");
    $("#lbClose").onclick = () => (lb.hidden = true);
    lb.addEventListener("click", (e) => { if (e.target === lb) lb.hidden = true; });
    $("#lbPrev").onclick = () => openLightbox(state.lightbox.i - 1);
    $("#lbNext").onclick = () => openLightbox(state.lightbox.i + 1);
    document.addEventListener("keydown", (e) => {
      if (lb.hidden) return;
      if (e.key === "Escape") lb.hidden = true;
      if (e.key === "ArrowLeft") openLightbox(state.lightbox.i - 1);
      if (e.key === "ArrowRight") openLightbox(state.lightbox.i + 1);
    });
  }
  function openLightbox(i) {
    const list = state.lightbox.list;
    if (!list.length) return;
    i = (i + list.length) % list.length;
    state.lightbox.i = i;
    const f = list[i];
    $("#lbImg").src = fileUrl(f.path) + "?v=" + Math.round(f.mtime);
    $("#lbTitle").textContent = f.path;
    $("#lbCaption").textContent = [f.caption, f.source && "Source: " + f.source].filter(Boolean).join(" — ");
    $("#lbDownload").href = fileUrl(f.path, true);
    $("#lightbox").hidden = false;
  }

  /* ---------------------------------------------------------- browser --- */
  function renderBrowser(body, tab) {
    const list = filesFor(tab);
    body.append(tabToolbar(tab, list.length));
    if (!list.length) {
      body.append(h("div", { class: "empty" }, state.onlyChanged ? "No files in this tab were changed by the selected run." : "No files yet for this tab."));
      return;
    }
    if (!list.find((f) => f.path === state.open[tab])) {
      state.open[tab] = (list.find((f) => ["csv", "markdown", "html", "mermaid"].includes(f.kind)) || list[0]).path;
    }
    const fl = h("div", { class: "file-list" });
    for (const [folder, files] of byFolder(list)) {
      fl.append(h("div", { class: "grp" }, folder));
      for (const f of files) {
        fl.append(h("div", {
          class: "file-item" + (f.path === state.open[tab] ? " active" : ""), title: f.path,
          onclick: () => { state.open[tab] = f.path; renderTab(); },
        }, h("span", { class: "fn" }, f.name, isNew(f.path) ? h("span", { class: "badge-new" }, "NEW") : null), h("span", { class: "sz" }, fmtSize(f.size))));
      }
    }
    const f = list.find((x) => x.path === state.open[tab]);
    const vb = h("div", { class: "viewer-body" }, h("div", { class: "empty" }, "Loading preview…"));
    const viewer = h("div", { class: "viewer" },
      h("div", { class: "viewer-head" },
        h("span", { class: "path" }, f.path, " ", h("span", { class: "muted" }, `· ${fmtSize(f.size)} · ${new Date(f.mtime * 1000).toLocaleString()}`)),
        h("span", {},
          f.kind === "html" ? h("a", { class: "btn sm", href: fileUrl(f.path), target: "_blank", rel: "noopener" }, "Open in new tab") : null, " ",
          h("a", { class: "btn sm primary", href: fileUrl(f.path, true) }, "Download"))),
      vb);
    body.append(h("div", { class: "browser" }, fl, viewer));
    loadPreview(f, vb);
  }

  async function loadPreview(f, vb) {
    const put = (...n) => { vb.innerHTML = ""; vb.append(...n); };
    if (f.kind === "image") return put(h("div", { class: "mermaid-box" }, h("img", { src: fileUrl(f.path), style: "max-width:100%" })));
    if (f.kind === "html") return put(h("iframe", { src: fileUrl(f.path), sandbox: "allow-scripts allow-popups" }));
    if (f.kind === "binary") return put(h("div", { class: "empty" }, "No in-browser preview for this file type. Use Download."));
    const res = await fetch("/api/preview?path=" + encodeURIComponent(f.path));
    if (!res.ok) return put(h("div", { class: "empty" }, "Could not load preview."));
    const d = await res.json();
    if (d.kind === "csv") return put(...csvView(d));
    if (d.kind === "markdown") return put(h("div", { class: "md", html: md(d.text) }));
    if (d.kind === "mermaid") return renderMermaid(d.text, vb);
    put(h("pre", {}, d.text));
  }

  function csvView(d) {
    const filter = h("input", { type: "search", placeholder: "Filter rows…", style: "width:220px" });
    const note = h("div", { class: "note" },
      d.truncated ? `Showing first ${d.rows.length.toLocaleString()} of ${d.total_rows.toLocaleString()} rows — download for the full file. ` : `${d.total_rows.toLocaleString()} rows · ${d.columns.length} columns. `,
      filter);
    const tbody = h("tbody");
    const fill = (q) => {
      tbody.innerHTML = "";
      q = q.toLowerCase();
      const frag = document.createDocumentFragment();
      for (const row of d.rows) {
        if (q && !row.join("\u0001").toLowerCase().includes(q)) continue;
        frag.append(h("tr", {}, row.map((c) => h("td", { title: c }, c))));
      }
      tbody.append(frag);
    };
    filter.addEventListener("input", () => fill(filter.value));
    fill("");
    return [note, h("table", { class: "data" }, h("thead", {}, h("tr", {}, d.columns.map((c) => h("th", { title: c }, c)))), tbody)];
  }

  let mermaidReady = null;
  async function renderMermaid(text, vb) {
    vb.innerHTML = "";
    const box = h("div", { class: "mermaid-box" }, "Rendering diagram…");
    vb.append(box, h("details", {}, h("summary", { class: "small muted", style: "padding:6px 12px" }, "Mermaid source"), h("pre", {}, text)));
    try {
      mermaidReady ||= new Promise((ok, bad) => {
        const s = h("script", { src: "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js" });
        s.onload = () => { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" }); ok(); };
        s.onerror = bad;
        document.head.append(s);
      });
      await mermaidReady;
      const { svg } = await window.mermaid.render("mmd" + Date.now(), text);
      box.innerHTML = svg;
    } catch (e) {
      box.textContent = "Could not render the diagram (offline or invalid syntax) — see the source below.";
    }
  }

  init();
})();
