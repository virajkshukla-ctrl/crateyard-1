# Crateyard

A 3D team shooter that runs in the browser and as Android and iOS apps. Players log in with any username and password, add friends, and play 1v1 to 3v3 online, or practice against bots without an account.

```
client/    the game (one HTML page), web app manifest, icons, privacy policy
server/    Node.js server: accounts, friends, stats, real-time matches over WebSocket
scripts/   build-app.mjs copies the game into www/ for the store apps
```

## 1. Run it on your computer

```bash
npm install
npm run dev
```

Open http://localhost:8080. Without `DATABASE_URL` the server keeps accounts in memory, so they reset when it restarts. That is fine for testing. To try online play, open the page in two browsers (or one normal and one private window), create two accounts, and join the same match code.

## 2. Add a real database (Supabase)

1. Create a project at supabase.com.
2. Go to **Project Settings → Database → Connection string**, pick **Session pooler**, and copy the URI. Put your database password into it.
3. Set it as `DATABASE_URL` (in a `.env` you export, or in your host's settings).

The server creates its three tables (`cy_users`, `cy_sessions`, `cy_friends`) on first start. Passwords are stored as bcrypt hashes.

For a local Postgres without SSL, also set `PGSSL=disable`.

## 3. Put it online (Render)

1. Push this folder to a GitHub repo.
2. On render.com choose **New → Blueprint** and pick the repo. It reads `render.yaml`.
3. Set `DATABASE_URL` when asked.
4. When it is live, `https://<your-app>.onrender.com/api/health` should show `"store":"postgres"`.

`render.yaml` uses the Starter plan in Singapore (closest to India). The free plan works too, but it sleeps after 15 minutes idle, which drops everyone from their matches and makes the first visit slow. Any host that runs Node and allows WebSockets works (Railway, Fly.io, a VPS); there is also a `Dockerfile`.

The website is now public. Phones can install it from the browser menu (**Add to Home Screen**), and it opens fullscreen in landscape.

## 4. Build the Play Store and App Store apps

The store apps are the same game wrapped with Capacitor. They talk to your deployed server.

```bash
npm install                      # includes Capacitor
SERVER_URL=https://<your-app>.onrender.com npm run build:app
npx cap add android              # first time only
npx cap add ios                  # first time only, needs a Mac with Xcode
npx cap sync
npx cap open android             # builds in Android Studio
npx cap open ios                 # builds in Xcode
```

Run `npm run cap:sync` (with `SERVER_URL` set) every time you change the game.

**Lock the apps to landscape:**
- Android: in `android/app/src/main/AndroidManifest.xml`, add `android:screenOrientation="sensorLandscape"` to the `<activity>` tag.
- iOS: in Xcode, select the App target → **General → Deployment Info**, and tick only **Landscape Left** and **Landscape Right**.

**App icons:** `client/icons/icon-1024.png` is the store icon. In Android Studio use **File → New → Image Asset**; in Xcode drop it into `Assets.xcassets/AppIcon`.

## 5. Store checklist

| | Google Play | Apple App Store |
|---|---|---|
| Developer account | $25 one time | $99 per year |
| Privacy policy URL | `https://<your-app>.onrender.com/privacy.html` | same |
| Account deletion | Built in (menu → Delete account). Play also asks for a web link: use the privacy page, which explains it. | Built in, which Apple requires for apps with sign-up |
| Content rating | Fill the IARC questionnaire: cartoon violence, no blood, no chat | Age rating questionnaire, same answers |
| Screenshots | Phone landscape screenshots of a match | Same, at the sizes Xcode asks for |

Before you submit:
- Replace `support@your-domain.com` in `client/privacy.html` with your real support email.
- Change `appId` in `capacitor.config.json` if you want a different package name. It cannot change after the first upload.
- Apple sometimes rejects apps that are only a website in a wrapper. Crateyard ships all game files inside the app and uses the server only for accounts and matches, which is the normal setup for online games, so it should pass. If a reviewer asks, point out the offline bot mode.

## How online play works

- Accounts: `POST /api/signup` and `/api/login` return a token the game keeps on the device. No email is collected. Passwords cannot be recovered, and the login screen says so.
- Matches: the game opens a WebSocket at `/ws`. **Quick play** puts you in the fullest open public match. **Private match** gives a 4-letter code to share. Friends can also invite you, and you can jump into a friend's private match from your friends list.
- Each player sends their position 20 times a second; the server sends everyone a snapshot 20 times a second. The shooter decides hits, the server checks both players are alive and on different teams, and the server keeps the score and declares the winner. Up to 6 players per match (3v3). Wins, kills and deaths are saved to the account at the end of each match.
- Phones get the joystick and buttons automatically, PCs get mouse and keys, and anyone can switch in the menu.

## Known limits

- The server trusts each player's own hit reports, which is fine with friends but can be cheated by someone who edits the game. Moving hit checks to the server is the next step if the game grows.
- One server instance holds all matches in memory. That handles a few hundred players. Beyond that, matches need to be spread across several servers.
