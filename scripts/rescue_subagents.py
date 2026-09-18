#!/usr/bin/env python3
"""
Recover every running or finished subagent's work from its on-disk transcript.

Standalone Agent-tool subagents (unlike workflow agents) return their findings
only in memory. If the session dies before they report, that work is gone. Their
transcripts are on disk the whole time though, so this reads them and writes each
agent's text output to a readable file.

Safe to run repeatedly while agents are still working: it overwrites the snapshot
with whatever exists at that moment.

Usage:  python3 scripts/rescue_subagents.py [output_dir]
"""
import datetime
import glob
import json
import os
import sys

SESSION = os.environ.get(
    "CLAUDE_SESSION_DIR",
    os.path.expanduser(
        "~/.claude/projects/-home-rares/9402e14b-8644-49bd-ba9f-068396501bcc/subagents"
    ),
)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/trading/sol/atomarb/.scratch/opportunity/recovered"
)
os.makedirs(OUT, exist_ok=True)


def text_blocks(msg):
    """Every text block in an assistant message, in order."""
    content = (msg or {}).get("content")
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]


def first_user_prompt(path):
    """The task the agent was given."""
    for line in open(path, errors="replace"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("type") != "user":
            continue
        c = (r.get("message") or {}).get("content")
        if isinstance(c, str) and c.strip():
            return c
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                    return b["text"]
    return ""


index = []
for tpath in sorted(glob.glob(os.path.join(SESSION, "agent-*.jsonl"))):
    agent_id = os.path.basename(tpath)[len("agent-") : -len(".jsonl")]
    mpath = tpath.replace(".jsonl", ".meta.json")
    meta = {}
    if os.path.exists(mpath):
        try:
            meta = json.load(open(mpath))
        except Exception:
            pass

    texts, last_ts = [], None
    for line in open(tpath, errors="replace"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("type") == "assistant":
            texts.extend(t for t in text_blocks(r.get("message")) if t.strip())
            last_ts = r.get("timestamp") or last_ts

    if not texts:
        continue

    desc = meta.get("description", "(no description)")
    depth = meta.get("spawnDepth", 0)
    parent = meta.get("parentAgentId", "")
    task = first_user_prompt(tpath)

    body = [
        f"# {desc}",
        "",
        f"- agent: `{agent_id}`",
        f"- spawn depth: {depth}" + (f", parent `{parent}`" if parent else ""),
        f"- last activity: {last_ts}",
        f"- text blocks recovered: {len(texts)}",
        "",
        "## Task given",
        "",
        "```",
        (task[:4000] + ("\n…truncated…" if len(task) > 4000 else "")),
        "```",
        "",
        "## Output",
        "",
    ]
    # Newest last: the final block is usually the report.
    for i, t in enumerate(texts):
        body.append(f"### block {i + 1}/{len(texts)}")
        body.append("")
        body.append(t)
        body.append("")

    fname = f"{depth}_{desc[:60].replace('/', '-').replace(' ', '_')}_{agent_id[:8]}.md"
    with open(os.path.join(OUT, fname), "w") as fh:
        fh.write("\n".join(body))

    index.append(
        {
            "agent": agent_id,
            "description": desc,
            "depth": depth,
            "parent": parent,
            "blocks": len(texts),
            "chars": sum(len(t) for t in texts),
            "last_activity": last_ts,
            "file": fname,
        }
    )

index.sort(key=lambda r: (r["depth"], r["description"]))
snapshot = {
    "captured_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "agents": len(index),
    "total_chars": sum(r["chars"] for r in index),
    "index": index,
}
json.dump(snapshot, open(os.path.join(OUT, "INDEX.json"), "w"), indent=1)

with open(os.path.join(OUT, "INDEX.md"), "w") as fh:
    fh.write(f"# Recovered subagent output\n\nCaptured {snapshot['captured_utc']}\n\n")
    fh.write("| depth | agent | blocks | chars | file |\n|---|---|---:|---:|---|\n")
    for r in index:
        fh.write(
            f"| {r['depth']} | {r['description']} | {r['blocks']} | {r['chars']} | `{r['file']}` |\n"
        )

print(
    json.dumps(
        {
            "agents_recovered": len(index),
            "total_chars": snapshot["total_chars"],
            "out": OUT,
        }
    )
)
