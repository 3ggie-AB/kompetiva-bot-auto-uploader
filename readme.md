# Ditekindo Bot - Chromium Automation

Bot untuk login ke app.ditekindo.co.id, mengambil data submission dari API, generate PDF form terkait, lalu upload PDF sebagai attachment submission.

## Fitur

✅ Login otomatis ke website menggunakan Puppeteer/Chromium  
✅ Ambil cookies dari sesi browser  
✅ Akses API backend dengan autentikasi (X-SECRET-BOT header)  
✅ Ambil data dari endpoint `/api-bots`  
✅ Buka halaman detail berkas asesi berdasarkan `pengajuan_id`  
✅ Generate PDF dari dropdown titik tiga berdasarkan kode submission (`template.kode` / `meta_json.form`)  
✅ Upload PDF ke endpoint attachment submission  
✅ Simpan hasil API ke file JSON  
✅ Screenshot otomatis untuk debugging  
✅ Error handling lengkap  

## Prerequisites

- Node.js versi 14 atau lebih baru
- NPM atau Yarn

## Instalasi

1. **Copy file `.env.example` menjadi `.env`:**
   ```bash
   cp .env.example .env
   ```

2. **Edit file `.env` dan isi kredensial Anda:**
   ```env
   # Konfigurasi Login Web
   WEB_URL=https://app.ditekindo.co.id/
   EMAIL=miminAdmin@gmail.com
   PASSWORD=password_anda_disini
   
   # Konfigurasi API Backend
   API_BASE_URL=https://app.ditekindo.co.id
   SECRET_BOT=token_secret_bot_anda
   
   # Konfigurasi Bot
   ROLE_NAME=Super Admin
   ATTACHMENT_UPLOAD_PATH=/api/submissions/:id/attachment
   DOWNLOAD_TIMEOUT_MS=120000
   LSP_ID=1
   PAGE=1
   LIMIT=100
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

## Cara Penggunaan

### Mode 1: Lengkap (Browser Login + API Fetch + Generate PDF + Upload)

Jalankan bot dengan login browser terlebih dahulu, fetch API, generate PDF, lalu upload attachment:

```bash
npm start
```

atau

```bash
node bot.js
```

### Mode 2: API Only (Tanpa Browser)

Jika token SECRET_BOT sudah cukup tanpa perlu cookies dari browser, edit `bot.js`:

```javascript
// Di bagian bawah file bot.js, ubah:
await bot.run();  // ← comment ini

// Menjadi:
await bot.runApiOnly();  // ← uncomment ini
```

## Output

Bot akan menghasilkan file-file berikut:

- `output/api-bots-result.json` - Hasil dari endpoint `/api-bots`
- `output/login-page.png` - Screenshot halaman login
- `output/after-login.png` - Screenshot setelah login
- `output/role-selected.png` - Screenshot setelah role dipilih
- `output/after-role-enter.png` - Screenshot setelah klik Masuk Sekarang
- `output/detail-{pengajuan_id}-{kode_form}.png` - Screenshot halaman detail berkas
- `output/dropdown-{kode_form}.png` - Screenshot menu titik tiga sebelum klik Generate PDF
- `output/downloads/*` - File PDF hasil Generate PDF
- `output/upload-{submission_id}-{kode_form}.json` - Response upload attachment
- `output/error-login.png` - Screenshot jika terjadi error (opsional)

## Struktur Kode

```
DitekindoBot
├── initBrowser()          - Inisialisasi Chromium browser
├── loginToWeb()           - Login ke website
├── fetchApiData()         - Fetch data dari API
├── openFormsFromSubmissions(data) - Generate PDF dan upload attachment
├── saveToFile(data)       - Simpan hasil ke file JSON
├── run()                  - Jalankan bot lengkap (browser + API)
└── runApiOnly()           - Jalankan hanya API fetch
```

## Konfigurasi API

### Endpoint: `/api-bots`
```
GET /api-bots?lsp_id=1&page=1&limit=100
```

### Upload Attachment
Default upload path:
```
POST /api/submissions/:id/attachment?lsp_id=1
```

Field multipart:
```
attachment=<file-pdf>
```

Jika route backend berbeda, ubah `ATTACHMENT_UPLOAD_PATH` di `.env`, contoh:
```env
ATTACHMENT_UPLOAD_PATH=/api/submission/:id/attachment
```

### Autentikasi

Bot mendukung 2 metode autentikasi (pilih salah satu di `bot.js`):

**Metode 1: X-SECRET-BOT Header (Default)**
```javascript
headers: {
  'X-SECRET-BOT': 'your_secret_token'
}
```

**Metode 2: Authorization Bearer**
```javascript
headers: {
  'Authorization': 'Bearer your_secret_token'
}
```

## Troubleshooting

### 1. Error "Input email tidak ditemukan"
- Periksa selector di array `emailSelectors` di dalam fungsi `loginToWeb()`
- Buka `output/login-page.png` untuk melihat struktur halaman
- Inspect element di browser untuk mendapatkan selector yang tepat
- Tambahkan selector baru ke array jika diperlukan

### 2. Error "API request failed: 401"
- Periksa `SECRET_BOT` di file `.env` sudah benar
- Pastikan header autentikasi yang digunakan sesuai dengan backend
- Coba ganti dari X-SECRET-BOT ke Authorization Bearer atau sebaliknya

### 3. Error "API request failed: 403"
- Cookies dari browser mungkin diperlukan
- Pastikan bot sudah login ke web terlebih dahulu (gunakan mode `run()` bukan `runApiOnly()`)

### 4. Browser tidak muncul
- Set `headless: false` di `initBrowser()` sudah benar
- Jika ingin headless mode, ubah menjadi `headless: true`

### 5. Timeout saat login
- Periksa koneksi internet
- Tingkatkan nilai `timeout` di fungsi `loginToWeb()`
- Periksa apakah website sedang maintenance

## Customisasi

### Mengubah Selector Login

Edit array selector di fungsi `loginToWeb()`:

```javascript
const emailSelectors = [
  'input[type="email"]',
  'input#your-custom-id',  // tambahkan selector baru
  // ...
];
```

### Mengubah Parameter API

Edit file `.env`:

```env
LSP_ID=2        # ubah sesuai kebutuhan
PAGE=1
LIMIT=50        # ubah limit data
```

### Menambah Endpoint Baru

Tambahkan fungsi baru di class `DitekindoBot`:

```javascript
async fetchCustomEndpoint() {
  const url = `${this.config.apiBaseUrl}/custom-endpoint`;
  // ... implementasi fetch
}
```

## Keamanan

⚠️ **PENTING:**
- Jangan commit file `.env` ke repository
- File `.env` sudah ada di `.gitignore`
- Simpan `SECRET_BOT` dengan aman
- Jangan share screenshot yang berisi data sensitif

## License

ISC

## Support

Jika ada masalah atau pertanyaan, periksa:
1. File screenshot (`*.png`) untuk debugging visual
2. Console log untuk error message detail
3. File JSON hasil fetch untuk melihat struktur response

---

Dibuat dengan ❤️ untuk Ditekindo
