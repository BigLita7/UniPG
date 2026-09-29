#!/bin/sh
set -u

# Устанавливаем корневой сертификат Минцифры для Node.js, если он не задан
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "./certs/russian-trusted-root-ca.pem" ]; then
    export NODE_EXTRA_CA_CERTS="$(pwd)/certs/russian-trusted-root-ca.pem"
fi

web_pid=""
bot_pid=""

stop_processes() {
    exit_code=$?
    trap - INT TERM EXIT
    echo "Завершение процессов UniPG..."
    if [ -n "$bot_pid" ] && kill -0 "$bot_pid" 2>/dev/null; then
        kill -TERM "$bot_pid" 2>/dev/null || true
    fi
    if [ -n "$web_pid" ] && kill -0 "$web_pid" 2>/dev/null; then
        kill -TERM "$web_pid" 2>/dev/null || true
    fi
    [ -z "$bot_pid" ] || wait "$bot_pid" 2>/dev/null || true
    [ -z "$web_pid" ] || wait "$web_pid" 2>/dev/null || true
    exit "$exit_code"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap stop_processes EXIT

port="${PORT:-8000}"

echo "Запуск FastAPI (REST API + Mini App) на порту $port..."
uvicorn --app-dir mini_app backend.main:app --host 0.0.0.0 --port "$port" &
web_pid=$!

# Ожидание готовности FastAPI
web_ready=0
attempt=0
while [ "$attempt" -lt 30 ] && kill -0 "$web_pid" 2>/dev/null; do
    if python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/api/health', timeout=1)" >/dev/null 2>&1; then
        web_ready=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done

if [ "$web_ready" -eq 1 ]; then
    echo "✅ FastAPI и Mini App готовы к приёму запросов"
else
    echo "⚠️ FastAPI не ответил на /api/health за 30 секунд"
fi

# Запуск MAX-бота
if [ -n "${BOT_TOKEN:-}" ] && [ "$web_ready" -eq 1 ]; then
    echo "🤖 Запуск MAX-бота (node bot/bot.js)..."
    node bot/bot.js &
    bot_pid=$!
elif [ -z "${BOT_TOKEN:-}" ]; then
    echo "ℹ️ BOT_TOKEN не задан в окружении: MAX-бот отключён, работает только Mini App"
fi

# Цикл наблюдения за процессами
while kill -0 "$web_pid" 2>/dev/null; do
    if [ -n "$bot_pid" ] && ! kill -0 "$bot_pid" 2>/dev/null; then
        wait "$bot_pid"
        exit_code=$?
        echo "⚠️ MAX-бот завершился с кодом $exit_code; Mini App продолжает работать"
        bot_pid=""
        sleep 5
        if kill -0 "$web_pid" 2>/dev/null && [ -n "${BOT_TOKEN:-}" ]; then
            echo "🔄 Повторный запуск MAX-бота..."
            node bot/bot.js &
            bot_pid=$!
        fi
    fi
    sleep 1
done

wait "$web_pid"
exit_code=$?
echo "FastAPI остановился с кодом $exit_code"
exit "$exit_code"
