const state = {
    config: null,
    map: null,
    clusterer: null,
    venues: [],
    activities: [],
    selectedVenue: null,
    sport: 'all',
    query: '',
    viewMode: 'venues',
    loadingRequest: 0,
    reloadTimer: null,
    userPosition: null,
    userZoneRadius: 3,
    userMarker: null,
    userCircle: null,
    rentableVenueIds: new Set(),
    user: null,
};

let viewportSyncInProgress = false;
let viewportBridgeWarningShown = false;
let viewportPollTimer = 0;
let mapResizeFrame = 0;
let mapResizeTimer = 0;
let viewportResizeObserver = null;
let lastViewportWidth = 0;
let lastViewportHeight = 0;
const VIEWPORT_BRIDGE_TIMEOUT_MS = 300;

function viewportNumber(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getDomViewportSize() {
    return {
        width: Math.max(
            viewportNumber(window.innerWidth),
            viewportNumber(document.documentElement.clientWidth),
        ),
        height: Math.max(
            viewportNumber(window.innerHeight),
            viewportNumber(document.documentElement.clientHeight),
        ),
    };
}

function invalidateMapSize() {
    if (!state.map) return;

    window.cancelAnimationFrame(mapResizeFrame);
    window.clearTimeout(mapResizeTimer);

    mapResizeFrame = window.requestAnimationFrame(() => {
        try {
            state.map?.invalidateSize();
        } catch (_) {}
        window.requestAnimationFrame(() => {
            try {
                state.map?.invalidateSize();
            } catch (_) {}
        });
    });

    // Разворачивание Mini App в веб-версии MAX анимировано. Повторный вызов
    // нужен после того, как контейнер закончит менять размер.
    mapResizeTimer = window.setTimeout(() => {
        try {
            state.map?.invalidateSize();
        } catch (_) {}
        scheduleVenueReload();
    }, 300);
}

function applyViewportSize(width, height, forceMapResize = false) {
    const viewportChanged = (
        Math.abs(width - lastViewportWidth) > 1
        || Math.abs(height - lastViewportHeight) > 1
    );

    if (viewportChanged) {
        lastViewportWidth = width;
        lastViewportHeight = height;
        document.documentElement.style.setProperty('--app-viewport-width', `${width}px`);
        document.documentElement.style.setProperty('--app-viewport-height', `${height}px`);
    }

    if (viewportChanged || forceMapResize || mapSizeIsOutdated()) {
        invalidateMapSize();
    }

    return viewportChanged;
}

function mapSizeIsOutdated() {
    if (!state.map || typeof state.map.getSize !== 'function') return false;

    const mapContainer = document.querySelector('#map');
    const mapSize = state.map.getSize();
    if (!mapContainer || !Array.isArray(mapSize)) return false;

    const rect = mapContainer.getBoundingClientRect();
    return (
        Math.abs(rect.width - mapSize[0]) > 2
        || Math.abs(rect.height - mapSize[1]) > 2
    );
}

async function syncAppViewport({ forceMapResize = false } = {}) {
    // Сначала синхронизируемся с реальным DOM.
    const domViewport = getDomViewportSize();
    const domWidth = Math.round(domViewport.width);
    const domHeight = Math.round(domViewport.height);
    applyViewportSize(domWidth, domHeight, forceMapResize);

    const isMobileApp = window.WebApp?.platform === 'ios' || window.WebApp?.platform === 'android';
    if (!isMobileApp || typeof window.WebApp?.getViewportSize !== 'function') {
        return;
    }

    if (viewportSyncInProgress) return;
    viewportSyncInProgress = true;

    let bridgeWidth = 0;
    let bridgeHeight = 0;

    try {
        const bridgeViewport = await Promise.race([
            window.WebApp.getViewportSize(),
            new Promise((resolve) => {
                window.setTimeout(() => resolve(null), VIEWPORT_BRIDGE_TIMEOUT_MS);
            }),
        ]);
        bridgeWidth = viewportNumber(bridgeViewport?.width);
        bridgeHeight = viewportNumber(bridgeViewport?.height);
    } catch (error) {
        if (!viewportBridgeWarningShown) {
            viewportBridgeWarningShown = true;
            console.warn('MAX viewport недоступен, используем размер окна:', error);
        }
    } finally {
        viewportSyncInProgress = false;
    }

    if (bridgeWidth && bridgeHeight) {
        const width = Math.round(Math.max(domWidth, bridgeWidth));
        const height = Math.round(Math.max(domHeight, bridgeHeight));
        applyViewportSize(width, height, forceMapResize);
    }
}

async function getViewportDiagnostics() {
    let bridge = null;
    try {
        bridge = typeof window.WebApp?.getViewportSize === 'function'
            ? await Promise.race([
                window.WebApp.getViewportSize(),
                new Promise((resolve) => {
                    window.setTimeout(
                        () => resolve({ timeout: true }),
                        VIEWPORT_BRIDGE_TIMEOUT_MS,
                    );
                }),
            ])
            : null;
    } catch (error) {
        bridge = { error: String(error) };
    }

    const appShell = document.querySelector('.app-shell')?.getBoundingClientRect();
    const mapContainer = document.querySelector('#map')?.getBoundingClientRect();

    return {
        platform: window.WebApp?.platform || 'browser',
        window: getDomViewportSize(),
        visualViewport: window.visualViewport
            ? { width: window.visualViewport.width, height: window.visualViewport.height }
            : null,
        bridge,
        appShell: appShell ? { width: appShell.width, height: appShell.height } : null,
        mapContainer: mapContainer ? { width: mapContainer.width, height: mapContainer.height } : null,
        map: typeof state.map?.getSize === 'function' ? state.map.getSize() : null,
    };
}

window.sportlyViewportDebug = getViewportDiagnostics;

function bindViewportSync() {
    const syncAndResize = () => void syncAppViewport({ forceMapResize: true });

    window.addEventListener('resize', syncAndResize, { passive: true });
    window.addEventListener('orientationchange', syncAndResize, { passive: true });
    window.addEventListener('pageshow', syncAndResize);
    window.addEventListener('focus', syncAndResize);
    document.addEventListener('fullscreenchange', syncAndResize);
    window.visualViewport?.addEventListener('resize', syncAndResize, { passive: true });

    const mapContainer = document.querySelector('#map');
    if ('ResizeObserver' in window) {
        viewportResizeObserver = new ResizeObserver(() => {
            invalidateMapSize();
        });
        if (mapContainer) viewportResizeObserver.observe(mapContainer);
        if (document.body) viewportResizeObserver.observe(document.body);
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncAndResize();
    });

    if (typeof window.WebApp?.onEvent === 'function') {
        for (const eventName of ['viewportChanged', 'fullscreenChanged']) {
            try {
                window.WebApp.onEvent(eventName, syncAndResize);
            } catch (error) {
                console.warn(`MAX WebApp event ${eventName} недоступен:`, error);
            }
        }
    }

    window.clearInterval(viewportPollTimer);
    viewportPollTimer = window.setInterval(() => void syncAppViewport(), 750);
    void syncAppViewport({ forceMapResize: true });

    [60, 150, 300, 600, 1200, 2000].forEach((delay) => {
        window.setTimeout(syncAndResize, delay);
    });
}

function initUser() {
    if (window.WebApp) {
        try {
            window.WebApp.ready?.();
            window.WebApp.expand?.();
            if (window.WebApp.initDataUnsafe?.user) {
                state.user = window.WebApp.initDataUnsafe.user;
                return;
            }
        } catch (e) {
            console.warn('MAX WebApp init:', e);
        }
    }
    let guestId = localStorage.getItem('unipgGuestId') || localStorage.getItem('sportlyGuestId');
    if (!guestId) {
        guestId = 'guest_' + Math.random().toString(36).substring(2, 9);
    }
    localStorage.setItem('unipgGuestId', guestId);
    state.user = { id: guestId, first_name: 'Спортсмен' };
}


const elements = {
    searchForm: document.querySelector('#search-form'),
    searchInput: document.querySelector('#search-input'),
    searchClear: document.querySelector('#search-clear'),
    sportFilter: document.querySelector('#sport-filter'),
    showVenues: document.querySelector('#show-venues'),
    showGames: document.querySelector('#show-games'),
    myEventsButton: document.querySelector('#my-events-button'),
    myEventsCount: document.querySelector('#my-events-count'),
    myEventsDialog: document.querySelector('#my-events-dialog'),
    myEventsClose: document.querySelector('#my-events-close'),
    myEventsList: document.querySelector('#my-events-list'),
    locateButton: document.querySelector('#locate-button'),
    mapMessage: document.querySelector('#map-message'),
    resultsPanel: document.querySelector('#results-panel'),
    sheetHandle: document.querySelector('#sheet-handle'),
    handleCount: document.querySelector('#handle-count'),
    floatingPanelBtn: document.querySelector('#floating-panel-btn'),
    floatingCount: document.querySelector('#floating-count'),
    panelCloseBtn: document.querySelector('#panel-close-btn'),
    resultsTitle: document.querySelector('#results-title'),
    resultsCount: document.querySelector('#results-count'),
    resultsCaption: document.querySelector('#results-caption'),
    resultsList: document.querySelector('#results-list'),
    detailPanel: document.querySelector('#detail-panel'),
    detailClose: document.querySelector('#detail-close'),
    detailName: document.querySelector('#detail-name'),
    detailAddress: document.querySelector('#detail-address'),
    detailMetro: document.querySelector('#detail-metro'),
    detailDistance: document.querySelector('#detail-distance'),
    detailRating: document.querySelector('#detail-rating'),
    detailPhotos: document.querySelector('#detail-photos'),
    detail2gisLink: document.querySelector('#detail-2gis-link'),
    gamesList: document.querySelector('#games-list'),
    openCreate: document.querySelector('#open-create'),
    createDialog: document.querySelector('#create-dialog'),
    createClose: document.querySelector('#create-close'),
    createForm: document.querySelector('#create-form'),
    formVenueName: document.querySelector('#form-venue-name'),
    formVenueAddress: document.querySelector('#form-venue-address'),
    formError: document.querySelector('#form-error'),
    createSubmit: document.querySelector('#create-submit'),
    toast: document.querySelector('#toast'),
};

const sportNames = {
    football: 'Футбол',
    basketball: 'Баскетбол',
    volleyball: 'Волейбол',
    tennis: 'Теннис',
    workout: 'Воркаут',
};

function escapeHtml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function apiErrorMessage(payload, fallback = 'Не удалось выполнить запрос') {
    if (typeof payload?.detail === 'string') return payload.detail;
    if (Array.isArray(payload?.detail) && payload.detail[0]?.msg) return payload.detail[0].msg;
    return fallback;
}

async function api(path, options = {}) {
    const response = await fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(payload));
    return payload;
}

function showMapMessage(message, isError = false) {
    elements.mapMessage.textContent = message;
    elements.mapMessage.classList.toggle('is-error', isError);
    elements.mapMessage.classList.add('is-visible');
}

function hideMapMessage() {
    elements.mapMessage.classList.remove('is-visible', 'is-error');
}

let toastTimer;
function toast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2800);
}

function isInsideMoscow(lng, lat) {
    const { southWest, northEast } = state.config.moscowBounds;
    return lng >= southWest[0] && lng <= northEast[0] && lat >= southWest[1] && lat <= northEast[1];
}

function radiusForZoom(zoom) {
    if (zoom <= 10) return 20000;
    if (zoom <= 11) return 12000;
    if (zoom <= 12) return 7000;
    if (zoom <= 13) return 4500;
    if (zoom <= 14) return 2800;
    return 1600;
}

function activityCount(venueId) {
    return state.activities.filter((activity) => activity.venue_id === venueId).length;
}

function isInUserZone(venue) {
    if (!state.userPosition) return true; // no location = all active
    const [uLng, uLat] = state.userPosition;
    const R = 6371;
    const dLat = (venue.lat - uLat) * Math.PI / 180;
    const dLng = (venue.lng - uLng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(uLat*Math.PI/180) * Math.cos(venue.lat*Math.PI/180) * Math.sin(dLng/2)**2;
    const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return d <= state.userZoneRadius;
}

function visibleVenues() {
    if (state.viewMode === 'games') {
        return state.venues.filter((venue) => activityCount(venue.id) > 0);
    }
    return state.venues;
}

function markerHtml(venue) {
    const games = activityCount(venue.id);
    const badge = games ? `<span>${games}</span>` : '';
    const dimClass = isInUserZone(venue) ? '' : ' map-marker--dim';
    return `<div class="map-marker${dimClass}" title="${escapeHtml(venue.name)}"><i></i>${badge}</div>`;
}

function renderMarkers() {
    if (!state.clusterer) return;
    const markers = visibleVenues().map((venue) => ({
        type: 'html',
        coordinates: [venue.lng, venue.lat],
        html: markerHtml(venue),
        anchor: [18, 18],
        userData: { venueId: venue.id },
    }));
    state.clusterer.load(markers);
}

function venueMeta(venue) {
    const parts = [];
    if (venue.nearestMetro) {
        const metroDistance = venue.metroDistanceKm == null ? '' : ` · ${formatDistance(venue.metroDistanceKm)}`;
        parts.push(`м. ${venue.nearestMetro}${metroDistance}`);
    }
    if (!parts.length) parts.push(venue.address);
    if (venue.rating != null) {
        const reviews = venue.reviewCount ? ` (${venue.reviewCount})` : '';
        parts.push(`★ ${Number(venue.rating).toFixed(1)}${reviews}`);
    }
    return parts.join(' · ');
}

function reviewCountLabel(count) {
    if (!count) return 'нет отзывов';
    const lastTwo = count % 100;
    const last = count % 10;
    if (lastTwo >= 11 && lastTwo <= 14) return `${count} отзывов`;
    if (last === 1) return `${count} отзыв`;
    if (last >= 2 && last <= 4) return `${count} отзыва`;
    return `${count} отзывов`;
}

function formatDistance(value) {
    if (value == null) return '—';
    return value < 1 ? `${Math.round(value * 1000)} м` : `${value.toFixed(1)} км`;
}

function renderResults() {
    const venues = visibleVenues();
    elements.resultsCount.textContent = String(venues.length);
    if (elements.floatingCount) elements.floatingCount.textContent = String(venues.length);
    if (elements.handleCount) elements.handleCount.textContent = String(venues.length);
    elements.resultsTitle.textContent = state.viewMode === 'games' ? 'Игры рядом' : 'Спорт рядом';
    elements.resultsCaption.textContent = state.viewMode === 'games'
        ? 'Площадки, где уже собираются играть'
        : 'Выберите площадку на карте или в списке';

    if (!venues.length) {
        const title = state.viewMode === 'games' ? 'Пока нет игр рядом' : 'Ничего не найдено';
        const text = state.viewMode === 'games'
            ? 'Выберите площадку и создайте первую игру.'
            : 'Передвиньте карту, измените вид спорта или поисковый запрос.';
        elements.resultsList.innerHTML = `<div class="empty-state"><strong>${title}</strong>${text}</div>`;
        return;
    }

    elements.resultsList.innerHTML = venues.map((venue) => {
        const games = activityCount(venue.id);
        const selectedClass = state.selectedVenue?.id === venue.id ? ' is-selected' : '';
        const gameText = games ? `<small>${games} ${games === 1 ? 'игра' : 'игры'} · ${escapeHtml(venueMeta(venue))}</small>` : `<small>${escapeHtml(venueMeta(venue))}</small>`;
        const rentalBadge = state.rentableVenueIds.has(venue.id) ? '<span class="rental-badge">Аренда</span>' : '';
        return `
            <button class="venue-card${selectedClass}" type="button" data-venue-id="${escapeHtml(venue.id)}">
                <span class="card-icon" aria-hidden="true">●</span>
                <span>
                    <strong>${escapeHtml(venue.name)}</strong>
                    ${gameText}
                    ${rentalBadge}
                </span>
                <span class="card-distance">${formatDistance(venue.distanceKm)}</span>
            </button>`;
    }).join('');

    elements.resultsList.querySelectorAll('[data-venue-id]').forEach((button) => {
        button.addEventListener('click', () => selectVenue(button.dataset.venueId, true));
    });
}

function renderLoading() {
    elements.resultsCount.textContent = '…';
    if (elements.floatingCount) elements.floatingCount.textContent = '…';
    if (elements.handleCount) elements.handleCount.textContent = '…';
    elements.resultsList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
}

function formatGameDate(value) {
    return new Intl.DateTimeFormat('ru-RU', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(value));
}

function joinedIds() {
    try {
        const raw = localStorage.getItem('unipgJoinedGames') || localStorage.getItem('sportlyJoinedGames') || '[]';
        const values = JSON.parse(raw);
        return new Set(values.map(Number).filter(Number.isInteger));
    } catch {
        return new Set();
    }
}

function saveJoinedIds(ids) {
    localStorage.setItem('unipgJoinedGames', JSON.stringify([...ids]));
}

function joinedActivities() {
    const joined = joinedIds();
    return state.activities.filter((activity) => joined.has(activity.id));
}

function updateMyEventsCount() {
    elements.myEventsCount.textContent = String(joinedActivities().length);
}

async function openEventChat(activityId) {
    try {
        const userId = state.user?.id ? `?user_id=${encodeURIComponent(state.user.id)}` : '';
        const chat = await api(`/api/activities/${activityId}/chat${userId}`);
        if (chat && chat.invite_link) {
            if (window.WebApp && typeof window.WebApp.openLink === 'function') {
                window.WebApp.openLink(chat.invite_link);
            } else {
                window.open(chat.invite_link, '_blank');
            }
        } else {
            toast('Ссылка на чат ещё не добавлена организатором');
        }
    } catch (error) {
        toast(error.message || 'Чат недоступен');
    }
}

function renderMyEvents() {
    const activities = joinedActivities();
    updateMyEventsCount();
    if (!activities.length) {
        elements.myEventsList.innerHTML = '<div class="empty-state"><strong>Записей пока нет</strong>Выберите площадку, откройте игру и нажмите «Присоединиться».</div>';
        return;
    }

    elements.myEventsList.innerHTML = activities.map((game) => `
        <article class="my-event-card">
            <div class="my-event-top">
                <div>
                    <h3>${escapeHtml(game.title)}</h3>
                    <p class="my-event-meta">${escapeHtml(sportNames[game.sport_type] || game.sport_type)} · ${escapeHtml(formatGameDate(game.starts_at))}</p>
                </div>
                <span class="game-count">${game.current_players}/${game.max_players}</span>
            </div>
            <p class="my-event-venue">${escapeHtml(game.venue_name)}${game.nearest_metro ? ` · м. ${escapeHtml(game.nearest_metro)}` : ''}</p>
            <div class="my-event-actions">
                <button class="chat-button" type="button" data-chat-act-id="${game.id}">💬 Чат в MAX</button>
                <button class="secondary-button" type="button" data-show-event="${game.id}">Показать на карте</button>
                <button class="leave-button" type="button" data-leave-id="${game.id}">Отказаться</button>
            </div>
        </article>
    `).join('');

    elements.myEventsList.querySelectorAll('[data-chat-act-id]').forEach((button) => {
        button.addEventListener('click', () => openEventChat(Number(button.dataset.chatActId)));
    });
    elements.myEventsList.querySelectorAll('[data-show-event]').forEach((button) => {
        button.addEventListener('click', () => showEventOnMap(Number(button.dataset.showEvent)));
    });
    elements.myEventsList.querySelectorAll('[data-leave-id]').forEach((button) => {
        button.addEventListener('click', () => leaveGame(Number(button.dataset.leaveId), button));
    });
}

function renderGames(games) {
    if (!games.length) {
        elements.gamesList.innerHTML = '<div class="empty-state"><strong>Здесь пока нет игр</strong>Можно создать первую игру на этой площадке.</div>';
        return;
    }

    const joined = joinedIds();
    elements.gamesList.innerHTML = games.map((game) => {
        const isJoined = joined.has(game.id);
        const isFull = game.current_players >= game.max_players;
        const disabled = !isJoined && isFull;
        const label = isJoined ? 'Отказаться от участия' : isFull ? 'Мест нет' : 'Присоединиться';
        const actionAttribute = isJoined ? `data-leave-id="${game.id}"` : `data-join-id="${game.id}"`;
        const leaveClass = isJoined ? ' is-leave' : '';
        const chatButton = isJoined
            ? `<button class="chat-button" type="button" data-chat-act-id="${game.id}">💬 Чат в MAX</button>`
            : '';
        return `
            <article class="game-card">
                <div class="game-top">
                    <div>
                        <h4>${escapeHtml(game.title)}</h4>
                        <p>${escapeHtml(sportNames[game.sport_type] || game.sport_type)} · ${escapeHtml(formatGameDate(game.starts_at))}</p>
                    </div>
                    <span class="game-count">${game.current_players}/${game.max_players}</span>
                </div>
                <div class="game-actions-row">
                    <button class="join-button${leaveClass}" type="button" ${actionAttribute} ${disabled ? 'disabled' : ''}>${label}</button>
                    ${chatButton}
                </div>
            </article>`;
    }).join('');

    elements.gamesList.querySelectorAll('[data-chat-act-id]').forEach((button) => {
        button.addEventListener('click', () => openEventChat(Number(button.dataset.chatActId)));
    });
    elements.gamesList.querySelectorAll('[data-join-id]').forEach((button) => {
        button.addEventListener('click', () => joinGame(Number(button.dataset.joinId)));
    });
    elements.gamesList.querySelectorAll('[data-leave-id]').forEach((button) => {
        button.addEventListener('click', () => leaveGame(Number(button.dataset.leaveId), button));
    });
}


async function loadActivities() {
    try {
        state.activities = await api('/api/activities');
        if (state.user?.id) {
            try {
                const mine = await api(`/api/users/${encodeURIComponent(state.user.id)}/activities`);
                saveJoinedIds(new Set(mine.map((activity) => Number(activity.id))));
            } catch (error) {
                console.warn('Не удалось синхронизировать записи пользователя:', error);
            }
        }
        updateMyEventsCount();
    } catch (error) {
        console.error(error);
        state.activities = [];
        updateMyEventsCount();
    }
}

async function loadVenues() {
    if (!state.map) return;
    const requestId = ++state.loadingRequest;
    const [lng, lat] = state.map.getCenter();
    const radius = radiusForZoom(state.map.getZoom());
    const params = new URLSearchParams({
        lng: String(lng),
        lat: String(lat),
        radius: String(radius),
        sport: state.sport,
    });
    if (state.query) params.set('q', state.query);

    renderLoading();
    showMapMessage('Ищем площадки в этой части Москвы…');
    try {
        const payload = await api(`/api/venues?${params}`);
        if (requestId !== state.loadingRequest) return;
        state.venues = payload.items || [];
        renderMarkers();
        renderResults();
        hideMapMessage();
    } catch (error) {
        if (requestId !== state.loadingRequest) return;
        state.venues = [];
        renderMarkers();
        elements.resultsCount.textContent = '0';
        elements.resultsList.innerHTML = `<div class="empty-state"><strong>Не удалось загрузить площадки</strong>${escapeHtml(error.message)}</div>`;
        showMapMessage(error.message, true);
    }
}

function scheduleVenueReload() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(loadVenues, 450);
}

async function selectVenue(venueId, moveMap = false) {
    const activity = state.activities.find((item) => item.venue_id === venueId);
    const venue = state.venues.find((item) => item.id === venueId) || (activity && {
        id: activity.venue_id,
        name: activity.venue_name,
        address: activity.address,
        nearestMetro: activity.nearest_metro,
        metroDistanceKm: null,
        distanceKm: null,
        rating: null,
        reviewCount: 0,
        hasPhotos: false,
        dgisUrl: `https://2gis.ru/moscow/geo/${encodeURIComponent(activity.venue_id)}`,
        lat: activity.lat,
        lng: activity.lng,
    });
    if (!venue) return;
    state.selectedVenue = venue;
    renderResults();

    if (moveMap && state.map) {
        state.map.setCenter([venue.lng, venue.lat], { duration: 350 });
        if (state.map.getZoom() < 14) state.map.setZoom(14, { duration: 350 });
    }

    elements.detailName.textContent = venue.name;
    elements.detailAddress.textContent = venue.address;
    elements.detailMetro.textContent = venue.nearestMetro
        ? `${venue.nearestMetro}${venue.metroDistanceKm == null ? '' : ` · ${formatDistance(venue.metroDistanceKm)}`}`
        : 'Не указано';
    elements.detailDistance.textContent = formatDistance(venue.distanceKm);
    elements.detailRating.textContent = venue.rating == null
        ? 'Нет оценок'
        : `★ ${Number(venue.rating).toFixed(1)} · ${reviewCountLabel(venue.reviewCount)}`;
    elements.detailPhotos.textContent = venue.hasPhotos ? 'Есть в 2ГИС' : 'Не найдены';
    
    const rentalSection = document.querySelector('#detail-rental');
    if (rentalSection) {
        if (state.rentableVenueIds.has(venue.id)) {
            rentalSection.classList.add('is-visible');
            try {
                const rentals = await api(`/api/rentals?venue_id=${encodeURIComponent(venue.id)}`);
                const rental = rentals[0];
                if (rental) {
                    document.querySelector('#rental-price').textContent = rental.price_per_hour ? `${rental.price_per_hour} ₽/час` : 'Уточняйте';
                    document.querySelector('#rental-phone').textContent = rental.phone || 'Не указан';
                    document.querySelector('#rental-phone').href = rental.phone ? `tel:${rental.phone}` : '#';
                    document.querySelector('#rental-description').textContent = rental.description || '';
                }
            } catch { /* ignore */ }
        } else {
            rentalSection.classList.remove('is-visible');
        }
    }

    elements.detail2gisLink.href = venue.dgisUrl || `https://2gis.ru/moscow/geo/${encodeURIComponent(venue.id)}`;
    elements.gamesList.innerHTML = '<div class="skeleton"></div>';
    elements.detailPanel.classList.add('is-open');
    elements.detailPanel.setAttribute('aria-hidden', 'false');

    try {
        const games = await api(`/api/activities?venue_id=${encodeURIComponent(venue.id)}`);
        renderGames(games);
    } catch (error) {
        elements.gamesList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
}

function closeDetails() {
    state.selectedVenue = null;
    elements.detailPanel.classList.remove('is-open');
    elements.detailPanel.setAttribute('aria-hidden', 'true');
    renderResults();
}

function setViewMode(mode) {
    state.viewMode = mode;
    elements.showVenues.classList.toggle('is-active', mode === 'venues');
    elements.showGames.classList.toggle('is-active', mode === 'games');
    elements.showVenues.setAttribute('aria-pressed', String(mode === 'venues'));
    elements.showGames.setAttribute('aria-pressed', String(mode === 'games'));
    renderMarkers();
    renderResults();
}

function openCreateDialog() {
    if (!state.selectedVenue) return;
    elements.formVenueName.textContent = state.selectedVenue.name;
    elements.formVenueAddress.textContent = state.selectedVenue.address;
    elements.formError.textContent = '';
    const dateInput = elements.createForm.elements.starts_at;
    const nextHour = new Date(Date.now() + 60 * 60 * 1000);
    nextHour.setMinutes(0, 0, 0);
    const localDate = new Date(nextHour.getTime() - nextHour.getTimezoneOffset() * 60000);
    dateInput.min = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    dateInput.value = localDate.toISOString().slice(0, 16);
    elements.createDialog.showModal();
}

async function createGame(event) {
    event.preventDefault();
    if (!state.selectedVenue) return;
    const formData = new FormData(elements.createForm);
    const startsAt = new Date(String(formData.get('starts_at')));
    const chatInviteLink = formData.get('chat_invite_link')?.trim() || '';
    const creatorName = state.user ? `${state.user.first_name || ''} ${state.user.last_name || ''}`.trim() || 'Организатор' : 'Организатор';
    const payload = {
        venue_id: state.selectedVenue.id,
        venue_name: state.selectedVenue.name,
        address: state.selectedVenue.address,
        nearest_metro: state.selectedVenue.nearestMetro || '',
        lat: state.selectedVenue.lat,
        lng: state.selectedVenue.lng,
        title: formData.get('title'),
        sport_type: formData.get('sport_type'),
        starts_at: startsAt.toISOString(),
        max_players: Number(formData.get('max_players')),
        creator_id: state.user?.id ? String(state.user.id) : '',
        creator_name: creatorName,
        age_restriction: 'all',
    };

    elements.createSubmit.disabled = true;
    elements.createSubmit.textContent = 'Публикуем…';
    elements.formError.textContent = '';
    try {
        const activity = await api('/api/activities', { method: 'POST', body: JSON.stringify(payload) });
        if (chatInviteLink) {
            try {
                await api(`/api/activities/${activity.id}/chat?chat_id=1&invite_link=${encodeURIComponent(chatInviteLink)}`, { method: 'POST' });
            } catch (chatErr) {
                console.warn('Chat link registration failed:', chatErr);
            }
        }
        const joined = joinedIds();
        joined.add(activity.id);
        saveJoinedIds(joined);
        elements.createDialog.close();
        elements.createForm.reset();
        await loadActivities();
        renderMarkers();
        renderResults();
        await selectVenue(state.selectedVenue.id);
        toast('Игра опубликована');
    } catch (error) {
        elements.formError.textContent = error.message;
    } finally {
        elements.createSubmit.disabled = false;
        elements.createSubmit.textContent = 'Опубликовать игру';
    }
}

async function joinGame(activityId) {
    try {
        const userId = state.user?.id ? `?user_id=${encodeURIComponent(state.user.id)}&user_name=${encodeURIComponent(state.user.first_name || 'Игрок')}` : '';
        await api(`/api/activities/${activityId}/join${userId}`, { method: 'POST' });
        const joined = joinedIds();
        joined.add(activityId);
        saveJoinedIds(joined);
        await loadActivities();
        renderMarkers();
        renderResults();
        if (state.selectedVenue) await selectVenue(state.selectedVenue.id);
        toast('Вы присоединились к игре! Чат в MAX теперь доступен');
    } catch (error) {
        toast(error.message);
    }
}

async function leaveGame(activityId, button = null) {
    if (button) button.disabled = true;
    try {
        const userId = state.user?.id ? `?user_id=${encodeURIComponent(state.user.id)}` : '';
        await api(`/api/activities/${activityId}/join${userId}`, { method: 'DELETE' });
        const joined = joinedIds();
        joined.delete(activityId);
        saveJoinedIds(joined);
        await loadActivities();
        renderMarkers();
        renderResults();
        if (state.selectedVenue) await selectVenue(state.selectedVenue.id);
        if (elements.myEventsDialog.open) renderMyEvents();
        toast('Запись отменена. Доступ к чату закрыт');
    } catch (error) {
        if (button) button.disabled = false;
        toast(error.message);
    }
}


async function openMyEvents() {
    elements.myEventsList.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
    elements.myEventsDialog.showModal();
    await loadActivities();
    renderMyEvents();
}

function showEventOnMap(activityId) {
    const activity = state.activities.find((item) => item.id === activityId);
    if (!activity) return;
    elements.myEventsDialog.close();
    state.map.setCenter([activity.lng, activity.lat], { duration: 350 });
    if (state.map.getZoom() < 14) state.map.setZoom(14, { duration: 350 });
    selectVenue(activity.venue_id);
}

function locateUser() {
    if (!navigator.geolocation) {
        toast('Геолокация не поддерживается');
        return;
    }
    elements.locateButton.disabled = true;
    navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
            elements.locateButton.disabled = false;
            if (!isInsideMoscow(coords.longitude, coords.latitude)) {
                toast('Сервис пока работает только в Москве');
                return;
            }
            state.map.setCenter([coords.longitude, coords.latitude], { duration: 500 });
            state.map.setZoom(14, { duration: 500 });
            
            if (state.userMarker) state.userMarker.destroy();
            if (state.userCircle) state.userCircle.destroy();

            state.userPosition = [coords.longitude, coords.latitude];

            state.userMarker = new mapgl.HtmlMarker(state.map, {
                coordinates: state.userPosition,
                html: '<div class="user-marker"><div class="user-marker-pulse"></div></div>',
                anchor: [12, 12],
            });

            state.userCircle = new mapgl.Circle(state.map, {
                coordinates: state.userPosition,
                radius: state.userZoneRadius * 1000,
                color: 'rgba(41, 130, 255, 0.08)',
                strokeColor: 'rgba(41, 130, 255, 0.35)',
                strokeWidth: 2,
            });
            
            scheduleVenueReload();
        },
        () => {
            elements.locateButton.disabled = false;
            toast('Не удалось получить местоположение');
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
}

function bindEvents() {
    elements.searchForm.addEventListener('submit', (event) => {
        event.preventDefault();
        state.query = elements.searchInput.value.trim();
        closeDetails();
        loadVenues();
    });
    elements.searchClear.addEventListener('click', () => {
        elements.searchInput.value = '';
        state.query = '';
        loadVenues();
        elements.searchInput.focus();
    });
    elements.sportFilter.addEventListener('change', () => {
        state.sport = elements.sportFilter.value;
        closeDetails();
        loadVenues();
    });
    function toggleResultsPanel(force) {
        const isMobile = window.innerWidth <= 900;
        const isAlreadyOpen = isMobile
            ? elements.resultsPanel.classList.contains('is-expanded')
            : elements.resultsPanel.classList.contains('is-open');
        const shouldOpen = typeof force === 'boolean' ? force : !isAlreadyOpen;

        elements.resultsPanel.classList.toggle('is-expanded', shouldOpen);
        elements.resultsPanel.classList.toggle('is-open', shouldOpen);

        if (elements.floatingPanelBtn) {
            elements.floatingPanelBtn.classList.toggle('is-hidden', shouldOpen);
        }
        state.invalidateMapSize?.();
    }

    elements.showVenues.addEventListener('click', () => {
        setViewMode('venues');
        toggleResultsPanel(true);
    });
    elements.showGames.addEventListener('click', () => {
        setViewMode('games');
        toggleResultsPanel(true);
    });
    elements.myEventsButton.addEventListener('click', openMyEvents);

    elements.locateButton.addEventListener('click', locateUser);
    if (elements.sheetHandle) {
        elements.sheetHandle.addEventListener('click', () => toggleResultsPanel());
    }
    if (elements.floatingPanelBtn) {
        elements.floatingPanelBtn.addEventListener('click', () => toggleResultsPanel(true));
    }
    if (elements.panelCloseBtn) {
        elements.panelCloseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleResultsPanel(false);
        });
    }

    elements.detailClose.addEventListener('click', closeDetails);
    elements.openCreate.addEventListener('click', openCreateDialog);
    elements.createClose.addEventListener('click', () => elements.createDialog.close());
    elements.createForm.addEventListener('submit', createGame);
    elements.createDialog.addEventListener('click', (event) => {
        if (event.target === elements.createDialog) elements.createDialog.close();
    });
    elements.myEventsClose.addEventListener('click', () => elements.myEventsDialog.close());
    elements.myEventsDialog.addEventListener('click', (event) => {
        if (event.target === elements.myEventsDialog) elements.myEventsDialog.close();
    });
}

async function init() {
    initUser();
    bindEvents();
    bindViewportSync();

    // MAX Bridge BackButton support
    if (window.WebApp?.BackButton) {
        window.WebApp.BackButton.onClick(() => {
            if (elements.detailPanel.classList.contains('is-open')) {
                closeDetails();
                window.WebApp.BackButton.hide();
            } else if (elements.resultsPanel.classList.contains('is-open') || elements.resultsPanel.classList.contains('is-expanded')) {
                toggleResultsPanel(false);
                window.WebApp.BackButton.hide();
            } else if (elements.myEventsDialog.open) {
                elements.myEventsDialog.close();
                window.WebApp.BackButton.hide();
            } else if (elements.createDialog.open) {
                elements.createDialog.close();
                window.WebApp.BackButton.hide();
            }
        });
    }

    showMapMessage('Загружаем карту…');
    try {
        state.config = await api('/api/config');
        await loadActivities();
        try {
            const ids = await api('/api/rentable-venue-ids');
            state.rentableVenueIds = new Set(ids);
        } catch { state.rentableVenueIds = new Set(); }
    } catch (error) {
        showMapMessage(error.message, true);
        return;
    }

    // Process deep links from MAX bot (supports URL query, hash, and MAX Bridge start_param)
    const urlParams = new URLSearchParams(window.location.search);
    let hashParams = new URLSearchParams();
    if (window.location.hash && window.location.hash.includes('?')) {
        hashParams = new URLSearchParams(window.location.hash.split('?')[1]);
    }
    const startParam = window.WebApp?.initDataUnsafe?.start_param ||
        urlParams.get('start_param') ||
        urlParams.get('startapp') ||
        urlParams.get('payload') ||
        hashParams.get('start_param') ||
        hashParams.get('startapp');

    const viewParam = urlParams.get('view') || hashParams.get('view');
    const actParam = urlParams.get('activity') || hashParams.get('activity');

    if (viewParam === 'games' || startParam === 'games' || startParam === 'view_games') {
        setViewMode('games');
    } else if (viewParam === 'venues' || startParam === 'venues' || startParam === 'view_venues') {
        setViewMode('venues');
    } else if (viewParam === 'my_events' || startParam === 'my_events' || startParam === 'view_my_events') {
        openMyEvents();
    }

    const activityTarget = actParam
        ? Number(actParam)
        : (startParam && startParam.startsWith('activity_') ? Number(startParam.replace('activity_', '')) : null);

    if (activityTarget && !isNaN(activityTarget)) {
        setTimeout(() => {
            const found = state.activities.find((item) => item.id === activityTarget);
            if (found) {
                showEventOnMap(activityTarget);
            }
        }, 500);
    }


    if (!window.mapgl) {
        showMapMessage('Не удалось загрузить библиотеку 2ГИС', true);
        return;
    }
    if (!state.config.mapKey) {
        showMapMessage('Добавьте TWOGIS_MAPGL_API_KEY в .env', true);
        elements.resultsList.innerHTML = '<div class="empty-state"><strong>Нужен ключ карты 2ГИС</strong>Добавьте TWOGIS_MAPGL_API_KEY в файл .env и перезапустите сервер.</div>';
        return;
    }

    const mapOptions = {
        center: state.config.moscowCenter,
        zoom: 11,
        minZoom: 9,
        maxZoom: 20,
        maxBounds: state.config.moscowBounds,
        key: state.config.mapKey,
        zoomControl: false,
        trafficControl: false,
        floorControl: false,
        enableTrackResize: true,
    };
    if (state.config.mapStyleId) mapOptions.style = state.config.mapStyleId;
    state.map = new mapgl.Map('map', mapOptions);
    void syncAppViewport({ forceMapResize: true });

    if (typeof mapgl.Clusterer === 'function') {
        state.clusterer = new mapgl.Clusterer(state.map, {
            radius: 64,
            clusterStyle: (count) => ({
                type: 'html',
                html: `<div class="map-cluster"><span>${count}</span></div>`,
            }),
        });
        state.clusterer.on('click', (event) => {
            if (event.target.type === 'marker') {
                selectVenue(event.target.data.userData.venueId);
                return;
            }
            const points = event.target.data || [];
            if (!points.length) return;
            const center = points.reduce((total, point) => [
                total[0] + point.coordinates[0] / points.length,
                total[1] + point.coordinates[1] / points.length,
            ], [0, 0]);
            state.map.setCenter(center, { duration: 350 });
            state.map.setZoom(Math.min(state.map.getZoom() + 2, 18), { duration: 350 });
        });
    }

    state.map.on('centerend', scheduleVenueReload);
    state.map.on('zoomend', scheduleVenueReload);
    await loadVenues();
}

init();
