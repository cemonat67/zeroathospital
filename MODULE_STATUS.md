# ZeroAtHospital Modül Durum Raporu

## ✅ Tam Çalışan Modüller (Client-Side Only)

Bu modüller backend API olmadan da çalışır:

### 1. **Main** ✅
- KPI kartları
- Tablo görünümü
- Grafikler (Chart.js)
- Filtreler
- Export (CSV, PDF, Excel)

### 2. **Live** ✅
- Gerçek zamanlı monitoring
- Canlı grafik güncelleme
- Otomatik veri üretme
- Simülasyon modu

### 3. **Scopes** ✅ (Kısmi)
- Scope 1, 2, 3 hesaplamaları
- Scope dağılım grafikleri
- **Not:** Optimal çalışması için backend API'den profil verisi çeker

### 4. **Dept Dashboard** ✅
- Departman özet KPI'ları
- CO₂ trend grafikleri
- Aylık dağılım
- Tamamen client-side hesaplamalar

### 5. **Benchmark** ✅
- Temel benchmark görünümü
- UI tam fonksiyonel

## ⚠️ Backend API Gerektiren Modüller

Bu modüller çalışmak için server.js'in aktif olması gerekir:

### 6. **Alerts** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/alerts` - Alert yükleme/değerlendirme
- LocalStorage fallback ile kısmi çalışabilir

### 7. **Actions** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/actions`, `/api/tasks` - Task yönetimi
- LocalStorage fallback mevcut

### 8. **Departments** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/targets` - Departman hedefleri
- LocalStorage fallback mevcut

### 9. **Compliance** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/esrs/checklist`, `/api/dnsh/checklist` - Uyum kontrolleri
- PDF export özellikleri backend gerektirir

### 10. **Data** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/files` - Dosya yükleme/listeleme
- LocalStorage ile demo çalışır

### 11. **Sessions** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/sessions` - Oturum yönetimi
- LocalStorage ile demo çalışır

### 12. **Settings** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/settings` - Global ayarlar
- LocalStorage fallback ile çalışır

### 13. **Ops** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/ops/*` - Operasyonel metrikler
- Backend zorunlu

### 14. **Clinical** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/procs/*` - Prosedür verileri
- Backend zorunlu

### 15. **Journey** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/journeys` - Hasta yolculuğu
- Backend zorunlu

### 16. **Procurement** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/procurement/*` - Tedarik verileri
- Backend zorunlu

### 17. **Drugs** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/drugs` - İlaç veritabanı
- Backend zorunlu

### 18. **Carbon Market** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/carbon/*` - Karbon kredi/ticaret
- Backend zorunlu

### 19. **Insurance** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/insurance` - Sigorta konfigürasyonu
- Backend zorunlu

### 20. **Waste AI** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/waste` - Atık AI modeli
- Backend zorunlu

### 21. **Pandemic** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/pandemic` - Pandemi yönetimi
- Backend zorunlu

### 22. **Twin** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/twin` - Dijital ikiz
- Backend zorunlu

### 23. **Campus** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/campuses` - Kampüs yönetimi
- Backend zorunlu

### 24. **Finance** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/finance/*` - Finansal veriler
- Backend zorunlu

### 25. **Taxonomy** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/taxonomy/*` - Taksonomi verileri
- Backend zorunlu

### 26. **Connectors** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/connectors` - Dış bağlantılar
- Backend zorunlu

### 27. **Radar** ⚠️
- UI: ✅ Çalışıyor
- API: `/api/radar/*` - Radar analizi
- Backend zorunlu

---

## 📊 Özet İstatistikler

- **Toplam Modül:** 27
- **Tam Çalışan (Client-Side):** 5 modül (19%)
- **Backend Gerektiren:** 22 modül (81%)

## 🔧 Backend Sorunu

Server.js Node.js kütüphane uyumsuzluğu nedeniyle şu anda çalışmıyor:
```
dyld[22370]: Symbol not found: _EVP_MD_CTX_get_size_ex
```

### Çözüm Önerileri:
1. Node.js versiyonunu güncelle
2. OpenSSL kütüphanelerini kontrol et
3. `npm install` ile bağımlılıkları yeniden yükle

## ✅ Şu Anda Test Edebileceğin Modüller

Backend olmadan tam çalışanlar:
1. **Main** - Ana dashboard
2. **Live** - Canlı izleme
3. **Dept Dashboard** - Departman özeti
4. **Benchmark** - Temel görünüm

Kısmi çalışanlar (UI test edilebilir):
- **Scopes** - Scope hesaplamaları
- **Alerts** - Uyarı arayüzü
- **Actions** - Aksiyon listesi
- **Data** - Dosya arayüzü
- **Settings** - Ayarlar paneli

---

**Son Güncelleme:** 16 Kasım 2025, 20:15
