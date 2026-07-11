# Inspiration

A curated set of essays and videos to revisit when thinking about where this project goes next. Saved from a `/office-hours` session on 2026-04-20 where we reframed `bullmq-dash` as `bmq` — the `kubectl` for BullMQ.

Design doc for that reframe lives at `~/.gstack/projects/quanghuynt14-bullmq-dash/quanghuy-master-design-20260420-233639.md`.

---

## On noticing ideas that are already in front of you

### How to Get Startup Ideas — Paul Graham

The best ideas aren't brainstormed, they're **noticed**. You didn't invent the 5M-scale SQLite sync as a product strategy — you built it for a TUI feature, then later recognized what it unlocked (a moat no other BullMQ tool can match). PG wrote the essay on that exact pattern.

https://paulgraham.com/startupideas.html

### Schlep Blindness — Paul Graham

The best opportunities hide inside boring, tedious problems everyone avoids. "Operating a BullMQ queue at 2am when payments are backed up" is the definition of a schlep. Every BullMQ dashboard tries to make the queue pretty. Nobody tries to make the 2am fix fast. If you're willing to tackle the unsexy thing you see up close, you might already be standing on a company.

https://paulgraham.com/schlep.html

---

## On building as a solo operator in the AI era

### The New Way To Build A Startup — Garry Tan (8 min)

The 2026 playbook for **20x companies** — tiny teams beating incumbents through AI leverage. Three concrete case studies. Exactly the position of a solo builder with AI tooling and a defensible niche nobody else is serving.

https://www.youtube.com/watch?v=rWUWfj_PqmM

---

## Why these three, together

1. **Noticing** — you already built the thing (SQLite sync). See it for what it is.
2. **Schlep blindness** — the 2am on-call persona is a schlep nobody else will touch. That's the moat.
3. **AI leverage** — kubectl-for-BullMQ in two weeks by a solo builder is only possible because the engineering barrier collapsed. Ship accordingly.

Add more as you find them. This file is for you, not anyone else.

---

## Product references applied on 2026-05-30

### chartli

https://github.com/ahmadawais/chartli

Use compact terminal-native data views. For bullmq-dash, this means ranking
queues by operational metrics and adding inline task-size bars instead of
adding decorative chart surfaces.

### clickclack

https://github.com/openclaw/clickclack

Keep project-facing docs direct: what the tool does, how to run it, and what is
included. This informs the README and contribution setup.

### x-rank

https://github.com/kitlangton/x-rank

Prioritize ranked lists that make the next action obvious. For bullmq-dash,
this maps to sorting queues by task size or failures so the busiest or most
broken queue floats to the top. The web UI applies this as a three-pane
operator workspace: ranked queues, filtered jobs, and immediate detail/retry
actions without exposing Redis credentials to the browser.

### bull-board

https://github.com/felixmosh/bull-board

Use bull-board as the generic web-dashboard baseline, then bias bullmq-dash
toward the on-call operator path: rank the most urgent queues first, default to
failed-job triage, keep stacktraces and payloads one click away, and guard live
retry with dry-run previews and confirmation.

### addyosmani/agent-skills and mattpocock/skills

https://github.com/addyosmani/agent-skills

https://github.com/mattpocock/skills

Apply the same skill-shaped discipline to product work: make the workflow
explicit, verify behavior with concrete gates, and leave durable context for
future agents in AGENTS.md, CONTEXT.md, and this inspiration log.

---

## Product references applied on 2026-07-11 — steipete (Peter Steinberger)

Studied https://github.com/steipete — prolific solo builder of CLI/TUI/menu-bar
tools (summarize, oracle, tmuxwatch, RepoBar, CodexBar, poltergeist). The
recurring usability patterns across his portfolio, and how they map here:

### Ship a self-diagnosis command (`summarize status`)

His tools expose a status/diagnostics command that shows what is configured
and what is reachable — without printing secrets. Users troubleshoot
themselves instead of filing "it doesn't connect" issues. **Applied:**
`bullmq-dash doctor` (config-file → profile → connection → redis-ping →
redis-server → queue-discovery, keeps going after failures, credential-free,
JSON + `--human-friendly`).

### Version output carries build info (`tmuxwatch --version`)

A version string that includes runtime and platform turns every bug report
into a better bug report. **Applied:** `-v` now prints
`bullmq-dash vX.Y.Z (bun A.B.C, darwin arm64)`.

### Graceful degradation over hard failure

summarize falls back across transcription backends; a blocked capability is a
downgraded experience, not a crash. **Applied in doctor:** a blocked `INFO`
command (managed-Redis ACLs) is a warning, not a failure; empty queue
discovery is a warning with a `--prefix` hint.

### Multiple install paths (applied 2026-07-11, second pass)

tmuxwatch/summarize list Homebrew, language tooling, and no-install runners in
the first screen of the README. **Applied:** `brew install
quanghuynt14/tap/bullmq-dash` via the new
https://github.com/quanghuynt14/homebrew-tap repo. The formula installs the
published npm tarball, depends on homebrew-core `bun`, and vendors runtime
dependencies at install time so first run needs no network. Maintenance: on
each npm release, bump `url`/`sha256` in `Formula/bullmq-dash.rb`
(`shasum -a 256` of the new tarball).

### Patterns noted but not yet applied (candidates for next sessions)

- **TUI search with `/` and a command palette** (tmuxwatch) — the TUI has
  pane navigation but no fuzzy filter; the web UI already has search.
- **`--dump` JSON snapshot from the live UI** (tmuxwatch) — headless mode
  covers this, but a single "dump everything" command could help support.
- **Demo GIF/screenshot above the fold** — the README has a web screenshot;
  a terminal-cast GIF of the TUI would sell the core mode.
