"""Web console for the CDR/IPDR agent pipeline.

Runs Claude Code headlessly in the workspace root (so the project subagents in
.claude/agents are available), streams progress to the browser over SSE, and
serves the generated outputs for preview and download.

Start (from the project root):  python webapp/app.py   then open http://127.0.0.1:5050
"""
import csv
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template, request, send_file

ROOT = Path(__file__).resolve().parent.parent
RUNS_DIR = Path(__file__).resolve().parent / "runs"
RUNS_DIR.mkdir(exist_ok=True)

# Folders the agents write to. Only these are browsable/downloadable.
OUTPUT_ROOTS = ["normalized", "analysis", "visuals", "powerbi"]
SCRIPT_DIRS = {"analysis/scripts", "visuals/scripts", "powerbi/scripts"}
RAW_EXTS = {".xls", ".xlsx", ".csv"}

# Pipeline order; used for the status cards and the orchestrator prompt.
PIPELINE = [
    ("record-normalizer", "Record Normalizer", "Clean raw exports into one schema"),
    ("cdr-analyst", "CDR Analyst", "Contacts, timing, towers, IMEI/IMSI"),
    ("ipdr-analyst", "IPDR Analyst", "NAT mapping, destinations, services"),
    ("link-analyzer", "Link Analyzer", "Cross-file links and co-location"),
    ("viz-generator", "Visualization", "Charts, maps and network graphs"),
    ("powerbi-dashboard", "Power BI", "Star-schema model and .pbip report"),
]
AGENT_NAMES = [p[0] for p in PIPELINE]

ALLOWED_TOOLS = "Read,Write,Edit,Glob,Grep,Bash,Agent,Task,WebFetch,TodoWrite"

ORCHESTRATOR_PROMPT = """You are the orchestrator of the CDR/IPDR analysis pipeline in this workspace, driven from a web console.
No human can answer questions during the run: never ask for clarification, make reasonable assumptions and state them.

Delegate all work to the project subagents with the Agent tool (subagent_type = agent name). Do not do the analysis yourself.
Pipeline, in order:
  1. record-normalizer  - normalize every raw record file in the workspace root into ./normalized/
  2. cdr-analyst (one per CDR file) and ipdr-analyst (one per IPDR file) - launch these in parallel in a single message
  3. link-analyzer      - cross-file links into ./analysis/links/
  4. viz-generator      - images into ./visuals/
  5. powerbi-dashboard  - Power BI project into ./powerbi/

- "Run all agents" (or similar) means the full pipeline in that order.
- If the user names specific agents, run only those, in pipeline order, reusing existing outputs of earlier stages.
- If the user names specific files, restrict the work to them.
- Give each subagent a complete, self-contained task: exact input file paths and where to write outputs.

Raw record files currently in the workspace root: {raw_files}

When finished, reply with a concise markdown report: a table of the agents that ran with their status, the key findings (with numbers), and the main output paths."""

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config["JSON_SORT_KEYS"] = False

RUNS = {}          # run_id -> Run
RUN_LOCK = threading.Lock()
ACTIVE = {"id": None}


# ---------------------------------------------------------------- helpers ---

def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def safe_path(relpath: str) -> Path:
    """Resolve a workspace-relative path, allowing only the output folders."""
    if not relpath:
        abort(400)
    p = (ROOT / relpath).resolve()
    try:
        parts = p.relative_to(ROOT).parts
    except ValueError:
        abort(403)
    if not parts or parts[0] not in OUTPUT_ROOTS or not p.is_file():
        abort(404)
    return p


def raw_files():
    return sorted(p.name for p in ROOT.iterdir() if p.is_file() and p.suffix.lower() in RAW_EXTS)


def snapshot_outputs():
    snap = {}
    for r in OUTPUT_ROOTS:
        base = ROOT / r
        if base.exists():
            for p in base.rglob("*"):
                if p.is_file():
                    st = p.stat()
                    snap[rel(p)] = (st.st_mtime_ns, st.st_size)
    return snap


def file_kind(p: Path) -> str:
    ext = p.suffix.lower()
    return {
        ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".svg": "image",
        ".csv": "csv", ".md": "markdown", ".html": "html", ".htm": "html", ".mmd": "mermaid",
        ".json": "text", ".py": "text", ".dax": "text", ".tmdl": "text", ".txt": "text",
        ".pbip": "text", ".pbir": "text", ".pbism": "text", ".m": "text",
    }.get(ext, "binary")


def group_of(relpath: str) -> str:
    parts = relpath.split("/")
    top = parts[0]
    if "/".join(parts[:2]) in SCRIPT_DIRS or relpath.endswith(".py"):
        return "scripts"
    if top == "analysis" and len(parts) > 1 and parts[1] == "links":
        return "links"
    return top


def visual_captions():
    """Map 'visuals/<path>.png' -> caption, parsed from the tables in visuals/index.md."""
    caps = {}
    idx = ROOT / "visuals" / "index.md"
    if not idx.exists():
        return caps
    for line in idx.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"\|\s*\[[^\]]+\]\(([^)]+)\)[^|]*\|\s*([^|]+)\|\s*([^|]*)\|", line)
        if m:
            caps["visuals/" + m.group(1).strip()] = {
                "caption": m.group(2).strip(),
                "source": m.group(3).strip().strip("`"),
            }
    return caps


# -------------------------------------------------------------------- runs ---

class Run:
    def __init__(self, prompt, model):
        self.id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.prompt = prompt
        self.model = model
        self.status = "starting"
        self.started = now_iso()
        self.ended = None
        self.events = []
        self.cond = threading.Condition()
        self.proc = None
        self.stop_requested = False
        self.result = None
        self.cost = None
        self.changed = []
        self.agent_names = {}       # tool_use_id -> subagent_type
        self.bg_tasks = {}          # tool_use_id -> description, for background Bash etc. (not agents)
        self.tool_owner = {}        # tool_use_id -> (owning agent tool_use_id or None, agent name)
        self.dir = RUNS_DIR / self.id
        self.dir.mkdir(parents=True, exist_ok=True)
        self._raw = open(self.dir / "raw.jsonl", "a", encoding="utf-8")
        self._ev = open(self.dir / "events.jsonl", "a", encoding="utf-8")

    def meta(self):
        return {
            "id": self.id, "prompt": self.prompt, "model": self.model, "status": self.status,
            "started": self.started, "ended": self.ended, "cost": self.cost,
            "result": self.result, "changed": self.changed,
        }

    def emit(self, kind, **data):
        ev = {"seq": len(self.events), "t": time.time(), "kind": kind, **data}
        with self.cond:
            self.events.append(ev)
            self._ev.write(json.dumps(ev, ensure_ascii=False) + "\n")
            self._ev.flush()
            self.cond.notify_all()

    def save_meta(self):
        (self.dir / "meta.json").write_text(json.dumps(self.meta(), indent=2), encoding="utf-8")

    def close(self):
        for f in (self._raw, self._ev):
            try:
                f.close()
            except Exception:
                pass


class PastRun:
    """A finished run loaded from disk (read-only)."""

    def __init__(self, d: Path):
        m = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        self.__dict__.update(m)
        self.dir = d
        self.cond = threading.Condition()
        self._events = None
        if self.status in ("running", "starting"):
            self.status = "interrupted"

    @property
    def events(self):
        if self._events is None:
            f = self.dir / "events.jsonl"
            self._events = [json.loads(l) for l in f.open(encoding="utf-8")] if f.exists() else []
            self._events = repair_events(self._events, self.dir / "raw.jsonl")
        return self._events

    def meta(self):
        return {k: getattr(self, k, None) for k in
                ("id", "prompt", "model", "status", "started", "ended", "cost", "result", "changed")}


def is_agent_task(e):
    tt = e.get("task_type")
    return tt == "local_agent" or (tt is None and bool(e.get("subagent_type")))


def repair_events(events, raw_path: Path):
    """Older runs recorded background Bash tasks as agents; turn them back into feed warnings."""
    if not raw_path.exists():
        return events
    bg, owner, names = {}, {}, {}
    for line in raw_path.open(encoding="utf-8"):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("subtype") == "task_started":
            if is_agent_task(e):
                names[e.get("tool_use_id")] = e.get("subagent_type")
            else:
                bg[e.get("tool_use_id")] = e.get("description", "")
        elif e.get("type") == "assistant":
            for b in e.get("message", {}).get("content", []) or []:
                if b.get("type") == "tool_use":
                    owner[b.get("id")] = e.get("parent_tool_use_id")
    if not bg:
        return events
    out = []
    for ev in events:
        if ev.get("kind") in ("agent_start", "agent_end") and ev.get("id") in bg:
            if ev["kind"] == "agent_end" and ev.get("status") != "completed":
                aid = owner.get(ev["id"])
                out.append({**{k: ev[k] for k in ("seq", "t")}, "kind": "tool_error", "agent_id": aid,
                            "agent": names.get(aid, "orchestrator") if aid else "orchestrator",
                            "detail": f"Command {ev.get('status')}: {bg[ev['id']]}"})
            continue
        out.append(ev)
    for i, ev in enumerate(out):
        ev["seq"] = i
    return out


def load_past_runs():
    for d in sorted(RUNS_DIR.iterdir()):
        if (d / "meta.json").exists():
            try:
                RUNS[d.name] = PastRun(d)
            except Exception:
                pass


def short(s, n=220):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def tool_detail(name, inp):
    inp = inp or {}
    if name == "Bash":
        return short(inp.get("description") or inp.get("command", ""))
    if name in ("Read", "Write", "Edit", "NotebookEdit"):
        fp = inp.get("file_path", "")
        try:
            fp = Path(fp).resolve().relative_to(ROOT).as_posix()
        except Exception:
            pass
        return fp
    if name in ("Glob", "Grep"):
        return short(inp.get("pattern", ""))
    if name == "WebFetch":
        return short(inp.get("url", ""))
    if name == "TodoWrite":
        todos = inp.get("todos") or []
        active = [t.get("activeForm") or t.get("content") for t in todos if t.get("status") == "in_progress"]
        return short(active[0]) if active else f"{len(todos)} todo items"
    return short(json.dumps(inp, ensure_ascii=False))


def block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def handle_raw(run: Run, e: dict):
    t, st = e.get("type"), e.get("subtype")
    parent = e.get("parent_tool_use_id")

    if t == "system" and st == "init":
        run.emit("init", model=e.get("model"), session_id=e.get("session_id"))
    elif t == "system" and st == "task_started":
        tid = e.get("tool_use_id")
        if not is_agent_task(e):
            # Long-running Bash command etc. It is already shown as a tool call of its owner.
            run.bg_tasks[tid] = e.get("description", "")
            return
        agent = e.get("subagent_type") or run.agent_names.get(tid) or "agent"
        run.agent_names[tid] = agent
        run.emit("agent_start", id=tid, agent=agent, description=e.get("description", ""))
    elif t == "system" and st == "task_notification":
        tid = e.get("tool_use_id")
        if tid in run.bg_tasks:
            if e.get("status") != "completed":
                aid, name = run.tool_owner.get(tid, (None, "orchestrator"))
                run.emit("tool_error", agent=name, agent_id=aid,
                         detail=f"Command {e.get('status')}: {run.bg_tasks[tid]}")
            return
        run.emit("agent_end", id=tid, agent=run.agent_names.get(tid, "agent"),
                 status=e.get("status", "completed"), summary=short(e.get("summary", ""), 400),
                 usage=e.get("usage") or {})
    elif t == "assistant":
        agent_id = parent
        agent = run.agent_names.get(parent, "orchestrator") if parent else "orchestrator"
        for b in e.get("message", {}).get("content", []) or []:
            bt = b.get("type")
            if bt == "tool_use":
                name = b.get("name")
                run.tool_owner[b.get("id")] = (agent_id, agent)
                if name in ("Agent", "Task"):
                    run.agent_names[b.get("id")] = (b.get("input") or {}).get("subagent_type", "agent")
                    continue
                run.emit("tool", agent=agent, agent_id=agent_id, tool=name,
                         detail=tool_detail(name, b.get("input")))
            elif bt == "text" and b.get("text", "").strip():
                run.emit("say", agent=agent, agent_id=agent_id, text=b["text"] if not parent else short(b["text"], 600))
    elif t == "user" and not parent:
        # Final hand-back reports of subagents arrive as tool_results in the main thread.
        for b in e.get("message", {}).get("content", []) if isinstance(e.get("message", {}).get("content"), list) else []:
            if b.get("type") == "tool_result" and b.get("tool_use_id") in run.agent_names:
                text = block_text(b.get("content"))
                text = re.sub(r"^\[Subagent hand-back\][^\n]*\n+", "", text).strip()
                run.emit("agent_report", id=b["tool_use_id"], agent=run.agent_names[b["tool_use_id"]],
                         text=text, is_error=bool(b.get("is_error")))
    elif t == "result":
        run.result = e.get("result") or ""
        run.cost = e.get("total_cost_usd")
        run.emit("result", text=run.result, is_error=bool(e.get("is_error")), cost=run.cost,
                 duration_ms=e.get("duration_ms"), turns=e.get("num_turns"))


def run_worker(run: Run):
    claude = shutil.which("claude") or shutil.which("claude.exe")
    if not claude:
        run.emit("error", text="Claude Code CLI ('claude') was not found on PATH.")
        finish(run, "failed", {})
        return

    before = snapshot_outputs()
    sys_prompt = ORCHESTRATOR_PROMPT.format(raw_files=", ".join(raw_files()) or "(none)")
    cmd = [claude, "-p", run.prompt, "--output-format", "stream-json", "--verbose",
           "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS,
           "--append-system-prompt", sys_prompt]
    if run.model:
        cmd += ["--model", run.model]

    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    if os.name == "nt":
        flags |= subprocess.CREATE_NO_WINDOW
    try:
        run.proc = subprocess.Popen(cmd, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, creationflags=flags)
    except Exception as ex:
        run.emit("error", text=f"Failed to start Claude Code: {ex}")
        finish(run, "failed", before)
        return

    run.status = "running"
    run.save_meta()
    run.emit("status", status="running")

    stderr_lines = []

    def read_stderr():
        for line in run.proc.stderr:
            s = line.decode("utf-8", errors="replace").rstrip()
            if s:
                stderr_lines.append(s)
                run.emit("log", text=short(s, 500))

    threading.Thread(target=read_stderr, daemon=True).start()

    for line in run.proc.stdout:
        s = line.decode("utf-8", errors="replace").strip()
        if not s:
            continue
        run._raw.write(s + "\n")
        try:
            e = json.loads(s)
        except json.JSONDecodeError:
            run.emit("log", text=short(s, 500))
            continue
        try:
            handle_raw(run, e)
        except Exception as ex:  # never let one odd event kill the stream
            run.emit("log", text=f"(event parse error: {ex})")

    code = run.proc.wait()
    if run.stop_requested:
        status = "stopped"
    elif code == 0 and run.result is not None:
        status = "completed"
    else:
        status = "failed"
        if not run.result:
            run.emit("error", text=f"Claude Code exited with code {code}. " + " ".join(stderr_lines[-3:]))
    finish(run, status, before)


def finish(run: Run, status, before):
    after = snapshot_outputs()
    run.changed = sorted(p for p, sig in after.items() if before.get(p) != sig)
    run.status = status
    run.ended = now_iso()
    run.emit("files_changed", files=run.changed)
    run.emit("status", status=status)
    run.save_meta()
    run.close()
    with RUN_LOCK:
        if ACTIVE["id"] == run.id:
            ACTIVE["id"] = None


def kill_tree(proc):
    if proc and proc.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            proc.terminate()


# ------------------------------------------------------------------ routes ---

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/config")
def config():
    return jsonify({
        "pipeline": [{"name": n, "title": t, "blurb": b} for n, t, b in PIPELINE],
        "raw_files": raw_files(),
        "active": ACTIVE["id"],
        "claude_found": bool(shutil.which("claude") or shutil.which("claude.exe")),
    })


@app.post("/api/runs")
def start_run():
    body = request.get_json(force=True, silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    model = (body.get("model") or "").strip() or None
    if not prompt:
        return jsonify({"error": "Enter an instruction first."}), 400
    if model and model not in ("sonnet", "opus", "haiku", "fable"):
        return jsonify({"error": "Unknown model."}), 400
    with RUN_LOCK:
        if ACTIVE["id"]:
            return jsonify({"error": "A run is already in progress.", "id": ACTIVE["id"]}), 409
        run = Run(prompt, model)
        RUNS[run.id] = run
        ACTIVE["id"] = run.id
    run.save_meta()
    run.emit("status", status="starting", prompt=prompt)
    threading.Thread(target=run_worker, args=(run,), daemon=True).start()
    return jsonify({"id": run.id})


@app.get("/api/runs")
def list_runs():
    runs = sorted(RUNS.values(), key=lambda r: r.id, reverse=True)[:30]
    return jsonify([{k: v for k, v in r.meta().items() if k != "result"} for r in runs])


@app.get("/api/runs/<run_id>")
def get_run(run_id):
    r = RUNS.get(run_id) or abort(404)
    return jsonify({**r.meta(), "events": r.events})


@app.post("/api/runs/<run_id>/stop")
def stop_run(run_id):
    r = RUNS.get(run_id) or abort(404)
    if isinstance(r, Run) and r.status in ("starting", "running"):
        r.stop_requested = True
        r.emit("log", text="Stop requested by user.")
        kill_tree(r.proc)
    return jsonify({"ok": True})


@app.get("/api/runs/<run_id>/stream")
def stream(run_id):
    r = RUNS.get(run_id) or abort(404)
    start = int(request.headers.get("Last-Event-ID", -1)) + 1 if request.headers.get("Last-Event-ID") \
        else int(request.args.get("from", 0))

    def gen():
        i = start
        last_beat = time.time()
        while True:
            with r.cond:
                if i >= len(r.events):
                    r.cond.wait(timeout=10)
                batch = r.events[i:]
            for ev in batch:
                yield f"id: {ev['seq']}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
            i += len(batch)
            done = r.status not in ("starting", "running")
            if done and i >= len(r.events):
                yield "event: end\ndata: {}\n\n"
                return
            if time.time() - last_beat > 15:
                last_beat = time.time()
                yield ": keep-alive\n\n"

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/files")
def list_files():
    caps = visual_captions()
    groups = {g: [] for g in ("visuals", "analysis", "links", "normalized", "powerbi", "scripts")}
    for r in OUTPUT_ROOTS:
        base = ROOT / r
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file() or "__pycache__" in p.parts or p.name.startswith("."):
                continue
            rp = rel(p)
            g = group_of(rp)
            if g not in groups:
                continue
            st = p.stat()
            item = {
                "path": rp, "name": p.name, "folder": p.parent.relative_to(ROOT).as_posix(),
                "size": st.st_size, "mtime": st.st_mtime, "kind": file_kind(p),
            }
            if rp in caps:
                item.update(caps[rp])
            groups[g].append(item)
    return jsonify(groups)


@app.get("/files/<path:relpath>")
def serve_file(relpath):
    p = safe_path(relpath)
    download = request.args.get("download") == "1"
    return send_file(p, as_attachment=download, download_name=p.name, max_age=0)


@app.get("/api/preview")
def preview():
    p = safe_path(request.args.get("path", ""))
    kind = file_kind(p)
    limit = min(int(request.args.get("rows", 500)), 5000)
    if kind == "csv":
        with p.open(encoding="utf-8-sig", errors="replace", newline="") as f:
            reader = csv.reader(f)
            header = next(reader, [])
            rows = []
            total = 0
            for row in reader:
                if total < limit:
                    rows.append(row)
                total += 1
        return jsonify({"kind": "csv", "columns": header, "rows": rows, "total_rows": total,
                        "truncated": total > limit})
    if kind in ("text", "markdown", "mermaid", "html"):
        if p.stat().st_size > 2_000_000:
            return jsonify({"kind": kind, "text": "(file too large to preview — download it instead)"})
        return jsonify({"kind": kind, "text": p.read_text(encoding="utf-8", errors="replace")})
    return jsonify({"kind": kind})


@app.get("/api/zip")
def zip_download():
    scope = request.args.get("scope", "all")
    paths = []
    if scope == "run":
        r = RUNS.get(request.args.get("run", "")) or abort(404)
        paths = [ROOT / p for p in (r.changed or []) if (ROOT / p).is_file()]
        name = f"run_{r.id}_outputs.zip"
    elif scope == "files":
        body = request.args.getlist("path")
        paths = [safe_path(p) for p in body]
        name = "selected_files.zip"
    else:
        for r_ in OUTPUT_ROOTS:
            base = ROOT / r_
            if base.exists():
                for p in base.rglob("*"):
                    if p.is_file() and "__pycache__" not in p.parts and (scope == "all" or group_of(rel(p)) == scope):
                        paths.append(p)
        name = "cdr_ipdr_all_outputs.zip" if scope == "all" else f"cdr_ipdr_{scope}.zip"
    if not paths:
        return jsonify({"error": "No files to download."}), 404

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
        for p in paths:
            z.write(p, rel(p))

    resp = send_file(tmp.name, as_attachment=True, download_name=name, mimetype="application/zip")
    resp.call_on_close(lambda: os.path.exists(tmp.name) and os.remove(tmp.name))
    return resp


if __name__ == "__main__":
    load_past_runs()
    port = int(os.environ.get("PORT", 5050))
    print(f"CDR/IPDR agent console on http://127.0.0.1:{port}  (workspace: {ROOT})")
    app.run(host="127.0.0.1", port=port, threaded=True, debug=False)
