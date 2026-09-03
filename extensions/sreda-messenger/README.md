# Pi → Среда (armgs) — уведомления через skill `sreda_send`

Компоненты:

| Компонент | Роль |
|---|---|
| `extensions/sreda-messenger/` | TS-расширение пи-агента: ловит события (`agent_settled`, `session_start(resume)`, `session_shutdown`) и вызывает skill |
| `../skills/sreda_send/` | Python-skill: сам токен (cold OAuth), отправка текста/файлов в «Среду» |

## События

| Когда | Что отправляет |
|---|---|
| `agent_settled` (агент прекратил работу) | `Пи-агент: Работа завершена — <дата время>` **+ временный `.md` с финальным ответом агента** (удаляется после отправки) |
| `session_start(reason=resume)` | `Пи-агент: Работа возобновлена — <дата время>` |
| `session_shutdown(quit)` (агент был kill-нут, settled не успел) | `Пи-агент: Работа завершена (прервана) — <дата время>` + `.md` с последним ответом, если есть |

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
