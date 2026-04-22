# MIUX final patch notes

Basis patch: `refactored/m9`

Perbaikan utama yang diterapkan:
- Auth dashboard diganti dari password header statik menjadi session cookie HttpOnly.
- Semua endpoint `/api/*` selain health/login/auth-status sekarang butuh auth.
- WebSocket sekarang memeriksa session sebelum mengirim state bot.
- Password default dan AI key hardcoded dihapus dari konfigurasi contoh.
- Runtime live/testnet-mainnet sekarang mengikuti `STATE.mode`, bukan env startup yang beku.
- Manual close tidak lagi menerima harga dari client.
- Posisi live tidak akan ditutup di state internal kalau close order exchange gagal.
- Fill live tidak lagi kena simulasi slippage kedua kalinya.
- Bug release bucket saat close profit/loss diperbaiki: release kembali principal awal.
- Special-case BTC live treasury dari scan engine dimatikan; DCA live berjalan dari scheduler/manual DCA saja.
- `last_btc_dca` sekarang dipersist ke `data/macro_cache.json` hanya setelah DCA sukses.
- Frontend berhenti menyimpan password di `localStorage`; XSS surface dikurangi dengan sanitasi string dari backend.

Yang belum saya angkat ke patch ini:
- Rekonsiliasi posisi live terbuka dari exchange saat startup/restart.
- Hardening CSP yang lebih ketat setelah semua inline handler frontend dihapus.
- Ledger treasury BTC yang benar-benar terpisah dari bucket sizing.


## Hotfix 2
- Perbaikan CORS agar request same-origin tetap diizinkan walau `DASHBOARD_ORIGIN` terisi berbeda.
- Origin ditormalisasi sebelum dicek, dan penolakan origin sekarang mengembalikan 403 JSON alih-alih 500 HTML.
- `.env.example` diubah agar `DASHBOARD_ORIGIN` default kosong dan ada contoh multi-origin untuk localhost/127.0.0.1/0.0.0.0.

## Hotfix 3
- Jalur HTTP outbound tidak lagi memakai axios/follow-redirects; diganti client native Node (`http`/`https`) dengan `Connection: close`, tanpa socket pooling, dan limiter global request paralel.
- Scheduler price refresh tidak lagi meledakkan 10 request sekaligus; sekarang dibatasi 4 paralel.
- `getMultiTF()` tidak lagi menembak 5 timeframe sekaligus; sekarang dibatasi 2 paralel per simbol.
- `updateMacro()` tidak lagi mem-burst semua provider sekaligus; sekarang dibatasi 2 paralel.
- Preflight futures live (`positionSide` / `marginType` / `leverage`) dibuat serial, bukan paralel.
- Ditambahkan diagnostik `MaxListenersExceededWarning` ke log agar kalau warning muncul lagi sumbernya terlihat lebih cepat.
- Ditambahkan `http_stats` pada `/api/status` dan endpoint auth-only `/api/debug/http` untuk melihat pola request yang paling sering dipakai.
- Price refresher 5 detik sekarang skip saat `runScan()` sedang aktif, jadi tidak menumpuk dengan burst klines saat initial scan / scan rutin.
