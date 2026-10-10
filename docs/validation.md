# Codespaces recovery verification

Current default Telegram language is **English**, with emoji, exact `0.35%` formatting and configurable IANA timezone (default Europe/Istanbul). Earlier Turkish-message records below describe the previous implementation and are superseded.

The observed HOME error is reproduced locally by mounting an empty root-owned `/home` over the image's home directory. A dedicated node-owned home volume fixes this even with a read-only parent home mount. Actual Dev Containers CLI 0.89.0 exercises initialization, automatic `npm ci` and both builds, the one-shot restricted ownership bootstrap, PostgreSQL migrations 001–003, VS Code first-run notice write and repeat/resume. A host-created runtime is deliberately owned by UID 2000; node UID 1000 reads it after repair with unchanged DB-secret SHA256. No Codespaces port API is mocked in this lifecycle check; postStart is replaced by ownership validation because no real Codespaces context is available. Actual preview startup without that context must fail closed. A separate in-container smoke runs the real production API, built frontend and worker against the disposable database with an example.com origin and no forwarded port: Secure login/logout, Steps monitor creation/Check-now queue, history/0.35%, private before/after/diff artifacts and SSRF rejection are verified. All fixtures are paused; no public website capture or provider delivery occurs.

The application remains non-root. A bounded networkless root bootstrap has only private runtime/home mounts and CHOWN/FOWNER/DAC_OVERRIDE capabilities, and never accesses or resets PostgreSQL. Database volume and existing runtime credential bytes survive rebuild.

Automated totals: **102 tests** (41 backend + 27 PostgreSQL/browser + 20 frontend + 12 preview + 2 privacy), with no skips. Additional real CLI/Docker lifecycle and sandbox checks are reported separately rather than counted as unit tests. Both dependency audits cover development dependencies. Source/build/history privacy scans and original MIT/migration checksums are preserved.

The user's real Codespace is not visible to this task's GitHub integration; repository Codespaces API returns HTTP 403. Local lifecycle success and CI cannot prove actual private GitHub gateway, Recovery Mode exit or iPhone Safari success. Recovery requires GUI Pull on the existing branch followed by Codespaces: Rebuild Container; no deletion or terminal debugging is required.

Intermediate local PostgreSQL/Docker attempts failed when Cloud disk filled. Only this project's superseded images/cache and disposable test resources were removed; mandatory checks are rerun after disk recovery. No user Codespace, production data or unrelated container/volume is touched.

---

# Private preview ve Telegram doğrulaması

2026-10-10, izole Codex Cloud. Güncel toplam **100 test**: 41 backend unit/security/provider, 27 PostgreSQL/gerçek Chromium integration, 20 React ve 12 preview/privacy script testi. Sıfır başarısız/atlanmış/iptal edilmiş test. İki production build ve iki tam dependency audit geçti; audit sonuçları sıfır bildirilen zafiyet.

API, UI ve Codespaces development image build'leri geçti. Rootless production image testinde CPU/RAM/PID cgroup sınırları, CSS/XPath Browser Steps, üç capture modu ve Seccomp-BPF sandbox doğrulandı. Ayrı Codespaces image sandbox smoke da geçti.

Yerel, yalnızca bu projeye ait disposable Compose yığınında PostgreSQL 16.13 + migration 001/002/003 + production-mode API/React + worker gerçekten başlatıldı. Private-port API yanıtı bu yerel testte kontrollü mock'tu; hiçbir port internete açılmadı. Gerçek app login/logout, Secure/HttpOnly/Strict cookie, monitör/Steps oluşturma, Check-now kuyruğu, private-IP reddi, sentetik NUMERIC 0.35 geçmişi ve authenticated before/after/diff PNG erişimi kontrol edildi. Website capture veya gerçek provider delivery başlatılmadı. Supervisor/worker SIGTERM kapanışı exit 0 verdi; yalnızca bu testin container/network/volume'u kaldırıldı.

Bu çalışmada bulunan ve düzeltilen kusurlar: hidden `.preview/data` altında screenshot sunumunun başarısız olması (owner-authorized canonical artifact root ile düzeltildi), Telegram/SMTP edit işlemlerine yanlış provider credential alanı eklenmesi ve ham DNS resolver hatalarının genel 500'e dönüşmesi. Regresyon testleri hidden artifact root, credential koruma ve güvenli DNS hata mesajını kapsar.

Cloud'un 32 GiB diski eski uygulama Docker katmanlarıyla dolunca build ve testler ENOSPC ile başarısız oldu. Yalnızca tanımlanmış, kullanılmayan Changd Fusion image/cache kayıtları temizlendi; mevcut DB volume'larına ve diğer container'lara dokunulmadı. Son build/testler yeniden geçti. İç içe Cloud Docker ağında dış DNS `EAI_AGAIN` verdi; kuyruk smoke testi website isteği yapmadan public-address fixture ile çalıştırıldı. SSRF veya sandbox kontrolleri gevşetilmedi.

Gerçek GitHub Codespace, private HTTPS gateway ve iPhone Safari doğrulaması için GitHub Codespaces oluşturma yetkisi gerekir. Yerel mock ve Chromium mobile testleri gerçek Safari/GitHub authentication doğrulaması olarak sunulmaz. Güncel CI ve Codespace oluşturma sonucuna Draft PR #1'den ulaşılabilir. Kurulum ve sınırlamalar: [private-preview.md](private-preview.md).

Kod commit'i `1b664f0aee4807298056df58ae01dea0d5cba5e6` için [PR CI 38049709567](https://github.com/mkaand/changd-fusion/actions/runs/38049709567) ve [push CI 38049707064](https://github.com/mkaand/changd-fusion/actions/runs/38049707064) **completed / success** oldu: verify, privacy ve docker tamamlandı. CI loglarında 100 test, sıfır skip/cancel ve tamamlanan source/build/history privacy taramaları doğrulandı.

Gerçek Codespace oluşturma POST isteği **HTTP 403 — Resource not accessible by integration** ile reddedildi. Codespace oluşturulmadı; kullanıcı [GitHub üzerinden geliştirme dalını başlatmalıdır](https://codespaces.new/mkaand/changd-fusion/tree/feat/changd-fusion-sprint-1). Dynamic HTTPS/private gateway ve gerçek iPhone Safari doğrulaması bu yetki engeli nedeniyle yapılmadı. Bot token/Chat ID sağlanmadı ve gerçek Telegram/SMTP mesajı gönderilmedi.

## Sprint 2 validation (önceki temel)

Executed on 2026-10-10 in isolated Codex Cloud with synthetic accounts, controlled local endpoints and disposable PostgreSQL databases. No production system or real provider credential was used.

| Check | Result |
| --- | --- |
| Backend TypeScript production build | Passed |
| Frontend TypeScript + Vite production build | Passed; largest JS chunk about 452 KB, no large-chunk warning |
| Backend unit/security/provider/coordination/workflow tests | 30 passed, zero failures/skips |
| PostgreSQL integration and real Chromium browser tests | 24 passed, zero failures/skips |
| Frontend login, precision, comparison, history, steps, delivery/theme/API tests | 18 passed, zero failures/skips |
| Privacy scanner regression tests | 2 passed, zero failures/skips |
| Full npm audits, both packages including development dependencies | Zero reported vulnerabilities at validation time |
| Source/build tree and new commit-history privacy scan | Passed within scanner scope, with manual domain/infrastructure review |
| API and UI Docker production builds | Passed |
| Compose configuration validation | Passed |
| Docker UID / CPU / RAM / PID cgroup limits | UID 1000; 1 CPU, 1 GiB, 256 PIDs verified |
| Docker sandbox and capture-mode smoke | Browser Steps and CSS/XPath viewport/full-page/element hybrid captures passed; Chromium reported Seccomp-BPF sandbox enabled |
| Docker migration / worker shutdown | Migration 003 applied on disposable DB; idle worker established DB coordination and exited 0 on SIGTERM |
| Complete current Compose startup in Cloud | Not completed: concurrent image/container allocation exceeded this 32 GiB Cloud disk; components tested sequentially |
| Original MIT license and migrations 001/002 | Unchanged |
| Real SMTP / Telegram delivery | Not attempted; mocked providers/outbox tested |

GitHub verification runs the same suites using the bundled Playwright Chromium on a pinned Ubuntu 22.04 runner. Check draft PR #1 for the final-head workflow status; a cancelled, partial or diagnostic run is not a passing validation. Sprint 2 implementation run [38034723359](https://github.com/mkaand/changd-fusion/actions/runs/38034723359) and push run [38034720087](https://github.com/mkaand/changd-fusion/actions/runs/38034720087) completed successfully with verify/privacy/docker jobs. The PR and final report link the latest final-head run after this documentation update. The previous Sprint 1.1 baseline was [38031604802](https://github.com/mkaand/changd-fusion/actions/runs/38031604802), with 46 passing tests. Sprint 2 expands this to **74 passing tests**, zero skipped/cancelled/failed tests, plus Docker smoke checks.

## CI incident and repair

Original run [38005493269](https://github.com/mkaand/changd-fusion/actions/runs/38005493269) reported two immediate browser-test failures but never emitted the final failure details. The spec reporter buffered those details until suite completion. The UI fixture launched Chromium outside `try/finally`; launch failure left the API/UI HTTP servers listening, so the Node test process could not exit. With no shorter test/job limits, GitHub cancelled it at its default six-hour maximum, before the privacy step.

A bounded reproduction using the same browser version on Ubuntu 24.04 produced `No usable sandbox`, explicitly identifying AppArmor user-namespace restrictions. The Ubuntu 22.04 verification job passed with `chromiumSandbox: true`. The temporary diagnostic job was then removed. No sandbox fallback, global AppArmor disablement or permissive sysctl was introduced.

Tests now register fixture cleanup during setup and use `try/finally` for browsers, proxy sockets, gates and disposable databases. Active HTTP connections are closed. TAP emits failure details immediately. Individual integration tests have 90-second deadlines, the process-group watchdog has an 8-minute deadline with forced cleanup, the integration step has 10 minutes, and the verification job has 20 minutes. An independent three-minute privacy job scans source and new history even if installs/browser tests fail; build artifacts are also scanned with `if: always()` in verification.

## Behavior verified

- The exact `0.35%` path remains comparison → PostgreSQL NUMERIC → authenticated API → browser display → mocked notification. Zero, tiny, equality and genuine 100% comparisons remain covered; the rule is still strictly greater than the threshold.
- Dimension mismatches store `null` percentage, explicit old/new sizes and both images. They produce one structural combined event/outbox entry, advance the baseline once and do not repeat for the next unchanged capture. Notification templates explain the condition rather than inventing a percentage.
- Viewport/full-page/element capture extracts text and image from the same page. Oversized pages, missing selectors, launch failures and navigation timeouts fail safely, preserve baseline/latest references and clean up browser/proxy/fixture resources.
- Migration testing reconstructs an already-applied Sprint 1 migration/checksum with a baseline/latest capture and decimal value, then preserves applied migrations 001+002 and applies migration 003 repeatedly without changing those references. Original legacy history/artifact references also survive.
- Worker concurrency, same-monitor advisory locks, shutdown admission, outbox retry/restart uniqueness, and failed database-unlock cleanup are covered. Uncertain unlocks destroy the session rather than return a potentially locked connection to the pool.
- Ownership, JWT/admin authority, mutation origin/header, disabled registration, SSRF/private IP/DNS/redirect/subresource restrictions, TLS validation, encryption and artifact path containment remain covered.
- Browser smoke checks login, 0.35% history, slider keyboard interaction, mobile page bounds, dimension presentation and capture settings. Synthetic dashboard/history/dimension/settings screenshots are retained only in ignored local test output when `UI_SCREENSHOT_DIR` is set.

Intermediate defects found and repaired during this sprint include the missing jsdom ResizeObserver fixture, inaccurate deletion-status assumptions in new tests, and an aggressive Ant Design vendor split that caused a runtime initialization error. The final split keeps React together, uses lazy history/channel routes, and passes real browser tests. Responsive assertions wait for the actual collapsed-layout condition rather than guessing a delay. No failing test is disabled.

## Sprint 2 verification

- Ordered Browser Steps exercise cookie dismissal, dropdown selection, literal/private fill, CSS/XPath waits, scrolling, deadlines, safe optional warnings and sanitized errors. Real Chromium verifies the public workflow before one hybrid capture. A stalled scroll evaluation is interrupted by its step deadline.
- Revoked cookie/bearer tokens cannot be reused after logout/all-devices/password change. Expired, unknown, untracked and cross-user session IDs fail. Incorrect current-password attempts do not revoke a valid session.
- Vault ownership, write-only responses, encryption binding/tamper protection, reference isolation/expiry and clear operations are covered. Private-fill execution uses controlled pages/mocks; no real authenticated HTTPS site login was attempted or claimed.
- Controlled 401/403/login/challenge fixtures preserve safe distinctions, including avoiding a false positive on an article about CAPTCHA. State transitions preserve captures, metadata/backoff are persisted, and continuous persistent/challenge states produce one optional alert.
- Pagination, baseline configuration resets, paused scheduling, owner-scoped delivery history, administrator retry and permanent failure after five bounded retries are verified.
- React tests cover step add/remove/reorder/validation, search/status semantics, delivery error/retry UI, theme storage/algorithm synchronization and revoked-session handling. Browser smoke additionally exercises dashboard search, mobile steps controls, decimal history and image comparisons; ignored local screenshots include `browser-steps-mobile.png`.
- Production Docker API/UI builds pass. The reusable `scripts/docker-smoke.mjs` checks UID 1000, 1 CPU, 1 GiB RAM, 256 PIDs and sandboxed Browser Steps/CSS/XPath captures with no external container network. CI adds a separate bounded Ubuntu 22.04 Docker job.

During local verification, the 32 GiB Cloud disk filled with Docker build layers and a smoke launch failed with ENOSPC. Reclaiming only this application's reproducible build cache and superseded disposable validation images/containers restored space; database/capture volumes were preserved. The final image smoke was rerun successfully. The complete current Compose stack could not be kept concurrently on this Cloud disk; configuration, migration, worker shutdown, image builds and sandboxed captures were checked separately. GitHub Docker builds/smoke also passed. No sandbox/security setting was relaxed. The frontend's jsdom pseudo-element layout notice is informational; real Chromium checks the rendered interface. No test is disabled or skipped.

## Limits

Total JavaScript download size is not reduced by the same ratio as the largest chunk; initial dependencies remain significant. Further route/form optimization and performance budgets remain future work. New delivery/account/private-value views are lazy-loaded; there is no claim that total JavaScript shrank. The private shared-ui theme source is still unavailable and no substitute is introduced.

Image checks cannot prevent a hostile page from allocating resources before measurement; Docker quotas provide the tested process-level backstop. Sandbox policy on a future deployment host requires a separately authorized review. Previously stored Sprint 1 dimension mismatches cannot safely be retroactively distinguished from genuine 100% events without inspecting historical artifacts, so old records are not rewritten.

Remote notifications remain at least once in crash/uncertain-provider windows. The scanner checks known credential patterns, emails and optionally supplied private substrings; it is not a complete security audit. Runtime configuration, screenshots, credentials and logs are ignored and excluded from commits/build contexts. Inherited upstream history is preserved; new changed commit files are scanned without printing matched values.
