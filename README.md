# KP Kanvas!!!!!!!!

A tiny friends-only browser drawing and guessing game. It has rooms, shareable links, drawing turns, guesses, scoring, and a six-player cap without accounts, ads, or a database.

## Features

- Create a room and share `/room/<code>` with friends.
- Up to 6 players per room.
- Host starts the game and can skip stuck turns.
- Drawer chooses one of three words.
- Everyone else guesses in chat.
- Fast correct guesses score more points; the drawer scores when friends guess correctly.
- In-memory rooms expire after being empty or idle.

## Run Locally

With Docker:

```sh
docker compose up --build
```

Then open `http://localhost:3000`.

To run two separate local instances for testing:

```sh
docker compose -f docker-compose.local-two-ports.yml up --build
```

Then open:

- `http://localhost:3000`
- `http://localhost:3001`

Each port is a separate in-memory server. Rooms created on port `3000` will not exist on port `3001`.

With local Node 20+:

```sh
npm install
npm start
```

To run two separate local Node instances:

```sh
PORT=3000 npm start
PORT=3001 npm start
```

Run those in two different terminal tabs.

For development:

```sh
npm run dev
```

## Test

```sh
npm install
npm test
```

## Deploy On Render

1. Push this folder to a GitHub repo.
2. Create a new Render web service from that repo.
3. Use `npm install --omit=dev` as the build command.
4. Use `npm start` as the start command.
5. Set the health check path to `/healthz`.

The app keeps rooms in memory, so use one web service instance for personal games. Restarting the service clears active rooms.

## Environment

- `PORT`: server port, default `3000`.
- `CORS_ORIGIN`: optional Socket.IO CORS origin. Leave unset for the same-origin hosted app.

## License

MIT
