require('dotenv').config();
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class DitekindoBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.outputDir = path.join(__dirname, 'output');
    this.downloadDir = path.join(this.outputDir, 'downloads');
    this.config = {
      webUrl: process.env.WEB_URL,
      email: process.env.EMAIL,
      password: process.env.PASSWORD,
      apiBaseUrl: process.env.API_BASE_URL,
      secretBot: process.env.SECRET_BOT,
      roleName: process.env.ROLE_NAME || 'Super Admin',
      attachmentUploadPath: process.env.ATTACHMENT_UPLOAD_PATH || '',
      downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000),
      lspId: process.env.LSP_ID || '1',
      page: process.env.PAGE || '1',
      limit: process.env.LIMIT || '100'
    };
  }

  ensureOutputDir() {
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  getOutputPath(filename) {
    this.ensureOutputDir();
    return path.join(this.outputDir, filename);
  }

  ensureDownloadDir() {
    fs.mkdirSync(this.downloadDir, { recursive: true });
  }

  async saveScreenshot(filename) {
    const screenshotPath = this.getOutputPath(filename);
    await this.page.screenshot({ path: screenshotPath });
    console.log(`📸 Screenshot tersimpan: ${screenshotPath}`);
    return screenshotPath;
  }

  async clickElementByText(text, options = {}) {
    const timeout = options.timeout || 30000;
    const startedAt = Date.now();
    let lastResult = null;

    while (Date.now() - startedAt < timeout) {
      lastResult = await this.page.evaluate((targetText, clickOptions) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = normalize(targetText);
        const exact = clickOptions.exact !== false;
        const preferInteractive = Boolean(clickOptions.preferInteractive);

        const isVisible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity) !== 0
            && rect.width > 0
            && rect.height > 0;
        };

        const isDisabled = (element) => {
          return element.disabled
            || element.getAttribute('aria-disabled') === 'true'
            || element.classList.contains('disabled');
        };

        const getTexts = (element) => {
          return [
            element.innerText,
            element.textContent,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title')
          ].map(normalize).filter(Boolean);
        };

        const matchesText = (element) => {
          const texts = getTexts(element);
          return exact
            ? texts.some((value) => value === target)
            : texts.some((value) => value === target || value.includes(target));
        };

        const isInteractive = (element) => {
          const tagName = element.tagName.toLowerCase();
          const role = element.getAttribute('role');
          return ['button', 'a', 'input'].includes(tagName)
            || role === 'button'
            || element.tabIndex >= 0;
        };

        const findClickableTarget = (element) => {
          if (preferInteractive) {
            return element;
          }

          for (let current = element; current && current !== document.body; current = current.parentElement) {
            if (isInteractive(current)) {
              return current;
            }
          }

          let cardTarget = element;
          for (let current = element.parentElement; current && current !== document.body; current = current.parentElement) {
            const rect = current.getBoundingClientRect();
            const text = normalize(current.innerText || current.textContent);
            const looksLikeCard = text.includes(target)
              && rect.width >= 100
              && rect.height >= 50
              && rect.height <= 350
              && rect.width <= 500;

            if (looksLikeCard) {
              cardTarget = current;
            }
          }

          return cardTarget;
        };

        const query = preferInteractive
          ? 'button, a, input[type="button"], input[type="submit"], [role="button"], [tabindex]'
          : 'body *';
        const candidates = Array.from(document.querySelectorAll(query))
          .filter((element) => isVisible(element) && !isDisabled(element) && matchesText(element));

        if (candidates.length === 0) {
          return { ok: false, reason: `teks "${targetText}" belum terlihat` };
        }

        const targetElement = findClickableTarget(candidates[0]);
        targetElement.click();

        return {
          ok: true,
          tagName: targetElement.tagName.toLowerCase(),
          text: (targetElement.innerText || targetElement.textContent || targetElement.value || '').trim()
        };
      }, text, { exact: options.exact, preferInteractive: options.preferInteractive }).catch((error) => ({
        ok: false,
        reason: error.message
      }));

      if (lastResult?.ok) {
        console.log(`✅ Klik "${text}" berhasil (${lastResult.tagName})`);
        return lastResult;
      }

      await sleep(500);
    }

    throw new Error(`Elemen dengan teks "${text}" tidak ditemukan. ${lastResult?.reason || ''}`.trim());
  }

  async selectRoleAndEnter() {
    console.log(`\n🎭 Memilih role ${this.config.roleName}...`);
    await this.clickElementByText(this.config.roleName, {
      timeout: 30000,
      exact: true
    });

    await sleep(1000);
    await this.saveScreenshot('role-selected.png');

    console.log('🚪 Klik tombol Masuk Sekarang...');
    await this.clickElementByText('Masuk Sekarang', {
      timeout: 30000,
      exact: false,
      preferInteractive: true
    });

    await this.page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: 10000
    }).catch(() => {
      console.log('⚠️ Tidak ada navigasi setelah pilih role, lanjut cek halaman saat ini');
    });

    await sleep(3000);
    await this.saveScreenshot('after-role-enter.png');
  }

  buildDetailUrl(pengajuanId) {
    const webOrigin = new URL(this.config.webUrl).origin;
    const detailUrl = new URL(`/detailberkasasesi/${pengajuanId}`, webOrigin);
    detailUrl.searchParams.set('lsp_id', this.config.lspId);
    return detailUrl.toString();
  }

  getSubmissionFormCode(submission) {
    return submission?.template?.kode
      || submission?.meta_json?.form
      || submission?.kode
      || submission?.template?.code
      || '';
  }

  getSubmissionPengajuanId(submission) {
    return submission?.pengajuan_id || submission?.pengajuan?.id || '';
  }

  sanitizeFilename(value) {
    return String(value || 'unknown')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  }

  getSubmissionId(submission) {
    return submission?.id || '';
  }

  listDownloadedFiles() {
    this.ensureDownloadDir();
    return fs.readdirSync(this.downloadDir)
      .filter((filename) => !filename.endsWith('.crdownload') && !filename.endsWith('.tmp'))
      .map((filename) => {
        const filePath = path.join(this.downloadDir, filename);
        const stat = fs.statSync(filePath);
        return {
          filename,
          path: filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          isFile: stat.isFile()
        };
      })
      .filter((file) => file.isFile);
  }

  async waitForNewDownload(knownFiles, startedAt, timeout = this.config.downloadTimeoutMs) {
    const known = new Set(knownFiles.map((file) => file.path));
    const startedMs = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const files = this.listDownloadedFiles()
        .filter((file) => !known.has(file.path) || file.mtimeMs >= startedMs - 1000)
        .filter((file) => file.mtimeMs >= startedMs - 1000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      const finishedFile = files.find((file) => {
        const temporaryPath = `${file.path}.crdownload`;
        return file.size > 0 && !fs.existsSync(temporaryPath);
      });

      if (finishedFile) {
        console.log(`✅ File PDF terdownload: ${finishedFile.path}`);
        return finishedFile.path;
      }

      await sleep(500);
    }

    throw new Error(`Download PDF tidak selesai dalam ${timeout}ms`);
  }

  async findFormRowIndexByCode(formCode, timeout = 30000) {
    const startedAt = Date.now();
    let lastReason = '';

    while (Date.now() - startedAt < timeout) {
      const result = await this.page.evaluate((targetCode) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const normalizedCode = normalize(targetCode);
        const rows = Array.from(document.querySelectorAll('tbody tr'));
        const rowIndex = rows.findIndex((candidateRow) => {
          const cells = Array.from(candidateRow.querySelectorAll('td'));
          return cells.some((cell) => normalize(cell.innerText || cell.textContent) === normalizedCode);
        });

        if (rowIndex === -1) {
          return { ok: false, reason: `row kode ${targetCode} belum ditemukan` };
        }

        return { ok: true, rowIndex };
      }, formCode).catch((error) => ({
        ok: false,
        reason: error.message
      }));

      if (result.ok) {
        return result.rowIndex;
      }

      lastReason = result.reason;
      await sleep(500);
    }

    throw new Error(`Gagal menemukan row form ${formCode}. ${lastReason}`.trim());
  }

  async clickGeneratePdfByCode(formCode, timeout = 30000) {
    const rowIndex = await this.findFormRowIndexByCode(formCode, timeout);
    const rows = await this.page.$$('tbody tr');
    const row = rows[rowIndex];

    if (!row) {
      throw new Error(`Row form ${formCode} tidak ditemukan setelah render ulang`);
    }

    await row.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await sleep(500);

    const dropdownButton = await row.$('[data-bs-toggle="dropdown"]')
      || await row.$('button[title*="Aksi" i]')
      || await row.$('.dropdown button');

    if (!dropdownButton) {
      throw new Error(`Tombol titik tiga untuk form ${formCode} tidak ditemukan`);
    }

    await dropdownButton.click();
    console.log(`✅ Klik titik tiga untuk form ${formCode} berhasil`);
    await sleep(500);
    await this.saveScreenshot(`dropdown-${this.sanitizeFilename(formCode)}.png`);

    try {
      await this.clickElementByText('Generate PDF', {
        timeout,
        exact: false,
        preferInteractive: true
      });
    } catch (error) {
      throw new Error(`Menu Generate PDF tidak tersedia untuk form ${formCode}. Cek status form di screenshot dropdown-${this.sanitizeFilename(formCode)}.png`);
    }
  }

  async generatePdfByCode(formCode) {
    const knownFiles = this.listDownloadedFiles();
    const startedAt = Date.now();

    await this.clickGeneratePdfByCode(formCode);

    return this.waitForNewDownload(knownFiles, startedAt);
  }

  buildAttachmentUploadPaths(submissionId) {
    const id = encodeURIComponent(submissionId);
    const configuredPath = this.config.attachmentUploadPath.trim();
    const defaultPaths = [
      '/api/submissions/:id/attachment',
      '/api/submission/:id/attachment'
    ];

    const paths = configuredPath ? [configuredPath] : defaultPaths;

    return paths.map((uploadPath) => uploadPath
      .replace(':id', id)
      .replace('{id}', id)
      .replace('/id/', `/${id}/`));
  }

  buildApiUrl(endpointPath) {
    const baseUrl = this.config.apiBaseUrl.replace(/\/+$/, '');
    const normalizedPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
    const url = new URL(`${baseUrl}${normalizedPath}`);
    url.searchParams.set('lsp_id', this.config.lspId);
    return url.toString();
  }

  buildMultipartHeaders(form) {
    const headers = {
      ...form.getHeaders(),
      'Accept': 'application/json',
      'X-SECRET-BOT': this.config.secretBot
    };

    if (this.cookies && this.cookies.length > 0) {
      headers.Cookie = this.cookies
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
    }

    return headers;
  }

  async uploadAttachmentToPath(endpointPath, filePath) {
    const url = this.buildApiUrl(endpointPath);
    const form = new FormData();
    form.append('attachment', fs.createReadStream(filePath), path.basename(filePath));

    console.log(`⬆️ Upload attachment ke: ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildMultipartHeaders(form),
      body: form
    });

    const responseText = await response.text();
    let responseBody = responseText;

    try {
      responseBody = responseText ? JSON.parse(responseText) : {};
    } catch (error) {
      // Response bukan JSON, tetap simpan sebagai text untuk debug.
    }

    if (!response.ok) {
      const message = typeof responseBody === 'string'
        ? responseBody
        : JSON.stringify(responseBody);
      const error = new Error(`Upload attachment gagal: ${response.status} ${response.statusText} - ${message}`);
      error.status = response.status;
      throw error;
    }

    console.log('✅ Attachment berhasil di-upload');
    return responseBody;
  }

  async uploadAttachment(submissionId, filePath) {
    const uploadPaths = this.buildAttachmentUploadPaths(submissionId);
    let lastError = null;

    for (const endpointPath of uploadPaths) {
      try {
        return await this.uploadAttachmentToPath(endpointPath, filePath);
      } catch (error) {
        lastError = error;

        if (error.status === 404 && endpointPath !== uploadPaths[uploadPaths.length - 1]) {
          console.log(`⚠️ Endpoint ${endpointPath} 404, coba path berikutnya...`);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  async openSubmissionForm(submission, index, total) {
    const submissionId = this.getSubmissionId(submission);
    const pengajuanId = this.getSubmissionPengajuanId(submission);
    const formCode = this.getSubmissionFormCode(submission);

    if (!submissionId) {
      throw new Error(`Submission ke-${index} tidak punya id submission`);
    }

    if (!pengajuanId) {
      throw new Error(`Submission ke-${index} tidak punya pengajuan_id`);
    }

    if (!formCode) {
      throw new Error(`Submission ke-${index} tidak punya kode form`);
    }

    const detailUrl = this.buildDetailUrl(pengajuanId);
    const safeFormCode = this.sanitizeFilename(formCode);

    console.log(`\n📄 Membuka detail berkas ${index}/${total}`);
    console.log(`🆔 Submission ID: ${submissionId}`);
    console.log(`🧾 Pengajuan ID: ${pengajuanId}`);
    console.log(`🧩 Kode form: ${formCode}`);
    console.log(`🔗 URL: ${detailUrl}`);

    await this.page.goto(detailUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await this.page.waitForSelector('tbody tr', { timeout: 30000 });
    await sleep(1000);
    await this.saveScreenshot(`detail-${pengajuanId}-${safeFormCode}.png`);

    const downloadedFile = await this.generatePdfByCode(formCode);
    const uploadResult = await this.uploadAttachment(submissionId, downloadedFile);

    await this.saveToFile(uploadResult, `upload-${submissionId}-${safeFormCode}.json`);
  }

  async openFormsFromSubmissions(apiData) {
    const submissions = Array.isArray(apiData?.data) ? apiData.data : [];

    if (submissions.length === 0) {
      console.log('\nℹ️ Tidak ada submission dari API, tidak ada form yang dibuka');
      return;
    }

    console.log(`\n🧭 Membuka ${submissions.length} form sesuai data API...`);

    for (let index = 0; index < submissions.length; index++) {
      await this.openSubmissionForm(submissions[index], index + 1, submissions.length);
    }
  }

  /**
   * Inisialisasi browser Chromium
   */
  async initBrowser() {
    console.log('🚀 Memulai browser Chromium...');
    this.browser = await puppeteer.launch({
      headless: false, // Set true untuk headless mode
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
    
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1366, height: 768 });
    await this.configureDownloads();
    
    console.log('✅ Browser berhasil diinisialisasi');
  }

  async configureDownloads() {
    this.ensureDownloadDir();

    const client = await this.page.target().createCDPSession();

    try {
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.downloadDir
      });
    } catch (pageError) {
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.downloadDir
      });
    }

    console.log(`📥 Folder download: ${this.downloadDir}`);
  }

  /**
   * Login ke aplikasi web
   */
  async loginToWeb() {
    try {
      console.log(`\n🔐 Melakukan login ke ${this.config.webUrl}...`);
      await this.page.goto(this.config.webUrl, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });

      // Tunggu halaman login muncul
      await sleep(2000);

      // Screenshot sebelum login untuk debug
      await this.saveScreenshot('login-page.png');

      // Cari input email/username (sesuaikan selector dengan website)
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[id="email"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="username" i]'
      ];

      let emailInput = null;
      for (const selector of emailSelectors) {
        try {
          emailInput = await this.page.$(selector);
          if (emailInput) {
            console.log(`✅ Input email ditemukan: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!emailInput) {
        throw new Error('Input email tidak ditemukan. Periksa selector!');
      }

      // Isi email
      await emailInput.type(this.config.email, { delay: 100 });
      console.log(`📝 Email diisi: ${this.config.email}`);

      // Cari input password
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        'input[id="password"]'
      ];

      let passwordInput = null;
      for (const selector of passwordSelectors) {
        try {
          passwordInput = await this.page.$(selector);
          if (passwordInput) {
            console.log(`✅ Input password ditemukan: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!passwordInput) {
        throw new Error('Input password tidak ditemukan. Periksa selector!');
      }

      // Isi password
      await passwordInput.type(this.config.password, { delay: 100 });
      console.log('📝 Password diisi');

      // Cari tombol login/submit
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button.btn-login',
        'button#login'
      ];

      let submitButton = null;
      for (const selector of submitSelectors) {
        try {
          submitButton = await this.page.$(selector);
          if (submitButton) {
            console.log(`✅ Tombol submit ditemukan: ${selector}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!submitButton) {
        console.log('⚠️ Tombol submit tidak ditemukan, mencoba tombol teks Login/Masuk...');
        try {
          await this.clickElementByText('Login', {
            timeout: 5000,
            exact: false,
            preferInteractive: true
          });
        } catch (loginButtonError) {
          try {
            await this.clickElementByText('Masuk', {
              timeout: 5000,
              exact: false,
              preferInteractive: true
            });
          } catch (masukButtonError) {
            // Coba submit dengan Enter
            console.log('⚠️ Tombol Login/Masuk tidak ditemukan, mencoba tekan Enter...');
            await passwordInput.press('Enter');
          }
        }
      } else {
        await submitButton.click();
      }

      console.log('🔄 Menunggu proses login...');

      // Tunggu navigasi atau redirect setelah login
      await this.page.waitForNavigation({ 
        waitUntil: 'networkidle2',
        timeout: 30000 
      }).catch(() => {
        console.log('⚠️ Tidak ada navigasi, mungkin sudah di halaman yang benar');
      });

      await sleep(3000);

      // Screenshot setelah login
      await this.saveScreenshot('after-login.png');

      // Pilih role Super Admin lalu masuk ke dashboard
      await this.selectRoleAndEnter();

      // Cek apakah login berhasil dengan mencari elemen yang menandakan user sudah login
      const currentUrl = this.page.url();
      console.log(`📍 URL saat ini: ${currentUrl}`);

      // Ambil cookies untuk digunakan di API request
      const cookies = await this.page.cookies();
      this.cookies = cookies;
      console.log(`🍪 Berhasil mengambil ${cookies.length} cookies`);

      console.log('✅ Login berhasil!\n');
      return true;

    } catch (error) {
      console.error('❌ Error saat login:', error.message);
      try {
        if (this.page) {
          await this.saveScreenshot('error-login.png');
        }
      } catch (screenshotError) {
        console.error('⚠️ Gagal menyimpan screenshot error:', screenshotError.message);
      }
      throw error;
    }
  }

  /**
   * Fetch API Backend dengan autentikasi
   */
  async fetchApiData() {
    try {
      const endpoint = '/api-bots';
      
      const url = `${this.config.apiBaseUrl}${endpoint}?lsp_id=${this.config.lspId}&page=${this.config.page}&limit=${this.config.limit}`;
      
      console.log(`\n🌐 Mengakses API: ${endpoint}`);
      console.log(`📡 URL: ${url}`);

      // Pilih metode autentikasi (gunakan salah satu)
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // Metode 1: Menggunakan X-SECRET-BOT
        'X-SECRET-BOT': this.config.secretBot,
        // Metode 2: Menggunakan Authorization Bearer (uncomment jika ingin pakai ini)
        // 'Authorization': `Bearer ${this.config.secretBot}`,
      };

      // Jika ada cookies dari login browser, tambahkan
      if (this.cookies && this.cookies.length > 0) {
        const cookieString = this.cookies
          .map(cookie => `${cookie.name}=${cookie.value}`)
          .join('; ');
        headers['Cookie'] = cookieString;
        console.log('🍪 Cookies browser ditambahkan ke request');
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: headers
      });

      console.log(`📊 Status Response: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ API Error: ${errorText}`);
        throw new Error(`API request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log('✅ Data berhasil diambil dari API');
      console.log(`📦 Jumlah data: ${data.data?.length || 0} items`);
      
      return data;

    } catch (error) {
      console.error('❌ Error saat fetch API:', error.message);
      throw error;
    }
  }

  /**
   * Menyimpan hasil API ke file
   */
  async saveToFile(data, filename = 'api-result.json') {
    const path = this.getOutputPath(filename);
    
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
    console.log(`💾 Data tersimpan di: ${path}`);
  }

  /**
   * Jalankan bot lengkap
   */
  async run() {
    try {
      console.log('=' .repeat(60));
      console.log('🤖 DITEKINDO BOT - START');
      console.log('=' .repeat(60));

      // 1. Inisialisasi browser
      await this.initBrowser();

      // 2. Login ke web
      await this.loginToWeb();

      // 3. Fetch data dari API
      const apiData = await this.fetchApiData();
      await this.saveToFile(apiData, 'api-bots-result.json');

      // 4. Buka detail berkas dan form terkait sesuai submission
      await this.openFormsFromSubmissions(apiData);

      console.log('\n' + '='.repeat(60));
      console.log('✅ BOT SELESAI - Semua proses berhasil!');
      console.log('='.repeat(60));

      // Tunggu sebentar sebelum tutup browser (opsional)
      await sleep(5000);

    } catch (error) {
      console.error('\n❌ BOT ERROR:', error.message);
      console.error(error.stack);
    } finally {
      if (this.browser) {
        await this.browser.close();
        console.log('\n👋 Browser ditutup');
      }
    }
  }

  /**
   * Alternatif: Hanya fetch API tanpa login browser
   * (jika token sudah cukup tanpa cookies)
   */
  async runApiOnly() {
    try {
      console.log('=' .repeat(60));
      console.log('🤖 DITEKINDO BOT - API ONLY MODE');
      console.log('=' .repeat(60));

      // Fetch data dari API
      const apiData = await this.fetchApiData();
      await this.saveToFile(apiData, 'api-bots-result.json');

      console.log('\n' + '='.repeat(60));
      console.log('✅ API FETCH SELESAI!');
      console.log('='.repeat(60));

    } catch (error) {
      console.error('\n❌ ERROR:', error.message);
      console.error(error.stack);
    }
  }
}

// Jalankan bot
(async () => {
  const bot = new DitekindoBot();
  
  // Pilih mode:
  // 1. Mode lengkap (browser login + API fetch)
  await bot.run();
  
  // 2. Mode API only (tanpa browser login)
  // await bot.runApiOnly();
})();
