# Pi → Среда (armgs) — уведомления через skill `sreda_send`

Компоненты:

| Компонент | Роль |
|---|---|
| `extensions/sreda-messenger/` | TS-расширение пи-агента: ловит события (`agent_settled`, `input`) и вызывает skill |
| `../skills/sreda_send/` | Python-skill: сам токен (cold OAuth), отправка текста/файлов в «Среду» |

## События

| Когда | Что отправляет |
|---|---|
| `agent_settled` + «тихое окно» (агент по-настоящему «остыл», `isIdle`+очередь пуста) | Нормальное завершение (`stopReason: "stop"`): текст `Pi-агент. Сессия: <имя> / Работа завершена / <дата время>` + вложение **`message.pdf`** (финальный ответ, headless Chromium). Остановка из-за ошибки (`stopReason: "error"`): текст `... / Остановлен из-за ошибки / ...` (+ `message.pdf`, если ответ есть) |
| `agent_settled` + **есть незавершённый субагент** (netto-счёт в `hasPendingSubagent`: запущен `subagent`/`subagent_resume`, `subagent_result` ещё не прилетел) | Текст **«Работа завершена» подавляется** (агент ещё дорабатывает), но текущий ответ уходит отдельным **`message.pdf`** (только если текст не пуст). Финальное «Работа завершена» придёт после того, как субагент завершится и агент доработает |
| `input` (новое сообщение пользователя в уже не первой сессии, агент освободился) | `Pi-агент. Сессия: <имя> / возобновлена / <дата время>` |
| Субагент (pi-процесс с `PI_SUBAGENT_*`) остановился из-за ошибки | `Pi - субагент: / <имя субагента> / Сессия: / <имя сессии> / Остановлен из-за ошибки / <дата время>` (при нормальном завершении субагент молчит) |

Важные детали и защитные механизмы (MUTE, антиспам субагентов, ожидание субагента) — в
верхнеуровневом [README](../../README.md).

Расширение **не** обращается к API «Среды»:
нет https/TLS/OAuth/auth в TypeScript — всё делает `skills/sreda_send/sreda_send.py`
(там же и cold OAuth через OpenSSL, и загрузка файлов по тому же протоколу, что веб-клиент:
`files/init → upload → files/info → sendIM`).

## Настройка

`extensions/sreda-messenger/config.json`:
```json
{ "recipient": "32.klorshteinve@rosstat.gov.ru" }
```

`sreda_send/config.json` (секретный, в `.gitignore`):
```json
{
  "user": "32.SAD",
  "password": "…",
  "domain": "rosstat.gov.ru",
  "tokenDir": ""
}
```

Токены: `tokenDir/state.json` (по умолчанию `skills/sreda_send/.sreda/state.json`).

## Диагностика (лог)

Оперативные сообщения **не выводятся в TUI/сессию** — пишутся в локальный файл
`extensions/sreda-messenger/.sreda-ext.log` (в `.gitignore`, не коммитится):

- каждая строка с меткой времени (`[2026-…T…Z] …`);
- файл ограничен по размеру (~256 КБ новых данных + хвост 128 КБ), старые записи сменяются;
- ошибки не-критичного логирования не роняют отправку.

Помимо этого каждый значимый акт (отправка, задержка, MUTE-переключатель) выдаёт
короткое **уведомление в TUI** через `pi.ui.notify` (типа «Среда: message.pdf отправлено»).

Быстрый просмотр лога:
```bash
tail -30 extensions/sreda-messenger/.sreda-ext.log
```

## Установка / обновление

Репозиторий кладётся рядом, расширение и skill — по симлинку в `.pi/agent/`:

```bash
ln -s /home/pi/Sync/pi_extensions/sreda/extensions/sreda-messenger \
      ~/.pi/agent/extensions/sreda-messenger
ln -s /home/pi/Sync/pi_extensions/sreda/skills/sreda_send \
      ~/.pi/agent/skills/sreda_send
```

## Быстрая проверка

```bash
# Токен (cold OAuth):
python3 skills/sreda_send/sreda_send.py token

# Отправка с файлом:
python3 skills/sreda_send/sreda_send.py send \
    --to 32.klorshteinve \
    --text "Проверка связи" \
    --attach /tmp/some.md
```
