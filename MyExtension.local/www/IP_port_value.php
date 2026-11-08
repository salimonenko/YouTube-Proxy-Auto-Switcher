<?php
/**
 * Веб-API для выдачи прокси-серверов.
 * Совместимо с PHP 5.3
 */

// Настройки файлов
$proxy_list_file = 'proxy.txt';
$index_file = 'index.txt';

// Устанавливаем заголовок ответа: простой текст
header('Content-Type: text/plain');

// Согласно ТЗ: API принимает только POST запросы
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('HTTP/1.1 405 Method Not Allowed');
    echo "Only POST requests are allowed";
    exit;
}

// 1. Читаем текущий индекс из файла index.txt
if (!file_exists($index_file)) {
    file_put_contents($index_file, '0');
}
$currentIndex = (int)file_get_contents($index_file);

// 2. Читаем список прокси в массив
if (!file_exists($proxy_list_file)) {
    header('HTTP/1.1 500 Internal Server Error');
    echo "Proxy list file not found";
    exit;
}

// FILE_IGNORE_NEW_LINES удаляет символы переноса строки в конце каждой строки
$proxies = file($proxy_list_file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

// 3. Проверяем, не вышли ли мы за пределы списка
if ($currentIndex >= count($proxies)) {
    // Согласно ТЗ: отсутствие доступных прокси — HTTP 406
    header('HTTP/1.1 406 Not Acceptable');
    
    // Сбрасываем индекс в 0, чтобы список начался заново при следующем запросе
    file_put_contents($index_file, '0');
    
    echo "Proxy list exhausted. Resetting to start.";
    exit;
}

// 4. Получаем текущий прокси из массива
$currentProxy = $proxies[$currentIndex];

// 5. Увеличиваем индекс для следующего вызова и сохраняем его
$nextIndex = $currentIndex + 1;
file_put_contents($index_file, (string)$nextIndex);

// 6. Отдаем адрес прокси расширению
echo $currentProxy;
