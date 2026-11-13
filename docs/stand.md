# Стенд для пилота на Яндекс Облаке

Одна виртуальная машина в российском регионе: Postgres, LRS, шлюз и Caddy с HTTPS. Файлы домашки лежат в Yandex Object Storage. Всё описано в `deploy/stand/compose.yaml`; этот текст — что нужно сделать один раз руками.

## 1. Что создать в консоли Яндекс Облака

1. **Виртуальная машина.** Compute Cloud → Создать ВМ: зона `ru-central1-a`, образ Ubuntu 24.04 LTS, 2 vCPU, 4 ГБ памяти, диск 30 ГБ SSD. Публичный адрес — **статический** (Virtual Private Cloud → IP-адреса → зарезервировать, потом привязать к ВМ). Доступ — по SSH-ключу.
2. **Группа безопасности** ВМ: входящие 22 (только ваш IP, если можно), 80 и 443 (TCP) и 443 (UDP, для HTTP/3). Порт 8080 наружу не открывать.
3. **DNS.** У регистратора домена школы — A-запись, например `app.школа.ru` → статический IP ВМ. Подождите, пока она начнёт отвечать: `dig +short app.example.ru`.
4. **Бакет.** Object Storage → Создать бакет: доступ на чтение и к списку объектов — **закрытый**, класс — стандартный. Имя бакета понадобится в `.env`.
5. **Сервисный аккаунт** для шлюза: IAM → Сервисные аккаунты → создать с ролью `storage.editor` на каталог (или только на бакет в его ACL). Затем в аккаунте «Создать новый ключ → Статический ключ доступа»: идентификатор и секрет показываются один раз.

## 2. Первый запуск

На ВМ:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && exit   # перезайти по SSH
git clone https://github.com/ilyalob0v/moonbridge.git && cd moonbridge
cp deploy/stand/.env.example deploy/stand/.env
nano deploy/stand/.env
```

В `.env`:

- `DOMAIN` — адрес из A-записи, без `https://`.
- `XAPI_BASE_IRI` — домен школы, например `https://школа.ru`. Попадает во все записи о прогрессе; **после первых ответов учеников не менять.**
- `SESSION_SECRET`, `ADMIN_TOKEN`, `POSTGRES_PASSWORD`, `LRS_SECRET`, `LRS_ADMIN_PASSWORD` — каждый по отдельности из `openssl rand -hex 32`.
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` — бакет и статический ключ из шага 1.
- `POSTBOX_ACCESS_KEY_ID`, `POSTBOX_SECRET_ACCESS_KEY`, `MAIL_FROM` — письма ученикам (напоминания и сброс пароля). Как завести Postbox и какие записи добавить в DNS (SPF, DKIM): [email.md](email.md). Можно оставить пустыми: тогда письма видны только в логе шлюза.
- `CONSENT` — по умолчанию включено: при регистрации ученик принимает документы школы из `content/school/pages`, а за ученика младше 18 лет согласие даёт родитель (письмом или на бумаге, отметку ставит преподаватель). `CONSENT=off` выключает согласия, только для проверок. Подробнее: [ADR 0016](adr/0016-school-texts-consents-tests.md). Перед пилотом: тексты документов от юриста и уведомление Роскомнадзора об обработке персональных данных.

`LTI_PRIVATE_KEY` и `LTI_PLATFORMS` не нужны: LTI заморожен.

```bash
docker compose -f deploy/stand/compose.yaml --env-file deploy/stand/.env up -d --build
docker compose -f deploy/stand/compose.yaml --env-file deploy/stand/.env logs -f gateway
```

В логе шлюза должны быть строки про Postgres и `homework files: bucket <бакет>`. Caddy сам получит сертификат за минуту; проверка: `curl https://app.example.ru/api/health`.

## 3. Аккаунт преподавателя

Учеников приглашает преподаватель из кабинета; самого преподавателя создаёт админ-ключ:

```bash
curl -X POST https://app.example.ru/api/admin/teachers \
  -H "Authorization: Bearer <ADMIN_TOKEN из .env>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ксения","login":"ksenia","password":"придумайте-пароль","email":"ksenia@school.ru"}'
```

Почта обязательна: на неё придёт письмо «Подтвердите почту», без подтверждения (когда настроен Postbox) платформа не пустит. Подробнее — [email.md](email.md).

Ответ `201` — можно входить на `https://app.example.ru`. В кабинете «Контент курса» Ксения скачивает таблицу, правит её в Google Таблицах и публикует сама (см. «Курс в таблице» в README).

## 4. Обновление

```bash
cd moonbridge && git pull
docker compose -f deploy/stand/compose.yaml --env-file deploy/stand/.env up -d --build
```

Миграции базы применяются при старте шлюза. Контент, опубликованный из таблицы, хранится в базе и переживает обновление; если в репозитории появился новый юнит, он виден ученикам, пока его не уберут из таблицы.

## 5. Резервные копии

- **Снимки диска.** Compute Cloud → Снимки дисков → Расписание: каждый день, хранить 7. Восстановление — новая ВМ из снимка.
- **Дамп базы** — дополнительно, раз в сутки по cron:

  ```bash
  docker compose -f deploy/stand/compose.yaml --env-file deploy/stand/.env exec -T postgres \
    pg_dumpall -U moonbridge | gzip > ~/backup/moonbridge-$(date +%F).sql.gz
  ```

  Копии стоит уносить с ВМ (например, в отдельный бакет).
- Файлы учеников уже в Object Storage; при желании включите в бакете версионирование.

## 6. Админка LRS

LRS наружу не открыт. Через SSH-туннель:

```bash
ssh -L 8080:127.0.0.1:8080 user@<IP ВМ>
```

и в браузере `http://localhost:8080` (логин `admin`, пароль `LRS_ADMIN_PASSWORD`).

## 7. Персональные данные (152-ФЗ)

- Все данные учеников — в России: ВМ и бакет в `ru-central1`.
- Шлюз хранит имя, логин, хэш пароля, ответы и файлы; почту и телефоны не собирает.
- До начала пилота нужны: согласие родителей на обработку данных несовершеннолетних, политика обработки ПДн на сайте школы и уведомление в Роскомнадзор об обработке ПДн (если школа его ещё не подавала).
- Доступ к ВМ — только по ключу, `.env` не коммитить и не пересылать в мессенджерах.
