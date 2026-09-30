# pi-agent-comfort

Three extensions for the [pi coding agent](https://pi.dev) that make long sessions
easier to run: analyse read-only before you change anything, keep the output
readable, and know what a session is costing you.

Plain TypeScript, no runtime dependencies, macOS optional.

## Install

```bash
pi install https://github.com/kambodscharoger294-cyber/pi-agent-comfort
```

Then pick and deselect the individual extensions with `pi config` (Tab switches
between global and project scope).

## What is in it

| Extension | What it does |
|---|---|
| `plan-mode/` | Read-only analysis mode. Write tools are disabled, bash is restricted to an allowlist of read-only commands, and the plan is written to `.pi/plans/plan-<date>-<slug>.md` automatically. Progress is tracked with `[DONE:n]` markers and shown in a widget. Commands: `/plan`, `/todos`, `/plan-next` (`Ctrl+Alt+P` toggles). |
| `one-line.ts` | Collapses every tool block to exactly one line: `$ <command>  ✓ Took 0.3s [truncated]`. While a tool runs, and when expanded with `Ctrl+O`, the normal pi rendering is passed through unchanged. Rendering only — tool behaviour is untouched. |
| `credits-footer.ts` | Replaces the footer with the session cost *and* the remaining credit balance (`$0.123/$10.75`). Refreshes on start, after each response (at most every 60 s) and every 5 minutes. Command: `/credits`. |

## plan mode

Toggle with `/plan`. In plan mode the agent can look but not touch: `edit`,
`write` and `subagent` are disabled, and bash passes an allowlist of read-only
commands (`ls`, `cat`, `grep`, `rg`, `find`, `git status/log/diff/branch`,
`npm list`, `uname`, `date`, …). Everything that modifies something is refused
with an explanation, including the disguised variants: `find … -delete`,
`sed -i`, `curl -o`, `wget` to a file, `git commit`, `sudo`, package installs.

The plan is not just chat text. The extension writes it to
`<project>/.pi/plans/plan-YYYYMMDD-HHMM-<slug>.md` (falling back to
`~/.pi/agent/plans/`), so refining a plan updates the same file and the
progress section stays in sync with the `[DONE:n]` markers. The extension
writes the file — the agent stays read-only.

```bash
/plan          # toggle plan mode
/todos         # show progress of the current plan
/plan-next     # re-show the steps and the action menu
```

### Differences from the bundled example

pi ships `examples/extensions/plan-mode/`. This package is based on it and adds:

- **Persisted plans.** The example keeps the plan in the session only. Here the
  plan is written to `.pi/plans/`, survives `/new` and session resume, and is
  reviewable in git.
- **`/plan-next`.** Re-shows the steps and the action menu without re-running
  the analysis.
- **Hardened allowlist.** `find … -delete`, `sed … -i` and `curl`/`wget` writing
  to a file are blocked explicitly, instead of relying on the allowlist alone.
- **Tests.** The allowlist and the plan parser are covered by
  `tests/allowlist.test.ts` (`bun test`).

## credits-footer

Written for OpenRouter, because that is what reports a *remaining* balance.
Other gateways work if they return the same shape (`data.total_credits` and
`data.total_usage`).

The key is read from the macOS keychain and never printed:

```bash
security add-generic-password -s pi-openrouter -a "$USER" -w
```

Without a key, or with an unreachable endpoint, the balance renders as `--.--`
and the rest of the footer keeps working. Configure with:

| Variable | Default |
|---|---|
| `PI_CREDITS_KEYCHAIN_SERVICE` | `pi-openrouter` |
| `PI_CREDITS_KEYCHAIN_ACCOUNT` | `$USER` |
| `PI_CREDITS_API_URL` | `https://openrouter.ai/api/v1/credits` |
| `PI_CREDITS_API_KEY_ENV` | `OPENROUTER_API_KEY` |

## Requirements

- Nothing mandatory. `credits-footer` needs macOS for the keychain (the
  `OPENROUTER_API_KEY` env var works everywhere), `one-line` and `plan-mode` run
  on Linux and Windows too.
- Node 22+ or Bun, as for any pi extension.

## Tests

```bash
bun test
```

## Kurz auf Deutsch

Drei pi-Extensions, ohne Laufzeit-Abhängigkeiten:

- **plan-mode** — Analysemodus zum Nur-Lesen: Schreibwerkzeuge aus, Bash auf eine
  Allowlist lesender Befehle beschränkt, und der Plan wird automatisch nach
  `.pi/plans/` geschrieben (nicht nur im Chat). `/plan`, `/todos`, `/plan-next`.
- **one-line** — klappt jeden Tool-Block auf genau eine Zeile ein. Reines
  Rendering, das Verhalten der Tools bleibt unverändert.
- **credits-footer** — zeigt im Footer Sessionkosten *und* verbleibendes Guthaben.
  Key aus dem macOS-Schlüsselbund, nie im Klartext. Andere Gateways über
  `PI_CREDITS_API_URL` einstellbar.

Der Plan wird bewusst von der Extension geschrieben, damit der Agent im
Plan-Modus strikt lesend bleibt.

## License

MIT — see [LICENSE](LICENSE).
