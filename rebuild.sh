PID=$(pgrep -f "python3 main.py" | head -n 1)

if [ -n "$PID" ]; then
    echo "Killing main.py:"
    ps -p "$PID" -o pid,%mem,args
    kill "$PID"
else
    echo "No main.py process found."
fi

echo "\n\npulling new code\n\n"
git restore .
git pull
echo "\n\npulled new code!\n\n"

cd frontend/
npm run build
pm2 restart all
cd ..

echo "\n\nstarting python..."
nohup python3 main.py > output.log 2>&1 &
echo "started python!\n"