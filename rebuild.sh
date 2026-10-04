PID=$(ps -eo pid=,%mem=,args= --sort=-%mem |
    awk '$3 == "python3" {print $1; exit}')

if [ -n "$PID" ]; then
    echo "Killing:"
    ps -p "$PID" -o pid,%mem,args
    kill "$PID"
else
    echo "No python3 process found."
fi

git restore transit_data/geocode_cache.json
git pull

cd frontend/
npm run build
pm2 restart all
cd ..

nohup python3 main.py > output.log 2>&1 &