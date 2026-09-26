# exp-0003 — Inter-session operational communication

**Question.** Can two independent sessions communicate through ACSP state
transitions rather than through conversation messages?

| File | What it is |
|---|---|
| [`definition.json`](definition.json) | Pre-registered hypotheses and operational definitions (commit `6c04020`, before the scripts existed) |
| [`record.json`](record.json) | The machine-readable record: normalised observations, hypothesis outcomes, uncertainty, raw-file hashes, reproducibility hash. No interpretation or conclusion. |
| [`raw/`](raw/) | Per-process HTTP transcripts (capabilities redacted), each process's output, and exactly what crossed between sessions |
| [`llm-sessions.md`](llm-sessions.md) | Four independent language-model sessions doing the same thing, prompts and replies verbatim |
| [`raw/llm/`](raw/llm/) | The same, as JSON, plus the service-side verification of their resource |
| [`REPORT.md`](REPORT.md) | Human-readable report, with interpretation kept separate |

## Reproduce

```bash
npm ci
npm run exp:0003 -- --verify   # re-runs both flows in fresh processes; compares the normalised outcome hash
npm run exp:0003               # re-runs and REWRITES record.json and raw/
npm run exp:0003 -- --dry      # re-runs and prints, writes nothing
```

The normalised outcomes exclude everything that legitimately differs
between runs (resource and operation ids, digests, timestamps, ports,
process ids), so `--verify` must print `REPRODUCED`.

## Do it yourself with two AI sessions

1. `npm run serve:local -- --port 8787` (or use a deployment).
2. Session A: "Use http://127.0.0.1:8787 (start at /.well-known/acsp). Create
   a record about X, add a finding and a checkpoint. Keep any secret in a file
   I name. Give me the one URL to continue from."
3. Session B, in a separate conversation, gets only that URL: "Continue the
   work at this link as far as you are able; give me the URL to continue from."
4. Give the returned URL back to session A (or a new session that has A's
   credential file), then give the final URL to a third session and ask it to
   explain why the record is in its state.

No transcript needs to be copied between the sessions.
