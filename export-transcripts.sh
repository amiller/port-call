#!/bin/bash
# Pull every transcript segment from the fractal rigs' postgres into transcripts/ (one txt per meeting).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p transcripts
tmp=$(mktemp -d)
for r in "" 2 3 4; do
  ssh fractal "docker exec vexa-rig${r}-postgres-1 psql -U postgres vexa -c \"COPY (
    select m.id, m.platform_specific_id, m.created_at::date, t.start_time, t.speaker, t.text
    from transcriptions t join meetings m on m.id=t.meeting_id
    order by m.id, t.start_time) TO STDOUT WITH CSV\"" > "$tmp/rig${r:-1}.csv"
done
TMP="$tmp" python3 - <<'EOF'
import csv, os
from datetime import datetime, timezone
files = {}
for rig in ['rig1','rig2','rig3','rig4']:
    for mid, room, date, start, speaker, text in csv.reader(open(f"{os.environ['TMP']}/{rig}.csv")):
        text = text.strip()
        if not text: continue
        tag = '' if rig=='rig1' else f'_{rig}'
        name = f'transcripts/{date}_{room}_m{mid}{tag}.txt'
        if name not in files:
            files[name] = open(name, 'w')
        stamp = datetime.fromtimestamp(float(start), tz=timezone.utc).strftime('%H:%M:%S')
        files[name].write(f'[{stamp}] {speaker or "?"}: {text}\n')
for f in files.values(): f.close()
print(f'{len(files)} transcript files')
EOF
rm -r "$tmp"
