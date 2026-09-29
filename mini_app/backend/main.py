from __future__ import annotations

import asyncio
import logging
import math
import os
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator


APP_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = APP_DIR.parent
FRONTEND_DIR = APP_DIR / "frontend"
load_dotenv(PROJECT_DIR / ".env")

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("unipg")

_legacy_db = APP_DIR / "backend" / "sportly.db"
_default_db = _legacy_db if _legacy_db.exists() else APP_DIR / "backend" / "unipg.db"
_configured_db = Path(os.getenv("DATABASE_PATH", str(_default_db)))
DATABASE_PATH = _configured_db if _configured_db.is_absolute() else PROJECT_DIR / _configured_db
TWOGIS_PLACES_API_KEY = os.getenv("TWOGIS_PLACES_API_KEY") or os.getenv("TWOGIS_CATALOG_KEY")
TWOGIS_MAPGL_API_KEY = os.getenv("TWOGIS_MAPGL_API_KEY", "")
TWOGIS_MAP_STYLE_ID = os.getenv("TWOGIS_MAP_STYLE_ID", "")
TWOGIS_MOSCOW_CITY_ID = os.getenv("TWOGIS_MOSCOW_CITY_ID", "")
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
MAX_BOT_USERNAME = (
    os.getenv("MAX_BOT_USERNAME", "").strip().lstrip("@")
    or "t126_hakaton_max_bot"
)
MAX_API_BASE = "https://platform-api2.max.ru"
APP_TIMEZONE = ZoneInfo(os.getenv("APP_TIMEZONE", "Europe/Moscow"))
REMINDER_POLL_SECONDS = max(5, int(os.getenv("REMINDER_POLL_SECONDS", "30")))

_configured_max_ca = os.getenv("MAX_CA_CERT_PATH") or os.getenv("NODE_EXTRA_CA_CERTS", "")
_max_ca_path = Path(_configured_max_ca) if _configured_max_ca else PROJECT_DIR / "certs/russian-trusted-root-ca.pem"
if not _max_ca_path.is_absolute():
    _max_ca_path = PROJECT_DIR / _max_ca_path
MAX_TLS_VERIFY: bool | str = str(_max_ca_path) if _max_ca_path.is_file() else True

MOSCOW_CENTER = [37.6173, 55.7558]
# Administrative Moscow, including TiNAO. Configure the exact 2GIS city id in production.
MOSCOW_BOUNDS = {
    "southWest": [36.80, 55.14],
    "northEast": [37.98, 56.02],
}


def activity_keyboard(
    activity_id: int,
    button_text: str = "Открыть событие",
) -> dict[str, Any]:
    return {
        "type": "inline_keyboard",
        "payload": {
            "buttons": [[{
                "type": "open_app",
                "text": button_text,
                "web_app": MAX_BOT_USERNAME,
                "payload": f"activity_{activity_id}",
            }]],
        },
    }


def send_max_message(
    user_id: str | int,
    text: str,
    activity_id: int | None = None,
    button_text: str = "Открыть событие",
) -> bool:
    if not BOT_TOKEN or not str(user_id).isdigit():
        return False
    body: dict[str, Any] = {"text": text}
    if activity_id is not None:
        body["attachments"] = [activity_keyboard(activity_id, button_text)]
    try:
        response = requests.post(
            f"{MAX_API_BASE}/messages",
            headers={"Authorization": BOT_TOKEN, "Content-Type": "application/json"},
            params={"user_id": int(user_id)},
            json=body,
            timeout=5,
            verify=MAX_TLS_VERIFY,
        )
        response.raise_for_status()
        return True
    except requests.RequestException as exc:
        logger.warning("Failed to send MAX notification to %s: %s", user_id, exc)
        return False


def remove_from_max_chat(chat_id: int, user_id: str | int) -> None:
    if not BOT_TOKEN or not str(user_id).isdigit():
        return
    try:
        response = requests.delete(
            f"{MAX_API_BASE}/chats/{chat_id}/members",
            headers={"Authorization": BOT_TOKEN},
            params={"user_id": int(user_id)},
            timeout=5,
            verify=MAX_TLS_VERIFY,
        )
        response.raise_for_status()
        logger.info("Removed user %s from MAX chat %s", user_id, chat_id)
    except requests.RequestException as exc:
        logger.warning("Failed to remove user %s from MAX chat %s: %s", user_id, chat_id, exc)

SPORT_QUERIES = {
    "all": "спортивная площадка",
    "football": "футбольное поле",
    "basketball": "баскетбольная площадка",
    "volleyball": "волейбольная площадка",
    "tennis": "теннисный корт",
    "workout": "воркаут площадка",
}
SPORT_TYPES = set(SPORT_QUERIES) - {"all"}

SPORTS_KEYWORDS = (
    "спорт", "стадион", "площадк", "корт", "поле", "манеж", "арен",
    "воркаут", "workout", "тренажер", "тренажёр", "фитнес", "бассейн",
    "каток", "футбол", "баскет", "волей", "теннис", "хокке", "лед", "лёд",
    "бокс", "единоборств", "скалодром", "тир", "стрельб", "дюсш", "сдюшор",
    "фок", "гимнастик", "атлетик", "лыж", "роллер", "скейт", "сквош",
)

NON_SPORTS_KEYWORDS = (
    "аптек", "оптик", "магазин", "супермаркет", "гипермаркет", "продукты",
    "кафе", "ресторан", "бар", "паб", "пицц", "суши", "столов", "кофейн",
    "пекарн", "булочн", "фастфуд", "банк", "банкомат", "ломбард", "больниц",
    "поликлиник", "стоматолог", "медицин", "автосервис", "шиномонтаж", "азс",
    "автомойк", "парикмахер", "салон красот", "барбер", "гостиниц", "отель",
    "хостел", "жилой дом", "нотариус", "юрист", "мфц",
)


def is_sports_venue(name: str, rubrics: list[str]) -> bool:
    name_lower = name.lower()
    rubrics_lower = [r.lower() for r in rubrics]

    for nr in NON_SPORTS_KEYWORDS:
        if any(nr in r for r in rubrics_lower) and not any(any(sk in r for sk in SPORTS_KEYWORDS) for r in rubrics_lower):
            return False
        if nr in name_lower and not any(sk in name_lower for sk in SPORTS_KEYWORDS):
            return False

    for r in rubrics_lower:
        if any(sk in r for sk in SPORTS_KEYWORDS):
            return True

    if any(sk in name_lower for sk in SPORTS_KEYWORDS):
        return True

    return False

_cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
_cache_lock = threading.Lock()
CACHE_TTL_SECONDS = 300


def get_db() -> sqlite3.Connection:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with get_db() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                venue_id TEXT NOT NULL,
                venue_name TEXT NOT NULL,
                address TEXT NOT NULL DEFAULT '',
                nearest_metro TEXT NOT NULL DEFAULT '',
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                title TEXT NOT NULL,
                sport_type TEXT NOT NULL,
                starts_at TEXT NOT NULL,
                max_players INTEGER NOT NULL,
                current_players INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_activities_venue ON activities(venue_id)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_activities_starts_at ON activities(starts_at)"
        )
        
        for col, coltype in [("creator_id", "TEXT"), ("creator_name", "TEXT"), ("age_restriction", "TEXT DEFAULT 'all'")]:
            try:
                connection.execute(f"ALTER TABLE activities ADD COLUMN {col} {coltype} NOT NULL DEFAULT ''")
            except sqlite3.OperationalError:
                pass

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS user_profiles (
                user_id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                birth_date TEXT,
                age_group TEXT NOT NULL DEFAULT 'adult',
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS activity_participants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                user_name TEXT NOT NULL DEFAULT '',
                joined_at TEXT NOT NULL,
                UNIQUE(activity_id, user_id)
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_participants_activity ON activity_participants(activity_id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_participants_user ON activity_participants(user_id)")
        # Older installations counted the organizer in current_players but did not
        # store them as a participant. Backfill that relation without changing counts.
        connection.execute(
            """
            INSERT OR IGNORE INTO activity_participants (
                activity_id, user_id, user_name, joined_at
            )
            SELECT id, creator_id, creator_name, created_at
            FROM activities
            WHERE creator_id <> ''
            """
        )

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS event_chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id INTEGER NOT NULL UNIQUE REFERENCES activities(id) ON DELETE CASCADE,
                chat_id INTEGER NOT NULL,
                invite_link TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS notification_deliveries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                delivered_at TEXT NOT NULL,
                UNIQUE(activity_id, user_id, kind)
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_notification_activity "
            "ON notification_deliveries(activity_id)"
        )

        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS venue_rentals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                venue_id TEXT NOT NULL,
                venue_name TEXT NOT NULL DEFAULT '',
                price_per_hour INTEGER,
                currency TEXT NOT NULL DEFAULT 'RUB',
                description TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                available_hours TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_rentals_venue ON venue_rentals(venue_id)")

        # Seed sample rentable venues if empty
        existing_rentals = connection.execute("SELECT COUNT(*) as count FROM venue_rentals").fetchone()
        if existing_rentals and existing_rentals["count"] == 0:
            sample_rentals = [
                ("4504127908585434", "Спорткомплекс «Чайка»", 2500, "RUB", "Крытый манеж, раздевалки, душевые, профессиональное освещение", "+7 (495) 246-13-44", "08:00 - 23:00"),
                ("70000001061372075", "Стадион «Красная Пресня»", 3500, "RUB", "Футбольное поле стандарта FIFA, трибуны, спортивный инвентарь", "+7 (499) 255-08-33", "07:00 - 23:00"),
                ("4504127908546352", "Теннисный клуб им. Н.Н. Озерова", 1800, "RUB", "3 грунтовых и 2 хардовых корта, прокат ракеток и мячей", "+7 (495) 915-05-55", "07:00 - 22:00"),
                ("70000001075617763", "Баскетбольный центр «Playground»", 2200, "RUB", "Паркетное покрытие NBA, электронное табло, сауна", "+7 (495) 789-43-21", "Круглосуточно"),
                ("4504127908547591", "Ледовый дворец «Центральный»", 4000, "RUB", "Каток с искусственным льдом, аренда коньков и защитной экипировки", "+7 (495) 612-40-10", "06:00 - 00:00"),
            ]
            now = utc_iso()
            connection.executemany(
                """
                INSERT INTO venue_rentals (
                    venue_id, venue_name, price_per_hour, currency, description, phone, available_hours, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [(v[0], v[1], v[2], v[3], v[4], v[5], v[6], now) for v in sample_rentals],
            )



@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    logger.info("UniPG API started; database=%s", DATABASE_PATH)
    stop_event = asyncio.Event()
    reminder_task = asyncio.create_task(reminder_worker(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        await reminder_task


app = FastAPI(
    title="UniPG API",
    version="0.2.0",
    lifespan=lifespan,
    servers=[
        {"url": "https://unipg.ru", "description": "Production"},
        {"url": "http://localhost:8000", "description": "Local Docker"},
    ],
)

allowed_origins = [
    value.strip()
    for value in os.getenv(
        "ALLOWED_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000",
    ).split(",")
    if value.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(self)"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path.endswith((".html", ".js", ".css")) or request.url.path in {"/", ""}:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


class ActivityCreate(BaseModel):
    venue_id: str = Field(min_length=1, max_length=100)
    venue_name: str = Field(min_length=1, max_length=160)
    address: str = Field(default="", max_length=240)
    nearest_metro: str = Field(default="", max_length=120)
    lat: float
    lng: float
    title: str = Field(min_length=3, max_length=120)
    sport_type: str
    starts_at: datetime
    max_players: int = Field(ge=2, le=50)
    creator_id: str = Field(default="", max_length=100)
    creator_name: str = Field(default="", max_length=100)
    age_restriction: str = Field(default="all")

    @field_validator("venue_id", "venue_name", "address", "nearest_metro", "title", mode="before")
    @classmethod
    def strip_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("sport_type")
    @classmethod
    def validate_sport_type(cls, value: str) -> str:
        if value not in SPORT_TYPES:
            raise ValueError("Неизвестный вид спорта")
        return value

    @field_validator("age_restriction")
    @classmethod
    def validate_age_restriction(cls, value: str) -> str:
        if value not in {"all", "adult"}:
            raise ValueError("Допустимые значения: all, adult")
        return value


def utc_iso(value: datetime | None = None) -> str:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def format_activity_start(starts_at: str) -> str:
    value = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
    return value.astimezone(APP_TIMEZONE).strftime("%d.%m.%Y в %H:%M")


def activity_summary(activity: sqlite3.Row | dict[str, Any]) -> str:
    metro = f" (м. {activity['nearest_metro']})" if activity["nearest_metro"] else ""
    return (
        f"«{activity['title']}»\n"
        f"📍 {activity['venue_name']}{metro}\n"
        f"🕐 {format_activity_start(activity['starts_at'])}"
    )


def dispatch_due_reminders() -> int:
    if not BOT_TOKEN:
        return 0

    now = datetime.now(timezone.utc)
    deadline = now + timedelta(hours=1)
    with get_db() as connection:
        rows = connection.execute(
            """
            SELECT a.*, recipients.user_id AS notification_user_id
            FROM activities a
            JOIN (
                SELECT activity_id, user_id
                FROM activity_participants
                WHERE user_id <> ''
            ) recipients ON recipients.activity_id = a.id
            WHERE a.status = 'active'
              AND a.starts_at > ?
              AND a.starts_at <= ?
            ORDER BY a.starts_at ASC
            """,
            (utc_iso(now), utc_iso(deadline)),
        ).fetchall()

    delivered = 0
    for activity in rows:
        user_id = str(activity["notification_user_id"])
        if not user_id.isdigit():
            continue

        with get_db() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO notification_deliveries (
                    activity_id, user_id, kind, delivered_at
                ) VALUES (?, ?, 'one_hour_reminder', ?)
                """,
                (activity["id"], user_id, utc_iso()),
            )
            claimed = cursor.rowcount == 1
        if not claimed:
            continue

        text = (
            "⏰ Напоминание о событии UniPG\n\n"
            f"{activity_summary(activity)}\n\n"
            "Событие начнётся примерно через час. Если планы изменились, "
            "откройте событие и нажмите «Отказаться от участия»."
        )
        if send_max_message(user_id, text, activity["id"], "Отказаться"):
            delivered += 1
        else:
            with get_db() as connection:
                connection.execute(
                    """
                    DELETE FROM notification_deliveries
                    WHERE activity_id = ? AND user_id = ? AND kind = 'one_hour_reminder'
                    """,
                    (activity["id"], user_id),
                )

    if delivered:
        logger.info("Sent %s one-hour activity reminder(s)", delivered)
    return delivered


async def reminder_worker(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            await asyncio.to_thread(dispatch_due_reminders)
        except Exception:
            logger.exception("Activity reminder worker failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=REMINDER_POLL_SECONDS)
        except TimeoutError:
            pass


def is_in_moscow(lng: float, lat: float) -> bool:
    south_west = MOSCOW_BOUNDS["southWest"]
    north_east = MOSCOW_BOUNDS["northEast"]
    return south_west[0] <= lng <= north_east[0] and south_west[1] <= lat <= north_east[1]


def haversine_km(first: tuple[float, float], second: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, first)
    lon2, lat2 = map(math.radians, second)
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def request_2gis(params: dict[str, Any]) -> list[dict[str, Any]]:
    if not TWOGIS_PLACES_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Добавьте TWOGIS_PLACES_API_KEY в .env",
        )

    request_params = {
        "key": TWOGIS_PLACES_API_KEY,
        "locale": "ru_RU",
        # Catalog API 3.0 accepts values from 1 to 10.
        "page_size": 10,
        **params,
    }
    if TWOGIS_MOSCOW_CITY_ID:
        request_params["city_id"] = TWOGIS_MOSCOW_CITY_ID

    try:
        response = requests.get(
            "https://catalog.api.2gis.com/3.0/items",
            params=request_params,
            timeout=8,
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("2GIS request failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="2ГИС временно недоступен",
        ) from exc

    meta_code = payload.get("meta", {}).get("code", 200)
    if meta_code != 200:
        logger.warning("2GIS returned code=%s", meta_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="2ГИС отклонил запрос. Проверьте ключ и его лимиты",
        )
    return payload.get("result", {}).get("items", [])


def find_nearest_metro(
    point: tuple[float, float], stations: list[dict[str, Any]]
) -> tuple[str, float | None]:
    nearest_name = ""
    nearest_distance: float | None = None
    for station in stations:
        station_point = station.get("point") or {}
        if "lon" not in station_point or "lat" not in station_point:
            continue
        distance = haversine_km(point, (station_point["lon"], station_point["lat"]))
        if nearest_distance is None or distance < nearest_distance:
            nearest_name = station.get("name", "")
            nearest_distance = distance
    return nearest_name, nearest_distance


def serialize_activity(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "unipg-api"}


@app.get("/api/config")
def config() -> dict[str, Any]:
    return {
        "mapKey": TWOGIS_MAPGL_API_KEY,
        "mapStyleId": TWOGIS_MAP_STYLE_ID,
        "moscowCenter": MOSCOW_CENTER,
        "moscowBounds": MOSCOW_BOUNDS,
        "sports": sorted(SPORT_TYPES),
    }


@app.get("/api/venues")
def get_venues(
    lat: float = Query(default=MOSCOW_CENTER[1], ge=-90, le=90),
    lng: float = Query(default=MOSCOW_CENTER[0], ge=-180, le=180),
    radius: int = Query(default=5000, ge=500, le=20000),
    sport: str = Query(default="all"),
    q: str = Query(default="", max_length=80),
) -> dict[str, Any]:
    if not is_in_moscow(lng, lat):
        raise HTTPException(status_code=400, detail="Поиск доступен только в Москве")
    if sport not in SPORT_QUERIES:
        raise HTTPException(status_code=400, detail="Неизвестный вид спорта")

    normalized_query = q.strip().lower()
    cache_key = (round(lat, 3), round(lng, 3), radius, sport, normalized_query)
    with _cache_lock:
        cached = _cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

    query_has_sport = any(sk in normalized_query for sk in SPORTS_KEYWORDS)
    if normalized_query:
        if query_has_sport:
            search_query = normalized_query
        else:
            base_sport = SPORT_QUERIES.get(sport, "спортивная площадка")
            search_query = f"{normalized_query} {base_sport}"
    else:
        search_query = SPORT_QUERIES[sport]

    common = {
        "point": f"{lng},{lat}",
        "radius": radius,
        "sort": "distance",
        "fields": "items.point,items.address,items.full_address_name,items.rubrics,items.reviews,items.flags",
    }
    venue_items = request_2gis({**common, "q": search_query})
    metro_items = request_2gis(
        {
            **common,
            "q": "метро",
            "type": "station.metro",
            "fields": "items.point,items.address",
        }
    )

    venues: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in venue_items:
        point = item.get("point") or {}
        venue_id = str(item.get("id", ""))
        if not venue_id or venue_id in seen_ids or "lon" not in point or "lat" not in point:
            continue
        venue_lng = float(point["lon"])
        venue_lat = float(point["lat"])
        if not is_in_moscow(venue_lng, venue_lat):
            continue
        venue_name = item.get("name") or "Спортивная площадка"
        rubrics = [rubric.get("name", "") for rubric in item.get("rubrics", []) if rubric.get("name")]
        if not is_sports_venue(venue_name, rubrics):
            continue
        seen_ids.add(venue_id)
        metro_name, metro_distance = find_nearest_metro((venue_lng, venue_lat), metro_items)
        reviews = item.get("reviews") or {}
        rating = reviews.get("general_rating")
        if rating is None:
            rating = reviews.get("rating")
        review_count = reviews.get("general_review_count")
        if review_count is None:
            review_count = reviews.get("review_count", 0)
        flags = item.get("flags") or {}
        object_path = "firm" if item.get("type") == "branch" else "geo"
        venues.append(
            {
                "id": venue_id,
                "name": item.get("name") or "Спортивная площадка",
                "address": item.get("full_address_name") or item.get("address_name") or "Адрес не указан",
                "lat": venue_lat,
                "lng": venue_lng,
                "distanceKm": round(haversine_km((lng, lat), (venue_lng, venue_lat)), 2),
                "nearestMetro": metro_name,
                "metroDistanceKm": round(metro_distance, 2) if metro_distance is not None else None,
                "rubrics": rubrics[:3],
                "rating": round(float(rating), 1) if rating is not None else None,
                "reviewCount": int(review_count or 0),
                "hasPhotos": bool(flags.get("photos")),
                "dgisUrl": f"https://2gis.ru/moscow/{object_path}/{venue_id}",
            }
        )

    result = {
        "items": venues,
        "meta": {
            "source": "2gis",
            "center": [lng, lat],
            "radius": radius,
            "count": len(venues),
        },
    }
    with _cache_lock:
        _cache[cache_key] = (time.monotonic(), result)
    return result


@app.get("/api/activities")
def get_activities(
    venue_id: str | None = Query(default=None, max_length=100),
    sport: str | None = Query(default=None),
) -> list[dict[str, Any]]:
    clauses = ["status = 'active'", "starts_at >= ?"]
    params: list[Any] = [utc_iso()]
    if venue_id:
        clauses.append("venue_id = ?")
        params.append(venue_id)
    if sport and sport != "all":
        if sport not in SPORT_TYPES:
            raise HTTPException(status_code=400, detail="Неизвестный вид спорта")
        clauses.append("sport_type = ?")
        params.append(sport)

    query = f"SELECT * FROM activities WHERE {' AND '.join(clauses)} ORDER BY starts_at ASC LIMIT 200"
    with get_db() as connection:
        rows = connection.execute(query, params).fetchall()
    return [serialize_activity(row) for row in rows]


@app.post("/api/activities", status_code=status.HTTP_201_CREATED)
def create_activity(game: ActivityCreate) -> dict[str, Any]:
    if not is_in_moscow(game.lng, game.lat):
        raise HTTPException(status_code=400, detail="Площадка должна находиться в Москве")
    starts_at = game.starts_at
    if starts_at.tzinfo is None:
        starts_at = starts_at.replace(tzinfo=timezone.utc)
    if starts_at.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Дата игры должна быть в будущем")

    created_at = utc_iso()
    with get_db() as connection:
        cursor = connection.execute(
            """
            INSERT INTO activities (
                venue_id, venue_name, address, nearest_metro, lat, lng,
                title, sport_type, starts_at, max_players, current_players,
                status, created_at, creator_id, creator_name, age_restriction
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)
            """,
            (
                game.venue_id,
                game.venue_name,
                game.address,
                game.nearest_metro,
                game.lat,
                game.lng,
                game.title,
                game.sport_type,
                utc_iso(starts_at),
                game.max_players,
                created_at,
                game.creator_id,
                game.creator_name,
                game.age_restriction,
            ),
        )
        row = connection.execute(
            "SELECT * FROM activities WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        if game.creator_id:
            connection.execute(
                """
                INSERT INTO activity_participants (
                    activity_id, user_id, user_name, joined_at
                ) VALUES (?, ?, ?, ?)
                """,
                (row["id"], game.creator_id, game.creator_name, created_at),
            )

    if game.creator_id:
        send_max_message(
            game.creator_id,
            "✅ Событие создано в UniPG!\n\n"
            f"{activity_summary(row)}\n\n"
            "Мы напомним о начале примерно за час. Управлять участием можно на карте.",
            row["id"],
        )
    return serialize_activity(row)


@app.post("/api/activities/{activity_id}/join")
def join_activity(
    activity_id: int,
    user_id: str = Query(default="", max_length=100),
    user_name: str = Query(default="", max_length=100),
) -> dict[str, Any]:
    if not user_id:
        raise HTTPException(status_code=400, detail="Для записи откройте UniPG из MAX")

    with get_db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM activities WHERE id = ?", (activity_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Игра не найдена")
        if row["status"] != "active" or row["starts_at"] < utc_iso():
            raise HTTPException(status_code=409, detail="Игра уже недоступна")
        participant = connection.execute(
            "SELECT 1 FROM activity_participants WHERE activity_id = ? AND user_id = ?",
            (activity_id, user_id),
        ).fetchone()
        if participant:
            return serialize_activity(row)
        if row["current_players"] >= row["max_players"]:
            raise HTTPException(status_code=409, detail="Свободных мест больше нет")
        connection.execute(
            """
            INSERT INTO activity_participants (
                activity_id, user_id, user_name, joined_at
            ) VALUES (?, ?, ?, ?)
            """,
            (activity_id, user_id, user_name, utc_iso()),
        )
        connection.execute(
            "UPDATE activities SET current_players = current_players + 1 WHERE id = ?",
            (activity_id,),
        )
        updated = connection.execute(
            "SELECT * FROM activities WHERE id = ?", (activity_id,)
        ).fetchone()
        chat_row = connection.execute(
            "SELECT * FROM event_chats WHERE activity_id = ?", (activity_id,)
        ).fetchone()

    participant_text = (
        "🏆 Вы записались на событие UniPG!\n\n"
        f"{activity_summary(updated)}\n\n"
        "Мы напомним о начале примерно за час. Если планы изменятся, "
        "откройте событие и нажмите «Отказаться от участия»."
    )
    if chat_row and chat_row["invite_link"]:
        participant_text += f"\n\n💬 Чат участников: {chat_row['invite_link']}"
    send_max_message(user_id, participant_text, activity_id, "Отказаться")

    creator_id = row["creator_id"]
    if creator_id and str(creator_id) != str(user_id):
        send_max_message(
            creator_id,
            "🎉 Новый участник в UniPG!\n\n"
            f"{user_name or 'Участник'} записался на «{row['title']}».\n"
            f"Участников: {updated['current_players']}/{updated['max_players']}",
            activity_id,
        )

    return serialize_activity(updated)


@app.delete("/api/activities/{activity_id}/join")
def leave_activity(
    activity_id: int,
    user_id: str = Query(default="", max_length=100),
) -> dict[str, Any]:
    if not user_id:
        raise HTTPException(status_code=400, detail="Для отмены записи откройте UniPG из MAX")

    with get_db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM activities WHERE id = ?", (activity_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Игра не найдена")
        participant = connection.execute(
            """
            SELECT user_name FROM activity_participants
            WHERE activity_id = ? AND user_id = ?
            """,
            (activity_id, user_id),
        ).fetchone()
        if participant is None:
            raise HTTPException(status_code=409, detail="Вы уже не участвуете в этом событии")
        participant_name = participant["user_name"] or "Участник"
        connection.execute(
            "DELETE FROM activity_participants WHERE activity_id = ? AND user_id = ?",
            (activity_id, user_id),
        )
        connection.execute(
            """
            UPDATE activities
            SET current_players = MAX(current_players - 1, 0)
            WHERE id = ?
            """,
            (activity_id,),
        )
        updated = connection.execute(
            "SELECT * FROM activities WHERE id = ?", (activity_id,)
        ).fetchone()
        chat_row = connection.execute(
            "SELECT * FROM event_chats WHERE activity_id = ?", (activity_id,)
        ).fetchone()

    send_max_message(
        user_id,
        "✅ Запись отменена\n\n"
        f"Вы больше не участвуете в событии «{row['title']}».\n"
        f"{activity_summary(row)}",
        activity_id,
    )

    creator_id = row["creator_id"]
    if creator_id and str(creator_id) != str(user_id):
        send_max_message(
            creator_id,
            "👋 Участник отменил запись\n\n"
            f"{participant_name} больше не участвует в «{row['title']}».\n"
            f"Участников: {updated['current_players']}/{updated['max_players']}",
            activity_id,
        )

    if chat_row:
        remove_from_max_chat(chat_row["chat_id"], user_id)

    return serialize_activity(updated)



@app.exception_handler(sqlite3.Error)
async def database_error_handler(_: Request, exc: sqlite3.Error):
    logger.exception("Database error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Ошибка базы данных"})


class ProfileCreate(BaseModel):
    user_id: str = Field(min_length=1, max_length=100)
    name: str = Field(default="", max_length=160)
    birth_date: str | None = None

@app.post("/api/profile", status_code=status.HTTP_201_CREATED)
def upsert_profile(profile: ProfileCreate) -> dict[str, Any]:
    age_group = "adult"
    if profile.birth_date:
        try:
            bd = datetime.fromisoformat(profile.birth_date)
            age = (datetime.now(timezone.utc) - bd.replace(tzinfo=timezone.utc)).days // 365
            age_group = "teen" if 14 <= age < 18 else "adult"
        except ValueError:
            pass
    now = utc_iso()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO user_profiles (user_id, name, birth_date, age_group, created_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, birth_date=excluded.birth_date, age_group=excluded.age_group",
            (profile.user_id, profile.name, profile.birth_date or "", age_group, now),
        )
        row = conn.execute("SELECT * FROM user_profiles WHERE user_id = ?", (profile.user_id,)).fetchone()
    return dict(row)


@app.get("/api/profile/{user_id}")
def get_profile(user_id: str) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM user_profiles WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Профиль не найден")
    return dict(row)


@app.get("/api/users/{user_id}/activities")
def get_user_activities(user_id: str) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT a.* FROM activities a "
            "JOIN activity_participants p ON a.id = p.activity_id "
            "WHERE p.user_id = ? AND a.status = 'active' AND a.starts_at >= ? "
            "ORDER BY a.starts_at ASC",
            (user_id, utc_iso()),
        ).fetchall()
    return [serialize_activity(row) for row in rows]


@app.get("/api/activities/{activity_id}/participants")
def get_activity_participants(activity_id: int) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM activity_participants WHERE activity_id = ? ORDER BY joined_at ASC",
            (activity_id,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/activities/{activity_id}/chat")
def register_event_chat(
    activity_id: int,
    chat_id: int = Query(...),
    invite_link: str = Query(default=""),
) -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute("SELECT id FROM activities WHERE id = ?", (activity_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Игра не найдена")
        conn.execute(
            "INSERT OR REPLACE INTO event_chats (activity_id, chat_id, invite_link, created_at) VALUES (?, ?, ?, ?)",
            (activity_id, chat_id, invite_link, utc_iso()),
        )
        chat_row = conn.execute("SELECT * FROM event_chats WHERE activity_id = ?", (activity_id,)).fetchone()
    return dict(chat_row)


@app.get("/api/activities/{activity_id}/chat")
def get_event_chat(
    activity_id: int,
    user_id: str = Query(default="", max_length=100),
) -> dict[str, Any]:
    with get_db() as conn:
        activity = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
        if activity is None:
            raise HTTPException(status_code=404, detail="Игра не найдена")
        if activity["starts_at"] < utc_iso():
            raise HTTPException(status_code=410, detail="Событие завершено, доступ к чату закрыт")
        if user_id:
            participant = conn.execute(
                "SELECT 1 FROM activity_participants WHERE activity_id = ? AND user_id = ?",
                (activity_id, user_id),
            ).fetchone()
            if not participant and str(activity["creator_id"]) != str(user_id):
                raise HTTPException(status_code=403, detail="Доступ к чату открыт только участникам события")
        row = conn.execute("SELECT * FROM event_chats WHERE activity_id = ?", (activity_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Чат для этой игры ещё не создан")
    return dict(row)


class VenueRentalCreate(BaseModel):
    venue_id: str = Field(min_length=1, max_length=100)
    venue_name: str = Field(default="", max_length=160)
    price_per_hour: int = Field(ge=0, le=100000)
    currency: str = Field(default="RUB", max_length=10)
    description: str = Field(default="", max_length=500)
    phone: str = Field(default="", max_length=30)
    available_hours: str = Field(default="", max_length=60)


@app.post("/api/rentals", status_code=status.HTTP_201_CREATED)
def create_rental(rental: VenueRentalCreate) -> dict[str, Any]:
    with get_db() as conn:
        cursor = conn.execute(
            """
            INSERT INTO venue_rentals (
                venue_id, venue_name, price_per_hour, currency, description, phone, available_hours, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rental.venue_id,
                rental.venue_name,
                rental.price_per_hour,
                rental.currency,
                rental.description,
                rental.phone,
                rental.available_hours,
                utc_iso(),
            ),
        )
        row = conn.execute("SELECT * FROM venue_rentals WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return dict(row)


@app.get("/api/rentals")
def get_rentals(
    venue_id: str | None = Query(default=None, max_length=100),
) -> list[dict[str, Any]]:
    with get_db() as conn:
        if venue_id:
            rows = conn.execute("SELECT * FROM venue_rentals WHERE venue_id = ?", (venue_id,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM venue_rentals ORDER BY created_at DESC LIMIT 100").fetchall()
    return [dict(row) for row in rows]


@app.get("/api/rentable-venue-ids")
def get_rentable_venue_ids() -> list[str]:
    with get_db() as conn:
        rows = conn.execute("SELECT DISTINCT venue_id FROM venue_rentals").fetchall()
    return [row["venue_id"] for row in rows]


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
