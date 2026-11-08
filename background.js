/**
 * background.js - Сервисный скрипт (Service Worker) расширения.
 * Основная задача: автоматизация получения прокси из API, их проверка и 
 * настройка браузера так, чтобы прокси работал ТОЛЬКО для YouTube и связанных сервисов.
 */

/* Пояснения по особенностям разработки расширений:
	chrome.proxy.settings.set: Это ключевой метод. В отличие от обычного JS, где невозможно менять настройки сети пользователя, расширение с разрешением proxy может управлять ими. Параметр mode: "fixed_servers" говорит браузеру использовать строго указанный сервер.

	fetch с mode: 'no-cors': Когда мы проверяем доступность youtube.com, нам не нужно читать содержимое страницы (что запрещено политикой CORS для сторонних запросов), нам достаточно знать, что сервер ответил. no-cors позволяет получить «непрозрачный» ответ, которого достаточно для проверки связи.

	AbortController: В стандартном fetch нет встроенного параметра timeout. Чтобы реализовать заданные 3 секунды, мы используем AbortController, который принудительно обрывает запрос по таймеру.

	chrome.tabs.sendMessage: Фоновый скрипт живет отдельно от страницы. Чтобы «сказать» пользователю на сайте YouTube, что прокси сменился или список закончился, мы отправляем сообщение из background.js в content.js.

	chrome.runtime.onMessage.addListener: Это «почтовый ящик» расширения. Когда content.js заметит тормоза видео, он отправит сообщение check_connection, и этот слушатель запустит проверку.

	return true в слушателе: В Chrome Extensions, если вызывается sendResponse асинхронно (внутри .then() или после await), мы обязаны вернуть true из основного тела функции-слушателя, иначе канал связи закроется до того, как придет ответ.*/ 

//const API_URL = 'http://example.com/proxy/IP_port_value.php';
const API_URL = 'http://myextension.local:8000/IP_port_value.php';

const CHECK_URL = 'https://www.youtube.com/';
const MAX_RETRIES = 3;       // Максимум 3 попытки проверки одного узла перед сменой на новый
const CHECK_TIMEOUT = 3000;  // 3 секунды на ожидание ответа от сервера (таймаут)

/**
 * Таймаут для запроса к API получения прокси.
 *
 * ПОЧЕМУ ОН НУЖЕН ОТДЕЛЬНО ОТ CHECK_TIMEOUT:
 * CHECK_TIMEOUT (3 с) — это проверка уже установленного прокси через YouTube.
 * А здесь речь о запросе к нашему PHP-серверу (API_URL). Если PHP «завис»
 * (не отказал в соединении, а именно не отвечает), то await fetch(API_URL)
 * может ждать десятки секунд. Всё это время цикл proxyLifecycle стоит на месте,
 * флаг isChecking остаётся true, и расширение не реагирует на сбои.
 * Поэтому для запроса к API вводим свой, более щедрый таймаут — 10 секунд.
 */
const API_TIMEOUT = 10000;

const EXT_NAME = 'Proxy Auto-Switcher for YouTube'; // Дублирование из файла manifest.json

const FETCH_FAILED = "\nПричина: ошибка связи с сервером API. Проверьте доступность сервера, с которого скрипт background.js получает прокси-серверы в виде IPaddress:port";

/**
 * Вспомогательная функция для создания паузы (сна) в асинхронных функциях.
 * @param {number} ms - Количество миллисекунд для ожидания.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let currentProxy = null;
let isChecking = false;

/**
 * Загружаем сохранённый currentProxy из chrome.storage.local при старте
 * service worker.
 *
 * Зачем: в MV3 service worker может быть остановлен браузером через ~30 с
 * бездействия и затем запущен заново. Переменные модуля при этом теряются.
 * Если мы не восстановим currentProxy, то после «просыпания» background.js
 * будет считать, что прокси не установлен (currentProxy === null), и в
 * обработчике check_connection пойдёт по ветке «сразу proxyLifecycle()»,
 * хотя прокси уже стоит и, возможно, жив.
 *
 * storage.local переживает перезапуск service worker и браузера.
 * Читаем асинхронно; до окончания чтения currentProxy остаётся null —
 * это нормально, обработчик check_connection сработает позже.
 */
chrome.storage.local.get(['currentProxy'], (result) => {
    if (result && result.currentProxy) {
        currentProxy = result.currentProxy;
        console.log(`[Storage] Восстановлен currentProxy из storage: ${currentProxy}`);
    }
});

/**
 * Функция для установки настроек прокси в браузере с использованием PAC-скрипта.

 * PAC (Proxy Auto-Config) — это механизм, который позволяет браузеру самому решать,
 * какой запрос отправить через прокси, а какой — напрямую.
 * Это реализует требование ТЗ: проксировать только YouTube и его домены.
 */
// Формируем тело PAC-скрипта. 
// Функция FindProxyForURL — стандарт для PAC. Она проверяет домен хоста.
// Если домен совпадает с YouTube или его CDN (googlevideo, ytimg и т.д.), возвращается PROXY.
// Для всех остальных сайтов возвращается DIRECT (прямое соединение).
async function setProxyConfig(host, port) {
    const pacScript = `
    function FindProxyForURL(url, hostName) {
         if (dnsDomainIs(hostName, "youtube.com") || 
             dnsDomainIs(hostName, "googlevideo.com") || 
             dnsDomainIs(hostName, "ytimg.com") || 
             dnsDomainIs(hostName, "ggpht.com") || 
             dnsDomainIs(hostName, "youtube-nocookie.com")) {
                return "PROXY ${host}:${port}";
            }
        return "DIRECT";
    }
`;

    const config = {
        mode: "pac_script",
        pacScript: {
            data: pacScript
        }
    };

    return new Promise((resolve, reject) => {
        // chrome.proxy.settings.set — специфичный API расширений для управления прокси.
        // scope: 'regular' означает, что настройки применяются к обычным вкладкам.
        // Браузер запоминает эти настройки, поэтому прокси остается активным даже после перезагрузки.
        chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
            /*
             * ВАЖНО: проверяем chrome.runtime.lastError.
             * При ошибке мы reject'им промис: proxyLifecycle попадёт в catch,
             * покажет пользователю сообщение и попробует следующий узел.
             */
            if (chrome.runtime.lastError) {
                reject(new Error('Не удалось применить PAC-скрипт: ' + chrome.runtime.lastError.message));
                return;
            }
            console.log(`[Proxy] PAC-скрипт настроен. YouTube -> ${host}:${port}, Остальное -> Direct`);
            resolve();
        });
    });
}

/**
 * Функция для сброса прокси на прямое соединение.
 * Используется, когда список прокси исчерпан (ошибка 406) или возникла критическая ошибка.
 */
async function clearProxyConfig() {
    return new Promise((resolve) => {
        chrome.proxy.settings.clear({ scope: 'regular' }, () => {
            console.log('[Proxy] Прокси отключен, переход на прямое соединение для всех ресурсов');
            resolve();
        });
    });
}

/**
 * Функция проверки работоспособности прокси через chrome.webRequest.
 *
 * ПОЧЕМУ НЕ ПРОСТО fetch:
 * Раньше проверка делалась так:
 *     const response = await fetch(CHECK_URL, { mode: 'no-cors', signal });
 *     return true;
 * С mode: 'no-cors' fetch резолвится при ЛЮБОМ ответе — даже если прокси
 * вернул 407 (Proxy Authentication Required) или 502 (Bad Gateway).
 * Браузер отдаёт opaque-ответ со status: 0, и для JS это «успех».
 * В результате «мёртвый» прокси, отвечающий ошибкой, признавался живым,
 * и расширение могло «застрять» на нём: PROXY_OK отправлялся, прокси
 * считался рабочим, а видео не грузилось.
 *
 * chrome.webRequest.onCompleted даёт реальный statusCode, а onErrorOccurred —
 * реальную ошибку сети (connection reset, timeout и т.п.). Это точнее.
 *
 * ЛОГИКА:
 *   1. Подписываемся на onCompleted и onErrorOccurred для URL CHECK_URL.
 *   2. Делаем fetch (можно оставить no-cors — статус нам больше не нужен).
 *   3. Ждём либо onCompleted (там statusCode), либо onErrorOccurred,
 *      либо таймаут CHECK_TIMEOUT.
 *   4. Если statusCode в диапазоне 200–399 — прокси жив; иначе — мёртв.
 *      Если сработал onErrorOccurred — мёртв.
 *
 * ВАЖНО: chrome.webRequest в MV3 доступен только в режиме наблюдения
 * (блокировать запросы нельзя). Разрешение webRequest у нас есть.
 */
async function checkProxyHealth() {
    return new Promise((resolve) => {
        let settled = false;

        // Таймаут на всю проверку. Если ни onCompleted, ни onErrorOccurred
        // не сработали за CHECK_TIMEOUT — считаем, что прокси мёртв.
        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            console.warn(`[Proxy] Проверка ${currentProxy}: таймаут ${CHECK_TIMEOUT} мс, считаем мёртвым`);
            resolve(false);
        }, CHECK_TIMEOUT);

        // Снимаем слушатели и таймер. Вызывается при любом исходе,
        // чтобы не оставлять «висячих» подписок на webRequest.
        function cleanup() {
            clearTimeout(timeoutId);
            try {
                chrome.webRequest.onCompleted.removeListener(onCompleted);
                chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
            } catch (e) {
                // На случай, если слушатели уже сняты — не падаем.
            }
        }

        // Запрос завершился с HTTP-статусом. Здесь мы наконец видим реальный код.
        function onCompleted(details) {
            if (settled) return;
            if (details.url !== CHECK_URL && !details.url.startsWith(CHECK_URL)) return;
            settled = true;
            cleanup();
            const code = details.statusCode;
            const ok = code >= 200 && code < 400;
            console.log(`[Proxy] Проверка ${currentProxy}: HTTP ${code} -> ${ok ? 'жив' : 'мёртв'}`);
            resolve(ok);
        }

        // Запрос завершился сетевой ошибкой (connection reset, timeout и т.п.).
        function onErrorOccurred(details) {
            if (settled) return;
            if (details.url !== CHECK_URL && !details.url.startsWith(CHECK_URL)) return;
            settled = true;
            cleanup();
            console.warn(`[Proxy] Проверка ${currentProxy}: ошибка сети "${details.error}" -> мёртв`);
            resolve(false);
        }

        chrome.webRequest.onCompleted.addListener(onCompleted, { urls: [CHECK_URL + '*'] });
        chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, { urls: [CHECK_URL + '*'] });

        // Отправляем сам запрос. Режим no-cors оставляем: статус нам не нужен,
        // мы его получим из onCompleted. Сигнал AbortController тоже не нужен —
        // таймаут уже реализован через setTimeout выше.
        fetch(CHECK_URL, { mode: 'no-cors' }).catch((error) => {
            // Если fetch упал мгновенно (до срабатывания onErrorOccurred) —
            // не считаем это отдельным исходом: onErrorOccurred сработает
            // и разрешит промис. Но на всякий случай логируем.
            console.warn(`[Proxy] fetch в checkProxyHealth упал: ${error.message}`);
        });
    });
}

/**
 * Основной цикл получения и проверки прокси (Proxy Lifecycle).
 * Реализует логику: Запрос к API -> Установка -> Проверка (3 попытки) -> Повтор при неудаче.
 */
async function proxyLifecycle() {
    if (isChecking) return; // Защита от одновременного запуска нескольких циклов обновления
    isChecking = true;

    /*
     * ВНЕШНИЙ try/finally ВОКРУГ while (true).
     *
     * Зачем это нужно, если внутри уже есть try/catch:
     *   - Внутренний try/catch ловит ошибки, возникшие в теле цикла, и продолжает цикл.
     *   - Но если исключение возникнет В САМОМ catch (например, notifyContentScript
     *     кинет ошибку, или sleep прервётся остановкой service worker), управление
     *     выйдет из цикла наружу. Без finally строка isChecking = false не выполнится,
     *     флаг останется true — и расширение «залипнет»: больше не сможет
     *     запустить proxyLifecycle до перезапуска.
     *   - Аналогично, если исключение возникнет между break и концом цикла.
     *
     * finally гарантирует, что isChecking = false выполнится при ЛЮБОМ выходе:
     * по break, по return, по throw, по throw из catch.
     * Это дешёвая страховка от «залипания» расширения.
     */
    try {
        while (true) {
            try {
                // 1. Запрашиваем новый прокси через HTTP POST запрос к API.
                console.log('[API] Запрос нового прокси...');

                /*
                 * AbortController для запроса к API.
                 *
                 * Раньше fetch(API_URL, { method: 'POST' }) вызывался без таймаута.
                 * Если PHP-сервер завис (не отказал, а именно не отвечает), await fetch
                 * мог ждать очень долго. Цикл стоял бы на этой строке, isChecking
                 * оставался бы true, и пользователь не получил бы ни нового прокси,
                 * ни внятного сообщения об ошибке.
                 *
                 * Теперь через API_TIMEOUT (10 с) мы принудительно прерываем запрос
                 * и уходим в catch, где отправим в content.js отдельное сообщение
                 * PROXY_API_TIMEOUT — чтобы пользователь увидел понятную причину.
                 */
                const apiController = new AbortController();
                const apiTimeoutId = setTimeout(() => apiController.abort(), API_TIMEOUT);

                let response;
                try {
                    response = await fetch(API_URL, {
                        method: 'POST',
                        signal: apiController.signal
                    });
                } catch (fetchError) {
                    // Различаем два вида ошибки:
                    //   - AbortError: сработал наш таймаут (PHP завис);
                    //   - прочие ошибки (Failed to fetch): сервер недоступен, DNS не разрешился и т.п.
                    if (fetchError.name === 'AbortError') {
                        const timeoutMsg = `Сервер API не отвечает (таймаут ${API_TIMEOUT / 1000} с). Проверьте, запущен ли PHP-сервер по адресу ${API_URL}.`;
                        console.warn('[API] ' + timeoutMsg);
                        notifyContentScript('PROXY_API_TIMEOUT', timeoutMsg);
                    }
                    // Пробрасываем ошибку дальше — её обработает внешний catch,
                    // который сделает паузу и попробует снова.
                    throw fetchError;
                } finally {
                    // В любом случае очищаем таймер, чтобы он не сработал после успешного ответа.
                    clearTimeout(apiTimeoutId);
                }

/* await fetch приостанавливает выполнение функции до тех пор, пока сервер не пришлет ответ или пока не произойдет ошибка.
Однако, есть критическая разница между тем, когда сервер отвечает (даже ошибкой) и тем, когда происходит Failed to fetch.
1. Сценарий «Медленный сервер» (Запрос ждет, все нормально)
	Если сервер РАБОТАЕТ, но тормозит, await fetch действительно будет ждать ответа. В этом случае «шторма» нет, так как цикл замирает на строке с fetch.
2. Сценарий «Мгновенный отказ» (Причина возможного шторма, если не делать пауз)
	Ошибка Failed to fetch часто происходит мгновенно. Она возникает еще до того, как запрос фактически «ушел» в сеть или получил ответ. Это случается, если:
		Сервер полностью выключен (Connection Refused).
		Браузер заблокировал запрос из-за внутренних ограничений.
		DNS-имя не разрешилось.
	В этих случаях await fetch НЕ «ЖДЕТ» ОТВЕТА СЕРВЕРА (потому что ответа быть не может), а мгновенно выбрасывает исключение (throw error), и цикл перейдет в catch {... }.
*/			

                // Если список исчерпан, сервер возвращает HTTP 406.
                if (response.status === 406) {
                    console.warn('[API] Список прокси исчерпан (406). Сброс настроек.');
                    await clearProxyConfig();
                    currentProxy = null;
                    // Стираем сохранённый прокси из storage — его больше нет.
                    chrome.storage.local.remove(['currentProxy']);

                    // Сообщаем content.js, что список кончился, чтобы вывести уведомление пользователю.
                    notifyContentScript('PROXY_EXHAUSTED');

                    // Прекращаем цикл, чтобы не зациклить запросы к API, пока список пуст.
                    break; 
                }

                // 1. Ожидаем ответ в формате plain text: "IP:port"
                const proxyString = await response.text(); 
                currentProxy = proxyString.trim();
                const [host, port] = currentProxy.split(':');

                if (!host || !port) {
                    throw new Error('Некорректный формат IP:port получен от сервера API');
                }

                // 2. Применяем полученный прокси к браузеру через PAC-скрипт.
                await setProxyConfig(host, port);

                // 3. Проверяем работоспособность узла до 3-х раз (MAX_RETRIES).
                let success = false;
                for (let i = 1; i <= MAX_RETRIES; i++) {
                    console.log(`[Proxy] Попытка проверки ${i}/${MAX_RETRIES} для ${currentProxy}...`);
                    if (await checkProxyHealth()) {
                        console.log(`[Proxy] Узел ${currentProxy} работоспособен!`);
                        success = true;
                        break;
                    }
                    // Между попытками паузы нет, так как ожидание fetch (3 сек) и есть интервал.
                }

                if (success) {
                    /*
                     * Явно сообщаем content.js, что прокси успешно установлен и работает.
                     *
                     * Раньше content.js узнавал об успехе только косвенно — через
                     * checkNetworkStatus(), который делает HEAD-запрос к YouTube.
                     * Но этот HEAD идёт через ТОТ ЖЕ PAC, который только что сменился.
                     * Если PAC применился не мгновенно, первый HEAD мог ещё идти
                     * через старый (мёртвый) прокси и вернуть ошибку — тогда
                     * isRecovering в content.js не сбрасывался, и уведомление
                     * «Пробуем сменить прокси...» висело, хотя прокси уже рабочий.
                     *
                     * Теперь background.js явно говорит «PROXY_OK» — и content.js
                     * сбрасывает состояние восстановления сразу, не дожидаясь HEAD.
                     */
                    notifyContentScript('PROXY_OK');

                    // Сохраняем рабочий прокси в storage, чтобы пережить
                    // «усыпление» service worker и перезапуск браузера.
                    chrome.storage.local.set({ currentProxy: currentProxy });
                    console.log(`[Storage] currentProxy сохранён: ${currentProxy}`);

                    return; // Выходим из функции: рабочий прокси найден и установлен.
                }

                console.log(`[Proxy] Узел ${currentProxy} не прошел проверку после ${MAX_RETRIES} попыток. Пробуем следующий...`);

                // После успешной настройки прокси можно сделать небольшую паузу, чтобы не нагружать систему, если вдруг что-то пойдет не так
                await sleep(1000); 

            } catch (error) {
                const errorMsg = 'Ошибка в основном цикле прокси: ' + error.message + FETCH_FAILED;
                console.error(`[Error] ${errorMsg}`);

                // Отправляем сообщение на страницу YouTube
                notifyContentScript('PROXY_ERROR', errorMsg);

                // КРИТИЧЕСКИ ВАЖНО: Пауза перед следующей попыткой при ошибке! Если сервер упал (или запросы к нему блокирует брандмауэр, или произошла сетевая ошибка), т.е. когда ответ-ошибка УЖЕ ИЗВЕСТЕН, он поступает практически мгновенно; и нет смысла делать запросы к серверу множество раз в секунду.
                // Поэтому ждем 2 секунды перед следующей попыткой.
                await sleep(2000); 
            }
        }
    } finally {
        // Сбрасываем флаг при любом выходе из цикла: break, return, throw.
        // Это гарантия, что расширение не «залипнет» в состоянии isChecking = true.
        isChecking = false;
    }
}

/**
 * Функция отправки сообщения во вкладки YouTube (в content.js).
 * Используется для уведомления пользователя через UI страницы.
 *
 * Раньше сообщение уходило ТОЛЬКО в активную вкладку текущего окна.
 * Это работало не всегда: если пользователь в момент сбоя переключился
 * на другую вкладку (не YouTube), уведомление уходило не туда, а вкладка
 * с YouTube его не получала. Теперь мы явно ищем все вкладки YouTube
 * и шлём сообщение в каждую из них.
 */
function notifyContentScript(type, message = '') {
    chrome.tabs.query({ url: "https://www.youtube.com/*" }, (tabs) => {
        if (chrome.runtime.lastError) {
            console.log(EXT_NAME + ' [Background.js] chrome.tabs.query error: ' + chrome.runtime.lastError.message);
            return;
        }
        if (!tabs || tabs.length === 0) {
            console.log(EXT_NAME + ' [Background.js] Вкладок YouTube не найдено. Сообщение "' + type + '" не отправлено.');
            return;
        }
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { action: type, message: message }, (response) => {
                if (chrome.runtime.lastError) {
                    // «Receiving end does not exist» — нормальная ситуация, если content.js
                    // ещё не загрузился во вкладке или вкладка в процессе навигации.
                    console.log(EXT_NAME + ' [Background.js] Вкладка ' + tab.id + ': получатель сообщения не найден (' + chrome.runtime.lastError.message + ').');
                }
            });
        }
    });
}

/**
 * Слушатель сообщений от content.js.
 * Когда content.js обнаруживает, что видео «зависло» (ошибка HEAD запроса), 
 * он присылает сигнал 'check_connection'.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'check_connection') {
        console.log('[Background] Получен сигнал о торможении видео. Проверяем текущий прокси...');

        /*
         * Если текущий прокси ещё не установлен (currentProxy === null),
         * проверять нечего: checkProxyHealth() пойдёт через DIRECT
         * (PAC ещё не применён) и вернёт true, потому что YouTube доступен
         * напрямую. В результате proxyLifecycle() не запустится, и прокси
         * не установится — а пользователь так и останется без прокси.
         *
         * Поэтому при currentProxy === null сразу запускаем поиск нового прокси.
         *
         * ВАЖНО: currentProxy может быть null не только при первом запуске,
         * но и сразу после «просыпания» service worker, пока асинхронное
         * чтение из chrome.storage.local ещё не завершилось. Это нормально:
         * в худшем случае мы запустим proxyLifecycle чуть раньше, чем
         * восстановится currentProxy, и просто получим новый прокси.
         */
        if (currentProxy === null) {
            console.log('[Background] Текущий прокси не установлен. Запускаем поиск нового...');
            sendResponse({ status: 'fail' });
            proxyLifecycle();
            return true;
        }

        // Сначала проверяем текущий прокси один раз, чтобы понять, в нем ли проблема.
        checkProxyHealth().then(async (isOk) => {
            if (isOk) {
                console.log('[Background] Текущий прокси всё еще работает. Возможно, проблема на стороне YouTube.');
                sendResponse({ status: 'ok' });
            } else {
                console.log('[Background] Текущий прокси упал. Запускаем поиск нового...');
                sendResponse({ status: 'fail' });
                // Запускаем цикл замены прокси.
                await proxyLifecycle();
            }
        });
        return true; // Важно вернуть true, чтобы sendResponse мог быть вызван асинхронно.
    }
});

/**
 * Обработчики событий запуска расширения.
 * Гарантируют, что прокси будет настроен сразу после установки или при старте браузера.
 */
chrome.runtime.onInstalled.addListener(() => {
    console.log('[System] Расширение установлено. Запуск первого цикла прокси...');
    proxyLifecycle();
});

chrome.runtime.onStartup.addListener(() => {
    console.log('[System] Браузер запущен. Проверяем актуальность прокси...');
    proxyLifecycle();
});
 