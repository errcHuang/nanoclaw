#!/bin/bash
# Blocks git push and force flags. All other operations pass through to real git.
# Layer C safety guard — the actual enforcement is Layer A (no push credentials)
# and Layer B (host-side IPC validation). To push a branch, write a request_pr
# IPC task; the host validates the branch name and does the push itself.

GIT_REAL=/usr/bin/git

if [[ "${1:-}" == "push" ]]; then
    echo "Error: git push is blocked in this container." >&2
    echo "To push a branch and open a draft PR, write a request_pr IPC task." >&2
    echo "See /workspace/group/CLAUDE.md for the IPC workflow." >&2
    exit 1
fi

for arg in "$@"; do
    case "$arg" in
        --no-verify)
            echo "Error: --no-verify is blocked in this container." >&2
            exit 1
            ;;
        -f|--force|--force-with-lease|--force-if-includes)
            echo "Error: force flags are blocked in this container." >&2
            exit 1
            ;;
    esac
done

exec "$GIT_REAL" "$@"
