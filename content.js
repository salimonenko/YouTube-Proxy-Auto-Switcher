/**
 * content.js - Скрипт, внедряемый в страницу YouTube.
 * Отвечает за UI-уведомления и мониторинг доступности.
 */

/* Пояснения по особенностям разработки расширений:
document.body.appendChild: В расширениях content.js имеет полный доступ к DOM страницы. Я создал элемент div программно и добавил его в конец body. Это самый простой способ добавить интерфейс, не создавая отдельный HTML-файл.

chrome.runtime.sendMessage: Это обратный путь связи. В отличие от background.js, который ищет активную вкладку, content.js точно знает, где он находится, и просто «кричит» в сторону фонового процесса.

chrome.runtime.lastError: Очень важный момент. Если фоновый скрипт (service_worker) «уснул» или расширение было обновлено, sendMessage вызовет ошибку. Проверка lastError предотвращает падение всего скрипта.

setInterval для мониторинга: В YouTube плеер работает в сложном фреймворке. Вместо того чтобы пытаться «взломать» объект плеера, я добавил легкий 

fetch(window.location.href, { method: 'HEAD' }). Если прокси-узел «умер», этот запрос (заголовок страницы) вернет ошибку сети, что станет триггером для смены прокси.

isRecovering (Флаг состояния): Чтобы расширение не засыпало систему сотнями запросов, пока прокси переключается, этот флаг блокирует повторные вызовы reportConnectionIssue до завершения текущего цикла.*/


/**
 * content.js
 *
 * Роль этого скрипта:
 * 1. Мониторинг доступности сети и состояния видеоплеера YouTube.
 * 2. Управление пользовательским интерфейсом (уведомлениями) при сбоях.
 * 3. Взаимодействие с background.js для запроса нового прокси.
 *
 * Скрипт работает в "изолированном мире" (Isolated World), что позволяет ему
 * взаимодействовать с DOM страницы, не конфликтуя с оригинальными скриптами YouTube.
 */

// --- КОНФИГУРАЦИЯ ---

/**
 * Частота регулярной проверки сети.
 *
 * Раньше здесь стояло 2000 (2 секунды). Это было слишком агрессивно:
 * каждые 2 секунды делался HEAD-запрос к текущей странице YouTube,
 * который шёл через прокси. Получалась постоянная нагрузка на прокси,
 * который мы как раз пытаемся беречь ради скорости. Плюс YouTube мог
 * ответить 403/429/302 — и это ложно трактовалось как «прокси умер».
 *
 * Теперь проверка идёт раз в 30 секунд — этого достаточно, чтобы заметить
 * долгий сбой, но не создавать постоянный трафик. Основной триггер смены
 * прокси — события видеоплеера (waiting/playing), а не этот таймер.
 */
const CHECK_INTERVAL = 30000;

const VIDEO_STALL_THRESHOLD = 5000; // Порог зависания видео (5 секунд) до смены прокси
const RECOVERY_NOTIFICATION_DELAY = 5000; // Задержка появления UI-уведомления

const EXT_ID = `[${chrome.runtime.id}]`;
const EXT_DIR= 'MyExtension'; 	// Папка в каталоге расширения браузера Edge, в которой хранится наше прокси-расширение
const EXT_NAME = 'Proxy Auto-Switcher for YouTube'; // Дублирование из файла manifest.json


// Переменные состояния
let isRecovering = false;          // Флаг процесса восстановления прокси
let recoveryStartTime = null;      // Время начала сбоя для отсчета показа UI
let videoStallTimer = null;        // Таймер для отслеживания зависания видео
let notificationElement = null;    // Ссылка на DOM-элемент уведомления

/**
 * Таймер показа UI-уведомления о восстановлении.
 *
 * Раньше uiTimer создавался локально внутри handleConnectionFailure и нигде
 * не сохранялся — очистить его можно было только изнутри его же колбэка.
 * Если уведомление скрывалось извне (например, по сообщению PROXY_EXHAUSTED
 * или PROXY_OK), таймер продолжал тикать до следующей проверки.
 * Теперь храним ссылку в переменной модуля и очищаем её в hideRecoveryNotification.
 */
let uiTimer = null;

/**
 * Создает и показывает уведомление пользователю, если восстановление связи
 * занимает слишком много времени.
 */
function showRecoveryNotification() {
    if (notificationElement) return; // Не создаем дубликат

    notificationElement = document.createElement('div');
    notificationElement.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 9999;
        background: #f44336; color: white; padding: 15px 25px;
        border-radius: 8px; font-family: Arial, sans-serif;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3); cursor: default;
    `;
    notificationElement.innerText = 'Проблема со связью. Пробуем сменить прокси...';

    // Кнопка закрытия уведомления
    const closeBtn = document.createElement('span');
    closeBtn.innerText = '\u00D7';
    closeBtn.style.cssText = 'margin-left: 15px; cursor: pointer; font-weight: bold;';
    closeBtn.onclick = () => {
        notificationElement.remove();
        notificationElement = null;
    };

    notificationElement.appendChild(closeBtn);
    document.body.appendChild(notificationElement);
}

/**
 * Скрывает уведомление, когда связь успешно восстановлена.
 * Также очищает uiTimer, чтобы он не тикал после скрытия уведомления.
 */
function hideRecoveryNotification() {
    if (uiTimer) {
        clearInterval(uiTimer);
        uiTimer = null;
    }
    if (notificationElement) {
        // Проверяем, что элемент всё еще находится в DOM дерева текущей страницы
        if (document.body && document.body.contains(notificationElement)) {
            notificationElement.remove();
        }
        notificationElement = null; // В любом случае обнуляем ссылку
    }
}

/**
 * Основная функция обработки сбоя.
 * Сообщает фоновому скрипту о необходимости смены прокси и запускает таймер UI.
 */
async function handleConnectionFailure() {
    if (isRecovering) return; // Если уже в процессе смены, ничего не делаем

    console.warn(EXT_NAME + '[Proxy Monitor] Connection failure detected. Requesting new proxy...');
    isRecovering = true;
    recoveryStartTime = Date.now();

    /*
     * Отправляем сигнал в background.js и ЧИТАЕМ ОТВЕТ.
     *
     * Раньше колбэк только проверял chrome.runtime.lastError, а сам response
     * игнорировал. background.js при этом вызывал sendResponse({status: 'ok'|'fail'}),
     * то есть ответ формировался, но никуда не шёл.
     *
     * Теперь используем ответ:
     *   - status === 'ok':  background.js проверил текущий прокси и он ЖИВ.
     *                       Значит, сбой был не из-за прокси (возможно, проблема
     *                       на стороне YouTube или ложное срабатывание HEAD).
     *                       Сбрасываем isRecovering и уведомление, не дожидаясь
     *                       PROXY_OK или следующего checkNetworkStatus.
     *   - status === 'fail': прокси мёртв или ещё не установлен; background.js
     *                        уже запустил proxyLifecycle. Оставляем isRecovering = true,
     *                        ждём PROXY_OK / PROXY_EXHAUSTED / PROXY_API_TIMEOUT.
		status === 'fail' не обрабатывается явно — и это корректно для текущей архитектуры.
	 
	 Ответ status === 'fail' означает, что background.js уже запустил proxyLifecycle() (или сейчас запустит). Дальше background.js сам пришлёт одно из сообщений:
		PROXY_OK — прокси установлен и работает → content.js сбросит isRecovering;
		PROXY_EXHAUSTED — список исчерпан → content.js сбросит isRecovering и покажет сообщение;
		PROXY_API_TIMEOUT — PHP завис → content.js покажет сообщение, но isRecovering не сбросит (это правильно: прокси ещё не получен, идёт повтор);
		PROXY_ERROR — ошибка в цикле → content.js покажет сообщение, isRecovering не сбросит (тоже правильно: proxyLifecycle продолжит попытки).
     */
    chrome.runtime.sendMessage({ action: 'check_connection' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error(EXT_NAME + '[Proxy Monitor] Error sending message:', chrome.runtime.lastError);
            return;
        }
        if (response && response.status === 'ok') {
            console.log(EXT_NAME + '[Proxy Monitor] Background says: current proxy is OK. Stopping recovery.');
            hideRecoveryNotification();
            isRecovering = false;
            recoveryStartTime = null;
        } else {
            console.log(EXT_NAME + '[Proxy Monitor] Background says: proxy failed or not set. Recovery continues.');
        }
    });

    // Запускаем проверку времени для показа уведомления.
    // Ссылку на таймер сохраняем в uiTimer, чтобы hideRecoveryNotification мог его очистить.
    uiTimer = setInterval(() => {
        if (!isRecovering) {
            clearInterval(uiTimer);
            uiTimer = null;
            return;
        }
        if (Date.now() - recoveryStartTime > RECOVERY_NOTIFICATION_DELAY) {
            showRecoveryNotification();
        }
    }, 1000);
}

/**
 * Функция проверки доступности сети через HEAD-запрос.
 *
 * ВАЖНОЕ РАЗЛИЧЕНИЕ (добавлено при доработке):
 * Раньше любой не-2xx-ответ (response.ok === false) трактовался как сбой
 * и вел к смене прокси. Но YouTube может ответить 403 (бот-защита),
 * 429 (rate limit), 302 (редирект на consent) — при этом прокси ЖИВ.
 * Смена прокси в такой ситуации только ухудшает положение.
 *
 * Поэтому теперь:
 *   - TypeError / AbortError (fetch вообще не получил ответ) — это реальный
 *     сбой сети/прокси, вызываем handleConnectionFailure();
 *   - response.status >= 500 — серверная ошибка, тоже считаем сбоем;
 *   - response.status 4xx или 3xx — прокси жив, YouTube просто ответил не тем,
 *     что мы ждали. Сбоем не считаем; если мы были в isRecovering — сбрасываем.
 */
async function checkNetworkStatus() {
    try {
        // Используем метод HEAD, чтобы не скачивать всё тело страницы
        const response = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });

        if (response.ok) {
            // Если сеть ок и мы были в состоянии восстановления — сбрасываем флаги
            if (isRecovering) {
                console.log(EXT_NAME + '[Proxy Monitor] Connection restored.');
                isRecovering = false;
                recoveryStartTime = null;
                hideRecoveryNotification();
            }
        } else if (response.status >= 500) {
            // Серверная ошибка — считаем сбоем
            console.warn(EXT_NAME + '[Proxy Monitor] Server error ' + response.status + ', treating as failure.');
            handleConnectionFailure();
        } else {
            // 3xx/4xx: прокси жив, YouTube ответил не так, как мы ждали.
            // Это НЕ повод менять прокси. Если были в восстановлении — выходим из него.
            if (isRecovering) {
                console.log(EXT_NAME + '[Proxy Monitor] HTTP ' + response.status + ' — proxy is alive, stopping recovery.');
                isRecovering = false;
                recoveryStartTime = null;
                hideRecoveryNotification();
            }
        }
    } catch (error) {
        // TypeError: Failed to fetch (сеть/прокси реально недоступны)
        // AbortError: если бы мы ставили таймаут (сейчас не ставим, но на будущее)
        console.error(EXT_NAME + '[Proxy Monitor] Network fetch failed:', error);
        handleConnectionFailure();
    }
}

/**
 * Интеграция с видеоплеером YouTube.
 * Отслеживает события буферизации и остановки потока.
 *
 * ВАЖНО (добавлено при доработке):
 * Раньше setupVideoMonitoring вызывался один раз и назначал слушатели на первый
 * найденный <video>. Но YouTube — это SPA: при переходе между видео элемент
 * <video> может пересоздаваться, и слушатели теряются (т.к. страница нередко НЕ обновляется). 
 * В результате мониторинг
 * waiting/playing переставал работать до перезагрузки страницы.
 *
 * Теперь используется MutationObserver: он следит за появлением/сменой <video>
 * и перепривязывает слушатели к актуальному элементу.
 */
let observedVideo = null;

function bindVideoListeners(video) {
    if (!video || video === observedVideo) return; // Уже привязаны к этому элементу
    observedVideo = video;

    console.log(EXT_ID + ': [Proxy Monitor] Video player detected. Monitoring playback events...');

    /**
     * Событие 'waiting' срабатывает, когда воспроизведение останавливается
     * из-за того, что данные в буфере закончились.
     */
    video.addEventListener('waiting', () => {
        console.log(EXT_NAME + '[Proxy Monitor] Video is buffering (waiting event)...');

        // Запускаем таймер: если видео не заиграет в течение VIDEO_STALL_THRESHOLD,
        // считаем, что прокси не справляется с потоком.
        if (!videoStallTimer) {
            videoStallTimer = setTimeout(() => {
                console.warn(EXT_NAME + '[Proxy Monitor] Video stalled for too long. Triggering proxy change...');
                handleConnectionFailure();
            }, VIDEO_STALL_THRESHOLD);
        }
    });

    /**
     * Событие 'playing' срабатывает, когда видео снова начинает воспроизводиться.
     */
    video.addEventListener('playing', () => {
        if (videoStallTimer) {
            console.log(EXT_NAME + '[Proxy Monitor] Video resumed playing. Clearing stall timer.');
            clearTimeout(videoStallTimer);
            videoStallTimer = null;
        }
    });
}

function setupVideoMonitoring() {
    const video = document.querySelector('video');
    if (video) {
        bindVideoListeners(video);
    }

    // MutationObserver будет вызывать setupVideoMonitoring при любых изменениях DOM,
    // чтобы поймать появление нового элемента <video> после SPA-навигации.
    // Делаем это один раз — повторно observer не создаём.
    if (!window.__proxyVideoObserver) {
        const observer = new MutationObserver(() => {
            const v = document.querySelector('video');
            if (v && v !== observedVideo) {
                bindVideoListeners(v);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.__proxyVideoObserver = observer;
    }
}

// --- ЗАПУСК ---

/**
 * Реакция на события online/offline браузера.
 * Это дешёвый и точный сигнал: если браузер считает, что сети нет —
 * не нужно ждать очередного HEAD-запроса.
 */
window.addEventListener('offline', () => {
    console.warn(EXT_NAME + '[Proxy Monitor] Browser reports offline.');
    handleConnectionFailure();
});
window.addEventListener('online', () => {
    console.log(EXT_NAME + '[Proxy Monitor] Browser reports online. Will verify via periodic check.');
    // Не сбрасываем isRecovering сразу — дождёмся успешного HEAD в checkNetworkStatus.
});

// 1. Регулярная проверка сетевого соединения (раз в 30 секунд)
setInterval(checkNetworkStatus, CHECK_INTERVAL);

// 2. Запуск мониторинга событий видеоплеера
setupVideoMonitoring();

/**
 * Слушатель сообщений от background.js.
 * Позволяет фоновому скрипту управлять UI в контентном скрипте.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'PROXY_EXHAUSTED') {
        // Уведомляем пользователя через наш тост, а не через alert():
        // alert() блокирует вкладку и выглядит грубо.
        showErrorNotification('Список доступных прокси исчерпан. Соединение переведено в прямой режим.');

        // Сбрасываем состояние восстановления
        hideRecoveryNotification();
        isRecovering = false;
        recoveryStartTime = null;
    } 
    else if (message.action === 'PROXY_ERROR') {
        // Выводим временное уведомление об ошибке (например, если сервер PHP упал)
        showErrorNotification(message.message);
    }
    else if (message.action === 'PROXY_OK') {
        /*
         * background.js явно сообщает, что прокси успешно установлен и работает.
         * Сбрасываем состояние восстановления сразу, не дожидаясь HEAD-запроса
         * (который может ещё идти через старый PAC и вернуть ошибку).
         */
        console.log(EXT_NAME + '[Proxy Monitor] PROXY_OK received. Recovery finished.');
        hideRecoveryNotification();
        isRecovering = false;
        recoveryStartTime = null;
    }
    else if (message.action === 'PROXY_API_TIMEOUT') {
        /*
         * background.js сообщает, что запрос к PHP-серверу не уложился в таймаут.
         * Показываем отдельный тост с понятной причиной, чтобы пользователь
         * не гадал, почему расширение «молчит».
         */
        showErrorNotification(message.message || 'Сервер API не отвечает. Проверьте, запущен ли PHP-сервер.');
    }
});

// Добавьте функцию для создания уведомления на странице
function showErrorNotification(text) {
    // Удаляем старое уведомление, если оно есть
    const existing = document.getElementById('proxy-error-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'proxy-error-toast';
    toast.innerText = `content.js сообщает: ${text}`;
    
    // Стили для красивого уведомления в углу экрана
    Object.assign(toast.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        backgroundColor: '#ff4444',
        color: 'white',
        padding: '12px 20px',
        borderRadius: '8px',
        zIndex: '9999',
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        cursor: 'pointer',
		whiteSpace: 'pre-wrap' // Чтобы \n работал в HTML
    });

    // Закрытие уведомления по клику
    toast.onclick = () => toast.remove();

    document.body.appendChild(toast);

    // Автоматическое удаление через 10 секунд
    setTimeout(() => {
        if (toast) toast.remove();
    }, 10000);
}
