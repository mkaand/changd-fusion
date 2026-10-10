# Private Codespaces önizlemesi ve Telegram

Bu geliştirme ortamı üretim dağıtımı değildir. Üretim altyapısına veya gerçek müşteri verilerine bağlanmaz.

## iPhone Safari için en kısa yol

1. GitHub hesabınızla [geliştirme dalında Codespace oluşturun](https://codespaces.new/mkaand/changd-fusion/tree/feat/changd-fusion-sprint-1). En az 2 CPU / 8 GiB seçin. GitHub kullanım kotası ve ücretlendirmesi hesabınıza bağlıdır.
2. Otomatik kurulumun bitmesini bekleyin. VS Code web editöründe açılan `.preview/login.txt` dosyasındaki **ilk giriş** bilgilerini alın. Dosya görünmezse Explorer'dan açın; GitHub'a commit etmeyin, paylaşmayın veya ekran görüntüsüne eklemeyin. Parolanızı uygulamadan değiştirdiyseniz yeni parolanız geçerlidir; yeniden başlatma parolayı sıfırlamaz.
3. **Ports → 3000 → Private → Open in Browser** ile HTTPS bağlantısını ayrı Safari sekmesinde açın ve Changd Fusion'a giriş yapın. GitHub'ın private preview erişim kontrolü ayrıca yürürlüktedir. Diğer portları yönlendirmeyin; Public veya Organization görünürlüğü kullanmayın.

Normal akışta terminal komutu gerekmez. GitHub'ın Codespaces repository token'ı port API'sine yetmezse güvenli başlangıç `private_port` aşamasında durur. Bu durumda **yalnızca kendi Codespace terminalinizde** `node .devcontainer/authorize.mjs` çalıştırın ve GitHub'ın device/OAuth akışını tamamlayın. Yardımcı script private port denetimi için `codespace` yetkisi ister, repo token'ını değiştirmez, ham token istemez veya yazdırmaz; OAuth kaydı yalnızca ignored `.preview/gh/` altında tutulur. Sonrasında uygulamayı yeniden başlatır. Kodlama görevinin GitHub integration yetkisi, kullanıcının Codespaces OAuth yetkisiyle aynı değildir.

## Recovery Mode: mevcut Codespace'i koruyarak kurtarma

Yeni Codespace oluşturmayın; mevcut Codespace, `.preview` sırları ve PostgreSQL volume'u korunmalıdır.

1. Mevcut Codespace'in VS Code web editöründe **Source Control → … → Pull, Push → Pull** ile `feat/changd-fusion-sprint-1` dalını güncelleyin. Bu işlem menüde bulunmazsa **View → Command Palette → Git: Pull** aynı GUI eylemidir. Terminal veya log toplama gerekmez. Kaydedilmemiş kullanıcı değişikliklerini silmeyin.
2. **View → Command Palette → Codespaces: Rebuild Container** seçin. Otomatik kurulum bitince `.preview/login.txt` ve **Ports → 3000 / Private → Open in Browser** üzerinden giriş yapın. Codespace'i silmeyin, DB volume'unu kaldırmayın; parola sıfırlanmaz.

Rebuild, uzaktaki yeni commit'i kendiliğinden checkout'a çekmez; bu yüzden önce Pull gerekir. Yeniden oluşturma sırasında eklenen permission bootstrap yalnızca bu Codespace'in runtime/HOME sahipliğini onarır; PostgreSQL verisini silmez. Private port API yetkisi veya platform sandbox desteği ayrıca sağlanamazsa güvenli başlangıç kapalı kalır; bu doğrulamalar başarılı varsayılmaz.

## Otomatik kurulum

- Pinned Node.js 24.19.0, PostgreSQL 16.13, Chromium ve checksum doğrulamalı GitHub CLI 2.102.0.
- Tek geliştirme container'ında API + build edilmiş React arayüzü + worker; ayrı PostgreSQL container'ı. Redis ve iç içe Docker daemon yoktur.
- `node` UID/GID 1000, `HOME=/home/node` ve VS Code config/server dizinleri açıkça hazırlanır. `updateRemoteUserUID=false` kimliğin değişmesini önler; ayrı `preview_home` volume'u platformun `/home` mount'undan bağımsız writable HOME sağlar.
- Ağsız, read-only root filesystem kullanan, 60 saniye sınırlı `permissions` servisi yalnızca `.preview` ve HOME mount'larını hazırlamak için kısa süreli root çalışır. CHOWN/FOWNER/DAC_OVERRIDE dışında capability yoktur; uygulama/API/worker/browser daima UID/GID 1000 olarak çalışır. Dizinler 0700, normal runtime dosyaları 0600 olur; symlink/special-file/hardlink reddedilir. Secret byte'ları, kullanıcı parolaları ve DB volume'u korunur. Host UID farklıysa sonraki initialize koşusu runtime içine girmeden container onarımına bırakır.
- `initialize.py` yalnızca bu checkout'un ignored `.preview/` dizininde rastgele PostgreSQL parolası üretir. `setup.mjs` iki lockfile ile `npm ci` ve build çalıştırır. npm cache yalnızca `.preview/npm-cache/` içindedir.
- `start.mjs`/`serve.mjs` Private portu gerçekten API'den doğrular, rootless Chromium Seccomp-BPF sandbox kontrolü yapar, migration 001–003'ü uygular ve ilk kullanıcıyı oluşturur. API/arayüz ve worker bu kontrollerden sonra açılır. Private görünürlük periyodik olarak tekrar denetlenir; doğrulanamazsa uygulama kapatılır.
- API ve arayüz aynı 3000 portunda sunulur. PostgreSQL için Docker `ports` yoktur; ayrı backend portu yoktur. Diğer portların otomatik yönlendirilmesi ve önceki yönlendirmelerin geri yüklenmesi kapalıdır.
- İç container bağlantısı HTTP'dir; dış bağlantı GitHub'ın private HTTPS gateway'inden geçer. `portsAttributes.protocol=http` iç servis protokolüdür, dış HTTPS veya Secure cookie'yi kapatmaz.
- Dış origin yalnızca doğrulanmış `CODESPACE_NAME` ve resmi `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` değişkenlerinden türetilir. İstek `Host`/`Origin` başlıklarından PUBLIC_URL üretilmez. İzinli hostlar dış hostname ile gateway'in loopback hedefidir; keyfi forwarded header'lara güvenilmez.
- `NODE_ENV=production`, Secure + HttpOnly + SameSite=Strict cookie, mevcut JWT/session revocation ve mutation header/origin denetimleri korunur. Public registration kapalıdır.
- `.preview/` 0700, parola/anahtar/login/log dosyaları 0600; symlink ve paylaşıma açık credential dosyaları reddedilir. Giriş bilgileri HTTP endpoint'inden verilmez, başlangıç/CI loglarına basılmaz ve Docker build context'ine girmez.

Uygulama container'ı 2 CPU, 6 GiB RAM, 512 PID, 512 MiB shared memory ile sınırlıdır; PostgreSQL 0.5 CPU / 512 MiB / 128 PID kullanır. Chromium concurrency 1, capture deadline 30 saniye, preview pixel sınırı 4 milyon, history retention 14 gündür. Yeni build cache sürekli üretilmez. Kapanışta PID 1 yardımcısı yalnızca kendi supervisor'ına SIGTERM iletir; API bağlantıları, worker ve DB pool kapatılır. Son süreler takılı süreçleri sınırlar. Çok sayıda/çok sık monitör disk kullanımını artırabilir; kaynakları Codespaces panelinden takip edin.

## Deneme akışı

İlk açılışta tek, **duraklatılmış** sentetik Text + Visual monitörü vardır. Önce/sonra/diff PNG'leri, iki geçmiş olayı ve tam `%0,35` örneği yerel test DB'sine oluşturulur. Demo eşiği `%0,30`'dur; normal karşılaştırma eşitlik kuralı hâlâ **yalnızca eşikten büyükse değişiklik** olarak kalır. Demo için website isteği, provider credential veya outbox teslimatı oluşturulmaz.

Demo geçmişini, Before/After slider'ını ve Browser Steps editörünü inceleyin. Gerçek izleme için kendi herkese açık HTTPS hedefinizle bir monitör oluşturun; Text/Visual, selector ve Steps ayarlarını kaydedip **Check now** kullanın. İlk başarılı kontrol baseline oluşturur; sonraki değişiklikler birleşik geçmişe girer. CSS/XPath, full-page/element capture ve normal SSRF/DNS/redirect/subresource kontrolleri korunur. Private IP veya metadata adresleri önizleme amacıyla açılmaz.

Telegram kanalına bot bilgilerinizi yalnızca uygulamanın authenticated notification settings ekranından girin. Token ve Chat ID şifreli DB konfigürasyonunda tutulur; token API'den geri dönmez. Token alanını boş bırakmak düzenlemede mevcut değeri korur. Codespaces'te **Test notification** eylemini bizzat başlatıp başarılı teslimat almadan otomatik Telegram teslimatı açılamaz. Token/Chat ID değişirse onay kaldırılır. Testten önce oluşan değişiklik teslimatları `Test notification required` olarak başarısız kaydedilir; kendiliğinden gerçek mesaj göndermez. Testten sonra monitöre atanmış kanallara normal değişiklik bildirimi gider. SMTP'nin mevcut TLS/doğrulama ve teslimat davranışı korunur.

Telegram varsayılan olarak İngilizcedir, timezone `Europe/Istanbul`'dur. Kanal editöründen timezone seçebilirsiniz. Yüzde değeri yuvarlanmadan `0.35%` biçiminde sunulur. Provider taşıma/güvenlik kodundan ayrı İngilizce attention/caption kataloğu ileride localization için bir sınır sağlar; bu sürümde dil seçimi yoktur. Metin parse mode olmadan gönderilir; kullanıcı HTML/Markdown'ı Telegram talimatı olarak işlenmez. Attention mesajları ham exception/özel oturum değerlerini içermez. Önce/sonra/diff görselleri album olarak gönderilebilir; fotoğraf boyut/oran sınırına uymayan PNG belge olur. En fazla üç ek, ek başına 4 MiB ve toplam 8 MiB sınırı vardır; fazla büyük ekler gönderilmez. Metin 4000 UTF-16 birimini aşmaz ve surrogate pair kesilmez.

Örnek sentetik mesaj:

```text
🔔 Changd Fusion | Change Detected!

🌐 Monitor: Example Product Watch
🟢 Status: Content changed
📝 Text: + Price changed
🖼️ Visual difference: 0.35%
🕒 Checked: 2026-10-10 13:23 (Europe/Istanbul)
🔗 Open monitor: https://example.com/jobs/fixture
```

Boyut değişikliğinde `📐 Dimensions: 1280×900 → 1280×1800` sunulur; yüzde uydurulmaz. Attention başlıkları `⚠️ Persistent Monitoring Failure`, `🔐 Sign-in Required` ve `🧩 Possible Challenge` olarak ayrılır. Challenge metni olasılık bildirir, CAPTCHA kesinliği veya çözüm iddiası taşımaz. Retry mesajında `🔄 Notification retry: 2/5` bulunur. Outbox birleşik olay/kanal benzersizliğini korur; uzak SMTP/Telegram teslimatı crash/yanıt belirsizliğinde **at-least-once** kalır, exactly-once garanti edilmez.

## Sorun giderme ve doğrulama sınırı

`.preview/startup.log` dosyasını yalnızca kendi Codespace'inizde inceleyin; dosyayı issue/PR/artifact olarak yüklemeyin. `private_port` için OAuth yardımcısını kullanın. `chromium_sandbox` hatasında sandbox'ı kapatmayın; Codespaces/container platformundaki user namespace/seccomp desteği incelenmelidir. `migrations` hatasında `.preview/db-password` ve bu Codespace'in PostgreSQL volume'unun birlikte korunmuş olduğunu denetleyin; script otomatik DB silme/sıfırlama yapmaz. `node .devcontainer/start.mjs` idempotent yeniden başlangıç sağlar.

Private GitHub gateway ve gerçek iPhone Safari yalnızca gerçek Codespace açılışında doğrulanabilir. Yerel tests, başarılı GitHub CI veya Docker sandbox smoke bu doğrulamanın yerine geçmez. Repo integration yetkisi Codespace oluşturmayı engelliyorsa kullanıcı yukarıdaki linkten başlatmalıdır. Özel shared-ui anahtarı sağlanmadığından mevcut theme adapter korunur; yeni tema anahtarı eklenmez. CAPTCHA çözümü ve production deployment yoktur.

## Recovery doğrulaması

Gerçek Dev Containers CLI 0.89.0 ile host `/home` mount'u altında eksik `/home/node` için EACCES yeniden üretildi. Aynı mount altında yeni HOME volume'u, farklı UID'nin oluşturduğu 0700 `.preview`, lifecycle `initialize`/`postCreate` npm ci/build, VS Code first-run notice yazımı, PostgreSQL migration 001–003 ve tekrar açma doğrulanır. CLI testi Codespaces ortamı olmadığı için postStart'ta yalnızca izin doğrulamasını çalıştırır; gerçek uygulama başlangıcının Codespaces bağlamı olmadan reddedilmesini de sınar. Gateway/private erişim taklit edilmez. API/frontend/worker smoke ve capture testleri ayrı kontrollü testlerdir. Gerçek kullanıcı Codespace'i entegrasyon token'ına görünmediği için Recovery Mode'dan çıkışı veya iPhone Safari başarısı bu görevde doğrulanmış değildir.
