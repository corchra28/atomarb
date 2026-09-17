#!/usr/bin/env python3
"""Snapshots every subagent's structured result and the workflow scripts into the repository (docs/agent_runs/), so the record survives any session."""
import json, glob, os, shutil, datetime
BASE = os.path.expanduser('~/.claude/projects/-home-rares/9402e14b-8644-49bd-ba9f-068396501bcc/subagents/workflows')
SCRIPTS = os.path.expanduser('~/.claude/projects/-home-rares-trading-sol-atomarb/9402e14b-8644-49bd-ba9f-068396501bcc/workflows/scripts')
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'agent_runs')
os.makedirs(os.path.join(OUT, 'scripts'), exist_ok=True)
for f in glob.glob(os.path.join(SCRIPTS, '*.js')):
    shutil.copy(f, os.path.join(OUT, 'scripts', os.path.basename(f)))
out = {'captured_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
for wf in sorted(glob.glob(os.path.join(BASE, 'wf_*', 'journal.jsonl'))):
    name = os.path.basename(os.path.dirname(wf)); rec = {'agents': [], 'events': []}
    for line in open(wf):
        r = json.loads(line)
        (rec['agents'].append(r.get('result')) if r.get('type') == 'result' else rec['events'].append({k: v for k, v in r.items() if k in ('type', 'label', 'phase', 'agentId')}))
    out[name] = rec
json.dump(out, open(os.path.join(OUT, 'workflow_results.json'), 'w'), indent=1, default=str)
print(json.dumps({k: (len(v['agents']), len(v['events'])) for k, v in out.items() if isinstance(v, dict)}))
