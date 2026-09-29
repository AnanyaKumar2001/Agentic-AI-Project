# CDR & IPDR Agent Console

A local web interface for running the project's Claude Code subagents (`.claude/agents/*`) and viewing their outputs.

## Start
See the [main README](../README.md) for installation. Then double-click `webapp\start_console.bat`, or run from the project root:

    python webapp/app.py

Then open http://127.0.0.1:5050. It listens on localhost only.

## Use
- Type an instruction such as `Run all agents`, `Run the cdr-analyst and viz-generator agents`, or
  `Run the cdr-analyst on <your-cdr-file>.xls`. You can also click the chips to fill in the instruction. Press Enter or click **Run**.
- **Run status**: the orchestrator card, plus one card per pipeline agent (Idle / Running / Done / Failed / Not run), each
  showing its parallel tasks, elapsed time and current tool call. The **Live activity** feed lists every step.
  **Stop** ends the run and any processes it started.
- **Outputs** tabs: Report (final summary + each agent's report) · Visuals (gallery with lightbox) · Analysis ·
  Link Analysis (CSV tables, Leaflet map, Mermaid graph) · Normalized · Power BI · Scripts.
  Each file has a Download button, each tab has a *Download all (.zip)* button, and the header has *Download all* and
  *Download this run's files*. Tick *Only files changed in this run* to see only what the selected run produced (these files are marked NEW).
- **Run** dropdown (top right): reopen earlier runs. Their logs are stored in `webapp/runs/<id>/`.

## How it works
`app.py` (Flask) starts `claude -p "<instruction>" --output-format stream-json` in the workspace root, with an orchestrator
system prompt that delegates to the subagents in pipeline order. Allowed tools: Read, Write, Edit, Glob, Grep, Bash, Agent, WebFetch, TodoWrite; the run is non-interactive, so there are no permission prompts.
Only one run can be active at a time. Downloads are limited to `normalized/`, `analysis/`, `visuals/` and `powerbi/`; the raw evidence files are never served.
