# OrbStack concurrency spike: what to run, what to write down

Step 0 of `docs/superpowers/specs/2026-11-19-concurrent-task-environments-design.md`. It is by hand, on the machine that will run the factory, and it decides whether the design goes ahead (web checks) and how far it reaches (mobile checks). Nothing here changes the factory: it uses a throwaway compose project of its own, named `df-spike-1` and `df-spike-2`, so it can never touch a real `df-<key>` stack. About 15 minutes.

## Before you start

-   OrbStack is installed and `docker context show` prints `orbstack`.
-   No scheduled pass is running (`/dev-factory:scheduler off`, or wait for `dev-factory status` to show nothing in flight): the spike starts and stops containers, and the sweep must not meet them. Switch the scheduler back on afterwards.
-   For the mobile checks only: an iOS simulator booted, and an Android emulator running (skip a platform you do not have).

## The throwaway project

Save this as `/tmp/df-spike/docker-compose.yml` (it publishes no host port, on purpose):

```yaml
services:
    web:
        image: python:3.12-alpine
        command: ['python', '-m', 'http.server', '3000']
```

Start two copies of it side by side:

```
docker compose -f /tmp/df-spike/docker-compose.yml -p df-spike-1 up -d
docker compose -f /tmp/df-spike/docker-compose.yml -p df-spike-2 up -d
```

## Checks (write the result of each next to it)

Web, from the Mac. These decide whether the design goes ahead.

1.  **Name.** `curl -s -o /dev/null -w '%{http_code}\n' http://web.df-spike-1.orb.local:3000` answers `200`. If it does not, try the container's own name (`docker ps --format '{{.Names}}'`, then `http://<that name>.orb.local:3000`) and write down which form works.
2.  **IP.** `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' df-spike-1-web-1` prints an address; `curl http://<that address>:3000` answers `200` from the Mac. Stop and start the project (`docker compose -p df-spike-1 down`, then `up -d`) and write down whether the address changed.
3.  **Two at once.** Both `df-spike-1` and `df-spike-2` answer on port 3000 at the same time, each at its own name. This is the whole point.
4.  **A browser.** Open `http://web.df-spike-1.orb.local:3000` in Chrome (or ask Claude to open it with its browser tools once both projects are up) and confirm the directory listing loads. Note any certificate or "not secure" warning.
5.  **Cookies and CORS.** Write down how the real project's web app and API are configured for the address a browser uses: a `localhost:<port>` written into CORS, a cookie domain or an OAuth redirect will need the new hostname. This is a note, not a pass or fail.

Mobile, from a device. These decide section 3 of the design: skip a platform you do not have.

6.  **iOS simulator.** `xcrun simctl openurl booted http://web.df-spike-1.orb.local:3000`, then `xcrun simctl io booted screenshot /tmp/df-spike/ios.png`: the screenshot shows the directory listing, not an error page.
7.  **Android emulator.** `adb shell am start -a android.intent.action.VIEW -d http://web.df-spike-1.orb.local:3000`, then `adb exec-out screencap -p > /tmp/df-spike/android.png`: the same. If the name does not resolve, repeat with the IP from check 2 and write down which of the two works. The emulator reaches the Mac's network through the host, so the IP form is the likelier one.

## Clean up

```
docker compose -p df-spike-1 down -v
docker compose -p df-spike-2 down -v
rm -rf /tmp/df-spike
```

## What the results decide

| Result | Consequence |
| --- | --- |
| Checks 1 to 4 pass (name or IP) | The design goes ahead: `--ports direct` for web tickets |
| Check 3 fails (the second project does not answer on the same port) | Stop. Approach 2 (a random free host port per task) is designed instead |
| Checks 1 to 4 fail | Stop, as above |
| 6 passes and 7 passes | Mobile tasks can use `direct` too, with `{apiBaseUrl}` and a Metro port and a device each |
| 6 passes, 7 fails | iOS tasks run concurrently, Android one at a time |
| Both fail | Mobile stays on `canonical`, one at a time; web alone gets concurrency |

Paste the seven results into the conversation (a line each is enough), and say which name form worked in 1 and 7 (the hostname or the IP).

## What happens after, and what does not wait for the spike

The order of work in the design is the spike, then the active-run pointer fix (F10), then `--ports direct` and `environment.directHost`, then the tick change, then mobile. F10 does not depend on the spike's outcome and is the prerequisite for raising `caps.maxConcurrent` at all, so it is being investigated now: what a subagent's hook input carries that can tell two concurrent runs apart decides how it can be built.
