#!/bin/bash

set -e

{
    echo
    echo "Starting local osrm..."
    docker start osrm-foot
} || {
    echo "\e[1;31mFAILED. Perhaps there's no local osrm-food process?\e[0m"
    echo "Continuing to rebuild"
}

echo
echo "Starting rebuild!!"

export NVM_DIR="/root/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd ~/map || exit 1

echo "Stopping Python server..."

PID=$(pgrep -f "python3 main.py" | head -n 1)

if [ -n "$PID" ]; then
    ps -p "$PID" -o pid,%mem,args
    kill "$PID"
    sleep 1
else
    echo "No main.py process found."
fi

echo
echo "Pulling new code..."

git pull

echo
echo "Building frontend..."

cd frontend
export VITE_BUILD_TIME="$(date '+%Y-%m-%d %H:%M:%S %Z')"
npm run build

echo
echo "Restarting PM2..."

pm2 startOrRestart ecosystem.config.cjs
cd ..

echo
echo "Starting Python..."

nohup python3 main.py > output.log 2>&1 &

echo "Done. Built new code! See main.py output in output.log."
