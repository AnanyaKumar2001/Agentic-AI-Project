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

  // Each tab shares the colour of the agent that produces its files.
  const TABS = [
    { key: "report", title: "Report", color: "indigo", icon: "📝" },
    { key: "visuals", title: "Visuals", color: "pink", icon: "📊" },
    { key: "analysis", title: "Analysis", color: "blue", icon: "🔍" },
    { key: "links", title: "Link Analysis", color: "orange", icon: "🔗" },
    { key: "normalized", title: "Normalized", color: "teal", icon: "🧹" },
    { key: "powerbi", title: "Power BI", color: "amber", icon: "📈" },
    { key: "scripts", title: "Scripts", color: "slate", icon: "🐍" },
  ];
  const AGENT_STYLE = {
    orchestrator: { color: "indigo", icon: "🧭" },
    "record-normalizer": { color: "teal", icon: "🧹" },
    "cdr-analyst": { color: "blue", icon: "📞" },
    "ipdr-analyst": { color: "violet", icon: "🌐" },
    "link-analyzer": { color: "orange", icon: "🔗" },
    "viz-generator": { color: "pink", icon: "📊" },
    "powerbi-dashboard": { color: "amber", icon: "📈" },
    system: { color: "slate", icon: "⚙️" },
  };
  // Custom agents get a stable colour derived from their name.
  const CUSTOM_COLORS = ["cyan", "violet", "green", "orange", "teal", "pink", "blue", "amber"];
  const agentStyle = (name) => {
    if (AGENT_STYLE[name]) return AGENT_STYLE[name];
    // Known custom agents take colours in order so neighbours differ; unknown names fall back to a hash.
    const customs = (state.config?.pipeline || []).filter((p) => p.custom).map((p) => p.name);
    const i = customs.indexOf(name);
    if (i >= 0) return { color: CUSTOM_COLORS[i % CUSTOM_COLORS.length], icon: "🤖" };
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return { color: CUSTOM_COLORS[hash % CUSTOM_COLORS.length], icon: "🤖" };
  };
  const cvar = (color) => `--c: var(--${color})`;
  const agentVar = (name) => cvar(agentStyle(name).color);
  // Folders get a colour from a rotating palette so gallery sections are easy to tell apart.
  const FOLDER_COLORS = ["blue", "violet", "orange", "teal", "pink", "amber", "cyan", "green"];
  const folderColors = new Map();
  const folderVar = (folder) => {
    if (!folderColors.has(folder)) folderColors.set(folder, FOLDER_COLORS[folderColors.size % FOLDER_COLORS.length]);
    return cvar(folderColors.get(folder));
  };
  const KIND_COLOR = { csv: "green", image: "pink", markdown: "indigo", html: "orange", mermaid: "violet", text: "slate", binary: "amber" };
  const kindBadge = (f) => h("span", { class: "kind", style: cvar(KIND_COLOR[f.kind] || "slate") }, (f.name.split(".").pop() || f.kind).slice(0, 5));

  function setupTheme() {
    const btn = $("#themeToggle");
    const apply = (dark) => {
      if (dark) document.documentElement.dataset.theme = "dark"; else delete document.documentElement.dataset.theme;
      const label = dark ? "Switch to light theme" : "Switch to dark theme";
      btn.setAttribute("aria-label", label); btn.title = label;
    };
    apply(document.documentElement.dataset.theme === "dark");
    btn.addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme !== "dark";
      apply(dark);
      try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) { /* storage unavailable: theme lasts this visit */ }
    });
  }

  const state = {
    config: null,
    selected: new Set(),
    runId: null,
    run: null,          // derived run view state
    es: null,
    files: {},
    view: "run",        // top-level section: "run" or "outputs"
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
    setupTheme();

    resetRunView(null);
    setupViews();
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
        type: "button", class: "chip", "data-agent": a.name, title: a.blurb, style: agentVar(a.name),
        onclick: () => {
          state.selected.has(a.name) ? state.selected.delete(a.name) : state.selected.add(a.name);
          syncChips();
          const names = state.config.pipeline.map((p) => p.name).filter((n) => state.selected.has(n));
          $("#prompt").value = names.length ? `Run the ${names.join(", ")} agent${names.length > 1 ? "s" : ""}` : "";
        },
      }, agentStyle(a.name).icon, " ", a.name));
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
    showView("run");
  }

  /* ------------------------------------------------------ section views --- */
  const VIEWS = [["run", "#viewRun", "#navRun"], ["outputs", "#viewOutputs", "#navOutputs"], ["agents", "#viewAgents", "#navAgents"]];
  const viewFromHash = () => ({ "#outputs": "outputs", "#agents": "agents" }[location.hash] || "run");

  function setupViews() {
    document.querySelectorAll(".main-tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
    $("#viewOutputsBtn").addEventListener("click", () => { state.tab = "report"; renderTabs(); showView("outputs"); });
    window.addEventListener("hashchange", () => showView(viewFromHash(), false));
    setupAgentForms();
    showView(viewFromHash(), false);
  }

  function showView(view, updateHash = true) {
    state.view = view;
    for (const [v, id, nav] of VIEWS) {
      const on = v === view;
      $(id).hidden = !on;
      $(nav).classList.toggle("active", on);
      $(nav).setAttribute("aria-selected", on ? "true" : "false");
    }
    if (view === "outputs") { $("#outputsBadge").hidden = true; renderTabs(); renderTab(); }
    if (view === "agents") loadAgents();
    if (updateHash) history.replaceState(null, "", view === "run" ? location.pathname + location.search : "#" + view);
    window.scrollTo({ top: 0 });
  }

  /* ----------------------------------------------------- create agents --- */
  // Re-read the agent list so new agents show up as chips and status cards on the Run tab.
  async function refreshConfig() {
    state.config = await (await fetch("/api/config")).json();
    renderChips(); syncChips(); renderPipeline();
  }

  function setupAgentForms() {
    $("#genForm").addEventListener("submit", (e) => { e.preventDefault(); generateAgent(); });
    $("#upForm").addEventListener("submit", (e) => { e.preventDefault(); uploadAgent(); });
    const dz = $("#dropZone"), input = $("#upFile");
    const showName = () => {
      const f = input.files[0];
      dz.classList.toggle("has-file", !!f);
      $("#upFileName").textContent = f ? `${f.name} · ${fmtSize(f.size)}` : "Front matter needs name and description; tools is optional.";
    };
    input.addEventListener("change", showName);
    ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, () => dz.classList.remove("over")));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; showName(); }
    });
  }

  async function generateAgent() {
    const prompt = $("#genPrompt").value.trim();
    const name = $("#genName").value.trim();
    if (prompt.length < 15) return agentResult({ error: "Describe what the new agent should do (at least a sentence)." });
    if (name && !$("#genName").checkValidity()) return agentResult({ error: "Agent name must be lowercase kebab-case, e.g. sms-pattern-analyst." });
    const btn = $("#genBtn"), status = $("#genStatus");
    btn.disabled = true;
    const t0 = Date.now();
    const tickStatus = () => { status.innerHTML = `<span class="busy-dot"></span>Claude is writing the agent… ${fmtDur((Date.now() - t0) / 1000)} (usually 20–60 s)`; };
    tickStatus();
    const timer = setInterval(tickStatus, 1000);
    try {
      const res = await fetch("/api/agents/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, name, model: $("#genModel").value, overwrite: $("#genOverwrite").checked }),
      });
      const data = await res.json();
      agentResult(res.ok ? { ...data, verb: "created" } : { error: data.error || "Could not create the agent." });
      if (res.ok) { $("#genPrompt").value = ""; $("#genName").value = ""; await refreshConfig(); loadAgents(); }
    } catch (e) {
      agentResult({ error: "The server could not be reached." });
    } finally {
      clearInterval(timer); btn.disabled = false; status.textContent = "";
    }
  }

  async function uploadAgent() {
    const file = $("#upFile").files[0];
    if (!file) return agentResult({ error: "Choose an agent file (.md) to upload." });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("overwrite", $("#upOverwrite").checked ? "1" : "0");
    $("#upBtn").disabled = true; $("#upStatus").textContent = "Uploading…";
    try {
      const res = await fetch("/api/agents/upload", { method: "POST", body: fd });
      const data = await res.json();
      agentResult(res.ok ? { ...data, verb: data.replaced_builtin ? "uploaded (replaced a built-in agent)" : "uploaded" } : { error: data.error || "Upload failed." });
      if (res.ok) {
        $("#upFile").value = ""; $("#upFile").dispatchEvent(new Event("change"));
        await refreshConfig(); loadAgents();
      }
    } catch (e) {
      agentResult({ error: "The server could not be reached." });
    } finally {
      $("#upBtn").disabled = false; $("#upStatus").textContent = "";
    }
  }

  function agentResult(r) {
    const box = $("#agentResult");
    box.hidden = false; box.innerHTML = "";
    if (r.error) {
      box.append(h("section", { class: "card agent-result error", role: "alert" },
        h("div", { class: "result-head" }, h("h2", {}, "Agent not saved")), h("p", {}, r.error)));
    } else {
      box.append(h("section", { class: "card agent-result", style: agentVar(r.name) },
        h("div", { class: "result-head" },
          h("h2", {}, `✅ Agent ${r.verb}: `, h("code", {}, r.name)),
          h("div", { class: "form-actions" },
            h("span", { class: "muted small" }, "Saved to ", h("code", {}, r.file)),
            h("button", { class: "btn primary", type: "button", onclick: () => useAgent(r.name) }, "Use it on the Run tab →"))),
        h("pre", { class: "agent-src" }, r.content)));
    }
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function useAgent(name) {
    state.selected = new Set([name]); syncChips();
    $("#prompt").value = `Run the ${name} agent`;
    showView("run");
    $("#prompt").focus();
  }

  async function loadAgents() {
    const list = $("#agentList");
    const agents = await (await fetch("/api/agents")).json();
    list.innerHTML = "";
    const order = (a) => a.builtin ? state.config.pipeline.findIndex((p) => p.name === a.name) : 100;
    agents.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
    for (const a of agents) {
      const src = h("pre", { class: "agent-src" }, "Loading…");
      const row = h("details", { class: "agent-row", style: agentVar(a.name) },
        h("summary", {},
          h("span", { class: "ico", "aria-hidden": "true" }, agentStyle(a.name).icon),
          h("div", {}, h("div", { class: "a-name" }, a.name), h("div", { class: "a-desc" }, a.description)),
          h("div", { class: "a-meta" },
            h("span", { class: "tag" + (a.builtin ? "" : " custom") }, a.builtin ? "built-in" : "custom"),
            a.tools.length ? h("span", { class: "tag", title: "Tools" }, a.tools.join(", ")) : h("span", { class: "tag" }, "all tools"),
            h("span", { class: "tag" }, fmtSize(a.size)))),
        src);
      row.addEventListener("toggle", async () => {
        if (!row.open || src.dataset.loaded) return;
        const d = await (await fetch(`/api/agents/${encodeURIComponent(a.name)}`)).json();
        src.textContent = d.content; src.dataset.loaded = "1";
      });
      list.append(row);
    }
    if (!agents.length) list.append(h("div", { class: "empty" }, "No agents found in .claude/agents/."));
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
      id, status: id ? "starting" : "idle", prompt: "", started: null, ended: null,
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
          // Flag new outputs only for a run that just finished, not when replaying an old one.
          if (ev.t > Date.now() / 1000 - 30 && state.view !== "outputs") $("#outputsBadge").hidden = false;
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
        r.result = ev.text; r.resultError = ev.is_error;
        feed(ev, "orchestrator", "Final report ready", ev.is_error ? "err" : "ok");
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
    ol.append(h("li", { class: cls }, h("span", { class: "ts" }, clock(ev.t)), h("span", { class: "who", title: who, style: agentVar(who) }, who), h("span", { class: "what" }, what)));
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
    $("#viewOutputsBtn").hidden = !r.id || running() || r.status === "idle";
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
    box.append(h("div", { class: `stage orch ${orchState}`, style: agentVar("orchestrator") },
      h("div", { class: "row" }, stageName("orchestrator", "Orchestrator"), stateLabel(orchState, r.status)),
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
      box.append(h("div", { class: `stage ${st}`, style: agentVar(s.name) },
        h("div", { class: "row" }, stageName(s.name, s.title), stateLabel(st)),
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

  function stageName(agent, title) {
    const custom = state.config.pipeline.some((p) => p.name === agent && p.custom);
    return h("span", { class: "name" }, h("span", { class: "ico", "aria-hidden": "true" }, agentStyle(agent).icon), title,
      custom ? h("span", { class: "tag custom" }, "custom") : null);
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
        class: "tab" + (state.tab === t.key ? " active" : ""), role: "tab", style: cvar(t.color),
        "aria-selected": state.tab === t.key ? "true" : "false",
        onclick: () => { state.tab = t.key; renderTabs(); renderTab(); },
      }, h("span", { "aria-hidden": "true" }, t.icon), t.title, n != null ? h("span", { class: "count" }, n) : null));
    }
  }

  function renderTab() {
    const body = $("#tabBody");
    body.innerHTML = "";
    body.style.cssText = cvar(TABS.find((t) => t.key === state.tab).color);
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
    const hasReport = r.result || Object.values(r.instances).some((i) => i.report);
    if (hasReport && !running()) {
      body.append(h("div", { class: "tab-toolbar" },
        h("span", { class: "muted small" }, "Final report, agent reports and changed files for this run"),
        h("button", { class: "btn sm primary", type: "button", disabled: state.pdfBusy, onclick: downloadReportPdf },
          state.pdfBusy ? "Generating PDF…" : "⬇ Download report (PDF)")));
    }
    if (r.result) body.append(h("div", { class: "md", html: md(r.result) }));
    else body.append(h("div", { class: "empty" }, running() ? "Agents are working — the final report will appear here when the run finishes. Output tabs update as files are written." : "This run did not produce a final report. Check the live activity log above."));

    const reps = Object.values(r.instances).filter((i) => i.report);
    if (reps.length) {
      body.append(h("h2", { style: "margin:18px 0 4px" }, "Agent reports"));
      for (const i of reps) {
        body.append(h("details", { class: "report-agent", style: agentVar(i.agent) },
          h("summary", {}, h("span", { class: `dot ${i.status}` }), agentStyle(i.agent).icon,
            h("span", { class: "who" }, i.agent), h("span", { class: "muted" }, "— " + i.desc)),
          h("div", { class: "md", html: md(i.report) })));
      }
    }
    if (r.hasChanged) body.append(changedFilesCard(r));
  }

  /* --------------------------------------------------------- report PDF --- */
  const PDF_CSS = `
    @page { size: A4; margin: 16mm 14mm; }
    * { box-sizing: border-box; }
    body { font: 10.5pt/1.5 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; }
    header { border-bottom: 3px solid #4f46e5; padding-bottom: 8px; margin-bottom: 14px; }
    header h1 { font-size: 18pt; margin: 0 0 2px; color: #4f46e5; }
    .meta { width: 100%; border-collapse: collapse; font-size: 9pt; margin-top: 6px; }
    .meta td { padding: 2px 8px 2px 0; vertical-align: top; }
    .meta td:first-child { color: #64748b; width: 110px; white-space: nowrap; }
    h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
    h2.section { font-size: 13pt; color: #fff; background: #4f46e5; padding: 4px 10px; border-radius: 4px; margin: 20px 0 10px; }
    .md h1 { font-size: 15pt; color: #4f46e5; } .md h2 { font-size: 13pt; color: #4f46e5; } .md h3 { font-size: 11.5pt; }
    table { border-collapse: collapse; margin: 8px 0; font-size: 9pt; width: 100%; }
    th, td { border: 1px solid #cbd5e1; padding: 3px 6px; text-align: left; vertical-align: top; word-break: break-word; }
    th { background: #eef2ff; }
    tr, img, pre { page-break-inside: avoid; break-inside: avoid; }
    code { font-family: Consolas, "Cascadia Code", monospace; font-size: 8.5pt; background: #f1f5f9; padding: 0 3px; border-radius: 3px; }
    pre { background: #f8fafc; border: 1px solid #e2e8f0; padding: 8px; white-space: pre-wrap; word-break: break-word; }
    pre code { background: none; padding: 0; }
    .agent { border-left: 4px solid var(--c); padding: 2px 0 2px 12px; margin: 14px 0; }
    .agent > h3 { color: var(--c); margin: 4px 0 2px; font-size: 12pt; }
    .agent .desc { color: #64748b; font-size: 9pt; margin-bottom: 6px; }
    .files { font-family: Consolas, monospace; font-size: 8.5pt; columns: 2; column-gap: 18px; }
    .files div { break-inside: avoid; }
    .files .folder { font-weight: 700; color: #4f46e5; margin-top: 6px; }
    footer { margin-top: 24px; font-size: 8pt; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 6px; }`;
  // Print-safe hues (deep enough for white paper).
  const PDF_COLORS = { indigo: "#4f46e5", teal: "#0f766e", blue: "#2563eb", violet: "#7c3aed", orange: "#c2410c", pink: "#be185d", amber: "#b45309", green: "#15803d", cyan: "#0e7490", slate: "#475569" };
  const fmtWhen = (t) => t ? new Date(t * 1000).toLocaleString() : "—";

  function buildReportHtml() {
    const r = state.run;
    const reps = Object.values(r.instances).filter((i) => i.report);
    const agentsRun = Object.values(r.instances);
    const statusOf = (i) => ({ done: "completed", failed: "failed", running: "running" }[i.status] || i.status);
    const meta = [
      ["Instruction", esc(r.prompt || "—")],
      ["Run ID", esc(r.id)],
      ["Status", esc(r.status)],
      ["Started", esc(fmtWhen(r.started))],
      ["Duration", r.ended ? esc(fmtDur(r.ended - r.started)) : "—"],
      ["Agent tasks", agentsRun.length ? agentsRun.map((i) => `${esc(i.agent)} (${esc(statusOf(i))})`).join(", ") : "—"],
    ].filter(Boolean).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

    let out = `<header><h1>CDR &amp; IPDR Analysis Report</h1><table class="meta">${meta}</table></header>`;
    out += `<h2 class="section">Summary</h2><div class="md">${r.result ? md(r.result) : "<p><em>This run did not produce a final report.</em></p>"}</div>`;
    if (reps.length) {
      out += `<h2 class="section">Agent reports</h2>`;
      for (const i of reps) {
        out += `<section class="agent" style="--c:${PDF_COLORS[agentStyle(i.agent).color] || "#475569"}">` +
          `<h3>${esc(i.agent)}</h3><div class="desc">${esc(i.desc || "")} · ${esc(statusOf(i))}</div>` +
          `<div class="md">${md(i.report)}</div></section>`;
      }
    }
    if (r.hasChanged && r.changed.size) {
      out += `<h2 class="section">Files created or updated (${r.changed.size})</h2><div class="files">`;
      let last = null;
      for (const p of [...r.changed].sort()) {
        const folder = p.slice(0, p.lastIndexOf("/"));
        if (folder !== last) { out += `<div class="folder">${esc(folder)}/</div>`; last = folder; }
        out += `<div>${esc(p.slice(folder.length + 1))}</div>`;
      }
      out += `</div>`;
    }
    out += `<footer>Generated ${esc(new Date().toLocaleString())} by the CDR &amp; IPDR Agent Console. Contains personal data from telecom records — handle according to your legal authority and data-protection rules.</footer>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>CDR &amp; IPDR report ${esc(r.id)}</title><style>${PDF_CSS}</style></head><body>${out}</body></html>`;
  }

  async function downloadReportPdf() {
    const r = state.run;
    const html = buildReportHtml();
    state.pdfBusy = true; renderTab();
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(r.id)}/report.pdf`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html }),
      });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        const a = h("a", { href: url, download: `CDR_IPDR_report_${r.id}.pdf` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else {
        printFallback(html);
      }
    } catch (e) {
      printFallback(html);
    } finally {
      state.pdfBusy = false; renderTab();
    }
  }

  // No headless browser on the server: open the same page and let the user "Save as PDF" from the print dialog.
  function printFallback(html) {
    const w = window.open("", "_blank");
    if (!w) { showError("PDF export failed and the print window was blocked. Allow pop-ups for this page and try again."); return; }
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { /* window closed */ } }, 500);
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
        if (folder !== lastFolder) { list.append(h("div", { class: "cf-folder", style: folderVar(folder) }, folder + "/")); lastFolder = folder; }
        const f = info.get(p);
        list.append(h("div", { class: "cf-row" },
          kindBadge(f || { name: p, kind: "binary" }),
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
      body.append(h("div", { class: "folder-title", style: folderVar(folder) }, folder + "/"));
      const grid = h("div", { class: "gallery" });
      for (const f of list) {
        const my = idx++;
        const svg = svgFor(f);
        grid.append(h("div", { class: "viz", style: folderVar(folder) },
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
        }, h("span", { class: "fn" }, kindBadge(f), h("span", {}, f.name), isNew(f.path) ? h("span", { class: "badge-new" }, "NEW") : null), h("span", { class: "sz" }, fmtSize(f.size))));
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
