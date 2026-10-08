#!/bin/bash

set -e

cd ~/map || exit 1

git fetch origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "New update found: $LOCAL -> $REMOTE"
    ./rebuild.sh
else
    echo "No update."
fi