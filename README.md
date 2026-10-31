# Amaze Relay

Запуск (нужен Node.js 22.5 или новее):

1. `node seed.js` — один раз создаёт базу и демо-аккаунты (пароль можно задать сам: `node seed.js ПарольВодителя ПарольАдмина`).
   Если базa `flexdrive.db` уже есть, она остаётся с прежними паролями, ничего делать не нужно.
2. `node server.js` — запускает сервер, терминал не закрывать.
3. Водитель: http://localhost:3000   (driver@example.com)
4. Админка: http://localhost:3000/admin   (admin@example.com)
5. `node test.js` — автотесты.
6. `node reset-password.js email новыйПароль` — задать новый пароль любому аккаунту (пароль узнать нельзя, хранится только хеш).
7. `node add-driver.js email пароль(8+) Имя` — добавить верифицированного водителя.

Через туннель VS Code (вкладка Ports, порт 3000, Public) запускайте так:
`$env:TRUSTED_HOSTS="адрес-туннеля.devtunnels.ms"; node server.js`

Структура:
```
server.js  seed.js  add-driver.js  test.js  package.json
public/  index.html  admin.html  admin-login.html  manifest.webmanifest  sw.js  *.png
```

Регистрация и вход (страница в стиле Amazon Relay, но с брендом Amaze Relay):
- Вход по email или номеру телефона, затем пароль. Кнопка «Create your Amaze Relay account» открывает регистрацию.
- `POST /api/register` публичный: всегда создаёт водителя с статусом «не верифицирован» (роль из запроса игнорируется).
  Поля: first, last, email, phone (необязательно), password (8+), licenseNo, licenseExp (YYYY-MM-DD), acceptTerms: true.
  Лимит 10 попыток в час с одного IP, защита-приманка `website`.
- Админ верифицирует водителя в /admin; там же кнопка «Reset password».
- Старая база `flexdrive.db` обновляется сама при запуске (добавляется колонка phone_digits).
- Текст условий (Terms) в `public/index.html`, функция `showTerms`, это заглушка: замените своим.
