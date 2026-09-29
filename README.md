# CDR & IPDR Analysis Agents

A multi-agent pipeline, built on [Claude Code](https://claude.com/claude-code) subagents, for analyzing telecom **Call Detail Records (CDR)** and **Internet Protocol Detail Records (IPDR)** from Indian operators (Airtel, Jio, Vi, BSNL, MTNL). It comes with a local **web console**: type an instruction such as "Run all agents", watch each agent's progress live, then browse and download the results.

> Built for lawful investigative research. Record files contain personal data, so keep them on the machine and out of version control (see [Data and privacy](#data-and-privacy)).

## The agents

| # | Agent | What it does | Writes to |
|---|---|---|---|
| 1 | `record-normalizer` | Converts raw `.xls` / `.xlsx` / `.csv` exports from any operator into one standard CDR or IPDR schema (clean numbers, ISO timestamps, IMEI as text) | `normalized/` |
| 2 | `cdr-analyst` | Per CDR: top contacts, call timing, late-night activity, cell towers and movement, IMEI/IMSI changes, anomalies | `analysis/<file>/` |
| 2 | `ipdr-analyst` | Per IPDR: NAT mapping, destination IPs and ports, likely services (RDAP), session patterns | `analysis/<file>/` |
| 3 | `link-analyzer` | Across files: common contacts, shared devices, co-location, call chains, CDR↔IPDR overlaps, Mermaid link graph | `analysis/links/` |
| 4 | `viz-generator` | PNG/SVG charts: activity heatmaps, top contacts, timelines, tower movement maps, network graphs | `visuals/` |
| 5 | `powerbi-dashboard` | Star-schema data model, DAX measures and a Power BI project (`.pbip`), plus an Excel fallback | `powerbi/` |

The agent definitions are in [`.claude/agents/`](.claude/agents). The two stage-2 agents run in parallel.

## Project structure

```
.
├── .claude/
│   ├── agents/             # the six subagent definitions
│   └── settings.json
├── webapp/                 # web console (Flask + vanilla JS)
│   ├── app.py
│   ├── start_console.bat   # Windows one-click launcher
│   ├── static/  templates/
│   └── runs/               # run logs (created at runtime, git-ignored)
├── powerbi/                # theme.json, measures.dax (+ generated project, git-ignored)
├── normalized/ analysis/ visuals/   # generated outputs (git-ignored)
├── requirements.txt
└── <your record files>.xls / .xlsx / .csv   # inputs, in the project root (git-ignored)
```

## Prerequisites

1. **Python 3.12+**: https://www.python.org/downloads/ (on Windows, tick *Add python.exe to PATH*).
2. **Claude Code CLI**, installed and signed in. The console runs the agents through it.
   ```bash
   # Windows (PowerShell)
   irm https://claude.ai/install.ps1 | iex
   # macOS / Linux
   curl -fsSL https://claude.ai/install.sh | bash
   ```
   Then run `claude` once in a terminal and sign in. Check with `claude --version`.
   Every run uses your Claude plan or API credits. A full "Run all agents" makes many model calls.
3. **Git**, to clone the repository.
4. *(Optional)* **Microsoft Edge or Google Chrome**, for one-click PDF export of reports (preinstalled on Windows).
5. *(Optional)* **Power BI Desktop** (Windows), to open the generated dashboard.

## Installation

```bash
git clone https://github.com/<your-account>/<your-repo>.git
cd <your-repo>

# create and activate a virtual environment (recommended)
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

pip install -r requirements.txt
```

## Add your record files

Copy the raw operator exports (`.xls`, `.xlsx` or `.csv`, CDR and/or IPDR) into the **project root**, next to this README. They don't need any preparation: the `record-normalizer` agent finds the header rows, detects the operator and works out whether each file is a CDR or an IPDR. Source files are treated as read-only evidence and are never modified.

## Running the web console

**Windows, one click:** double-click `webapp\start_console.bat`. It uses `.venv` if present, installs the requirements if they're missing, starts the server and opens your browser.

**Any OS, from the project root:**
```bash
python webapp/app.py
```
Then open **http://127.0.0.1:5050**. To use another port, set the `PORT` environment variable, e.g. `PORT=8080 python webapp/app.py` (PowerShell: `$env:PORT=8080; python webapp/app.py`).

The server listens on `127.0.0.1` only. Stop it with `Ctrl+C` in its terminal.

### Using the console

1. **Enter an instruction** and press **Run** (or Enter). For example:
   - `Run all agents`: the full pipeline, in order
   - `Run the cdr-analyst and viz-generator agents`: only those, reusing earlier outputs
   - `Run the ipdr-analyst on <file>.xlsx and regenerate the visuals`

   You can also click **Run all agents** or the agent chips to fill in the instruction, and choose a model (default, Sonnet, Opus or Haiku).
2. **Watch the run status.** There's a card for the orchestrator and one for each agent (Idle → Running → Done / Failed / Not run), with parallel tasks, elapsed time, tool-call counts and the current step. The **Live activity** feed logs every action. **Stop** cancels the run.
3. **Browse the outputs in tabs:**
   - **Report**: the final summary, each agent's full report, and a scrollable list of the files created or updated
   - **Visuals**: every chart in a gallery; click one to view it full screen (← / → to move between charts)
   - **Analysis**, **Link Analysis**, **Normalized**: CSV tables you can filter, markdown, the tower map, the Mermaid link graph
   - **Power BI**, **Scripts**: project files and the generated Python scripts
4. **Download** a single file, a whole tab (`.zip`), only the files this run changed, or everything (`.zip`).
   In the **Report** tab, **⬇ Download report (PDF)** saves an A4 PDF with the run details, the summary, every agent's report and the list of changed files.
   The PDF is printed by a headless **Microsoft Edge or Google Chrome** (found automatically; set `PDF_BROWSER` to a browser's path to choose one).
   If neither is installed, your browser's print dialog opens instead; choose *Save as PDF*.
   Tick *Only files changed in this run* to filter the tabs down to the latest results.
5. **Reopen earlier runs** from the **Run** dropdown at the top right.

Only one run can be active at a time. Rendering markdown and Mermaid diagrams needs internet access (the libraries load from a CDN); without it, they show as plain text.

## Running the agents without the web console

From the project root, in Claude Code:

```bash
claude
> Run all agents: normalize the record files, analyze each CDR and IPDR, run link analysis, generate visuals and build the Power BI dashboard.
```

Or ask for one agent directly, e.g. *"Use the cdr-analyst agent on 9XXXXXXXXX.xls"*.

## Opening the Power BI dashboard

After `powerbi-dashboard` runs, open `powerbi/CDR_IPDR_Dashboard.pbip` in Power BI Desktop. If asked, enable *Power BI Project (.pbip)* under *Options → Preview features*. The generated `powerbi/README.md` explains how to change the data-folder parameter and gives a manual fallback that uses `CDR_IPDR_Model.xlsx`.

## Data and privacy

CDR/IPDR files and everything derived from them contain phone numbers, IMEIs/IMSIs, IP addresses and locations. The `.gitignore` therefore excludes:

- all `.xls`, `.xlsx`, `.xlsm` and `.csv` files
- `normalized/`, `analysis/` and `visuals/`, including the case-specific scripts the agents generate there
- the generated Power BI project and data (only `theme.json` and `measures.dax` are tracked)
- `webapp/runs/` (run logs contain findings)

Before you push, check the diff with `git status` and `git diff --cached`. Never force-add ignored data (`git add -f`).

## Troubleshooting

| Problem | Fix |
|---|---|
| Red banner: *Claude Code CLI ('claude') was not found on PATH* | Install Claude Code (see Prerequisites), open a new terminal and check `claude --version`, then restart the console. |
| Run fails at once with an authentication error | Run `claude` in a terminal and sign in again. |
| `ModuleNotFoundError` (flask, pandas, …) | Activate the virtual environment and run `pip install -r requirements.txt`. |
| `Address already in use` on port 5050 | Another console is already running. Close it or use a different `PORT`. |
| An agent card shows *Not run* | The instruction didn't ask for that agent. Only the agents you name run. |
| ⚠ *Command failed* lines in the feed | A command inside an agent failed; the agent normally fixes it and retries. The agent is marked Failed only if the agent itself fails. |
| *Download report (PDF)* opens a print dialog instead of downloading | No Edge or Chrome was found. Install one, or set `PDF_BROWSER` to its path and restart the console. You can also choose *Save as PDF* in the dialog. |
| Charts or tabs are empty | The relevant agent hasn't run yet, or the run was stopped. Check the Report tab and the live feed. |

## License

Add a license of your choice (e.g. MIT) before publishing.
