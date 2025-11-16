# Zero@Hospital

Zero@Hospital, hastaneler için **karbon ayak izi, enerji, su, atık, medikal atık ve uyumluluk** metriklerini takip eden, raporlayan ve aksiyona dönüştüren bir **sürdürülebilirlik ve Ops platformudur.**

- Klinik, departman ve kampüs bazında CO₂e ve kaynak kullanımı
- ESRS / DNSH / CSRD / ISO / JCI uyumluluk modülleri
- Ops & SI (Service Intelligence) katmanı: healthcheck, metrics, guardian, staging, backup, deploy

GitHub Pages demo:  
👉 **https://cemonat67.github.io/zeroathospital/**

---

## Özellikler (Product)

### 🎯 Çekirdek Fonksiyonlar

- **Emisyon & Kaynak Takibi**
  - CO₂e, enerji, su, atık, medikal atık
  - Klinik / departman / kampüs bazlı KPI, tablo ve grafikler
- **Scope 1 / 2 / 3 Dağılımı**
  - Departman bazlı `scope_weights` ile otomatik dağıtım
- **Faktör Kütüphanesi**
  - DEFRA / EEA profilleri
  - Profil seçimi, CSV içe aktarma ve doğrulama
  - Hospital → Profil ve Country → Profil mapping

- **Live Data & BMS Entegrasyonu**
  - Sayaç okumaları, canlı stream (BMS/SCADA/EHR connector mantığı)
  - Sayaç tetiklerinden otomatik görev oluşturma

- **Uyarı ve Görev Yönetimi**
  - Alert rules → evaluation → otomatik task üretimi
  - SLA, “Overdue”, “Escalate”, notify group + e-posta şablonları

- **Uyumluluk & PDF Raporlama**
  - ESRS / DNSH kayıt & checklist
  - ESRS Gap & DNSH PDF
  - CSRD / ISO / JCI için compliance PDF ve planlı rapor e-postaları

- **Seyahat Emisyonları (ICAO)**
  - Uçuş / transport verisi ile Scope 3 emisyon hesaplama

- **Security & Auth**
  - Kullanıcı kaydı, login, rol & permission matrisi
  - Rate-limit, access log, security config

---

## Özellikler (Ops & SI Katmanı)

### ✅ Ops v1 – Health & Guardian

- `GET /api/health`
  - `status`, `timestamp`
  - `app.uptime_sec`
  - RAM `free_mb`
  - `dataFolder` erişimi ve çekirdek JSON dosya kontrolü

- **Ops Metrics Logging**
  - Tüm HTTP istekleri loglanır:
  - Dosya formatı: `data/ops_metrics_YYYYMMDD.jsonl`
  - Kayıt formatı:
    ```json
    {"ts": "...", "path": "...", "method": "GET", "status": 200, "duration_ms": 123}
    ```

- **Basic Guardian**
  - Her 5 dakikada son 5 dakikalık metrikler taranır
  - Eşikler aşılırsa `data/ops_alerts.json` içine alert kaydedilir
  - Örnek eşikler:
    - p95 latency > 2000 ms
    - 5xx hata sayısı belirli eşiğin üzerinde

- **Ops Summary**
  - `GET /api/ops/summary?hours=24`
  - Dönüş:
    - Toplam istek
    - En çok çağrılan ilk 10 endpoint
    - p95 en yüksek ilk 5 endpoint
    - 4xx / 5xx hata sayıları

- **Ops Tickets (Planner)**
  - `GET /api/ops/tickets`
  - `POST /api/ops/tickets/generate`
  - Koşul örneği:
    - `p95 > 2000`, `count > 100`, `error_rate > 0.1`
  - `data/ops_tickets.json` içine **tekil** `open` ticket (duplicate engelleme ile)

---

### ✅ Ops v2 – Staging, Backup, Deploy

- **Staging Config**
  - `config/ops.config.json`:
    - `prod`: `port: 5174`, `dataDir: "data"`
    - `staging`: `port: 6174`, `dataDir: "data_staging"`
  - `ZERO_ENV=staging` → otomatik staging port + data dizini

- **Staging Data Hazırlama**
  - `scripts/prepare_staging_data.sh`
  - Eğer `data_staging/` yoksa `data/`’dan kopyalayarak oluşturur

- **Backup & Snapshot**
  - `scripts/backup.sh [prod|staging]`
  - Çıktı:
    - `backup/zero_hospital_${ENV}_${YYYYMMDD_HHMMSS}.tar.gz`
  - Log:
    - `backup/backup_log.jsonl`:
      ```json
      {"ts":"...", "env":"prod", "file":"zero_hospital_prod_20251116_140000.tar.gz", "status":"ok", "size_bytes":123456}
      ```

- **Smoke Tests & Orkestrasyon**
  - `test/api_smoke_tests.sh`:
    - `/api/health`
    - `/api/ops/summary`
    - `/api/eflib`
    - `/api/reports/list`
    - `/api/tasks`
  - `scripts/run_tests.sh`:
    - Smoke testleri staging URL üzerinde koşturur:
      ```bash
      ./scripts/run_tests.sh http://localhost:6174
      ```

- **Deploy Script’leri**
  - `scripts/deploy_staging.sh`:
    - Staging backup
    - `ZERO_ENV=staging` ile server restart
    - Smoke test çalıştırma
  - `scripts/deploy_prod.sh`:
    - Prod backup
    - Prod server restart
    - `GET /api/health` ile health kontrol

---

## Klasör Yapısı (Özet)

```text
ZeroAtHospital/
├── index.html          # Ana dashboard (zah.html ile hizalı)
├── zah.html            # Full UI dashboard
├── server.js           # Node.js API + static server
├── config/
│   └── ops.config.json
├── scripts/
│   ├── backup.sh
│   ├── prepare_staging_data.sh
│   ├── deploy_staging.sh
│   ├── deploy_prod.sh
│   └── run_tests.sh
├── test/
│   └── api_smoke_tests.sh
├── data/               # Prod data (JSON)
├── data_staging/       # Staging data (opsiyonel)
└── backup/             # Snapshot arşivi
