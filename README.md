# 🥜 $PEANUT Mining Agent

Bot mining $PEANUT otomatis dengan Telegram bot untuk monitoring dan kontrol.

## Fitur
- Multi-account mining
- Telegram bot untuk monitor earnings
- Input license lewat Telegram (tanpa terminal)
- Auto notifikasi berkala

## Deploy ke Railway

1. Fork/clone repo ini
2. Buka [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set Environment Variables:

| Variable | Keterangan |
|---|---|
| `PEANUT_WALLET_1` | Wallet address kamu |
| `TELEGRAM_BOT_TOKEN` | Token dari @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID kamu (cek via @userinfobot) |
| `NOTIFY_INTERVAL_MS` | Interval notif otomatis (default: 1800000 = 30 menit) |
| `TASK_NOTIFY_EVERY` | Notif setiap N tasks (default: 50) |

4. Railway otomatis deploy dan jalankan `npm start`
5. Buka Telegram → ketik `/license` → input kode license

## Telegram Bot Commands

| Command | Fungsi |
|---|---|
| `/license` | Input atau cek license |
| `/clearlicense` | Hapus license untuk re-input |
| `/stats` | Lihat earnings semua akun |
| `/status` | Cek miner aktif/mati |
| `/notify` | Update stats manual |
| `/addaccount` | Tambah wallet baru |
| `/listaccounts` | Lihat semua akun |
| `/removeaccount` | Hapus akun |
| `/setcompute` | Ganti CPU/GPU |
| `/setinterval` | Ganti mining interval |

## Struktur File

```
peanut-miner/
├── miner.mjs       # Mining engine
├── bot.mjs         # Telegram bot
├── accounts.json   # Konfigurasi akun (wallet diisi via env atau bot)
├── package.json
└── .gitignore
```
