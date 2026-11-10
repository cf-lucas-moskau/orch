#!/bin/sh
# Deploy evrloot-next to 8790 (d14 step A: same world, new code), the one way orch ships it.
# Fast-forwards the deploy checkout to origin/main, refuses a migration that drops data,
# verifies a fresh backup, then runs step A. Lucas approved this pipeline; orch runs it as one command
# (`npm run -s deploy:evrloot`) so the allow rule for `npm run *` matches it.
set -eu
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
cd "$HOME/code/evrloot-next-deploy"
before=$(git rev-parse HEAD)
git fetch -q
git merge --ff-only -q origin/main
changed=$(git diff --name-only "$before" HEAD -- 'packages/db/migrations/*.sql')
for f in $changed; do
  if git diff "$before" HEAD -- "$f" | grep '^+' | grep -v '^+++' | grep -v '^+ *--' | grep -qiE '\b(drop|truncate)\b|delete from'; then
    echo "deploy stopped: $f adds a statement that drops or deletes data; that one goes to Lucas" >&2
    exit 3
  fi
done
echo "deploy $(git rev-parse --short HEAD) (was $(git rev-parse --short "$before"))"
npx tsx tools/alpha/backup.ts --verify > /tmp/claude-501/bk.log 2>&1 || { tail -n 5 /tmp/claude-501/bk.log >&2; echo "deploy stopped: backup verify failed" >&2; exit 4; }
tail -n 1 /tmp/claude-501/bk.log
npm run -s alpha:d14 -- A --yes 2>&1 | grep -E '^(ok|warn|d14|die|error)|not ok|Error' | grep -vE '^ok   [a-z -]+: [0-9]+$'
