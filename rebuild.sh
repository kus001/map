PID=$(pgrep -f "python3 main.py" | head -n 1)

if [ -n "$PID" ]; then
    echo "Killing main.py:"
    ps -p "$PID" -o pid,%mem,args
    kill "$PID"
else
    echo "No main.py process found."
fi

git restore .
git pull

cd frontend/
npm run build
pm2 restart all
cd ..

nohup python3 main.py > output.log 2>&1 &
