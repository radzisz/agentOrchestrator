#!/bin/bash
# entrypoint.sh — setup + sleep infinity (container stays alive)

echo "[entrypoint] Starting..."

# Fix ownership of claude auth
chown -R agent:agent /home/agent/.claude 2>/dev/null || true

# Fix git "dubious ownership" (Windows bind mount → different UID)
git config --global --add safe.directory /workspace

# Fix line endings: agent runs on Linux but workspace is Windows bind mount
# Without this, every file shows as fully changed in git diff
git config --global core.autocrlf input

# If "login" mode — start interactive claude for auth
if [ "$1" = "login" ]; then
    exec gosu agent claude
fi

echo "[entrypoint] Container ready, sleeping forever. Use docker exec to run commands."

# Keep container alive — Claude and preview services are launched via docker exec
exec sleep infinity
