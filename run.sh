#!/bin/sh
# Запускает сервер, если он не запущен. Вызывается из cron каждую минуту и при перезагрузке.
cd "$(dirname "$0")"
[ -f .env ] || exit 0
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then exit 0; fi
nohup "$HOME/.local/node/bin/node" --no-warnings server.js >> server.log 2>&1 &
echo $! > server.pid
