require('dotenv').config();
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
};

const parsePositiveInteger = (value, defaultValue, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.min(Math.floor(parsed), max);
};

class DitekindoBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cookies = null;
    this.authToken = null;
    this.outputDir = path.join(__dirname, 'output');
    this.downloadDir = path.join(this.outputDir, 'downloads');
    const fastMode = parseBoolean(process.env.FAST_MODE, true);
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
      limit: process.env.LIMIT || '100',
      concurrency: parsePositiveInteger(process.env.CONCURRENCY, 10, 100),
      autoDeleteUploadedFiles: parseBoolean(
        process.env.AUTO_DELETE_UPLOADED_FILES ?? process.env.AUTO_DELETE_AFTER_UPLOAD,
        true
      ),
      saveScreenshots: parseBoolean(process.env.SAVE_SCREENSHOTS ?? process.env.SCREENSHOTS, false),
      fastMode,
      headless: parseBoolean(process.env.HEADLESS, true),
      navigationWaitUntil: process.env.NAVIGATION_WAIT_UNTIL || (fastMode ? 'domcontentloaded' : 'networkidle2'),
      clickPollMs: parsePositiveInteger(process.env.CLICK_POLL_MS, fastMode ? 80 : 300, 1000),
      downloadPollMs: parsePositiveInteger(process.env.DOWNLOAD_POLL_MS, fastMode ? 150 : 400, 5000),
      shortPauseMs: parsePositiveInteger(process.env.SHORT_PAUSE_MS, fastMode ? 50 : 300, 2000),
      loginTransitionTimeoutMs: parsePositiveInteger(process.env.LOGIN_TRANSITION_TIMEOUT_MS, fastMode ? 8000 : 30000, 60000),
      elementTimeoutMs: parsePositiveInteger(process.env.ELEMENT_TIMEOUT_MS, fastMode ? 30000 : 45000, 90000),
      detailReadyTimeoutMs: parsePositiveInteger(process.env.DETAIL_READY_TIMEOUT_MS, fastMode ? 45000 : 60000, 120000),
      detailRetryCount: parsePositiveInteger(process.env.DETAIL_RETRY_COUNT, 2, 5),
      groupByPengajuan: parseBoolean(process.env.GROUP_BY_PENGAJUAN, true),
      stopOnEmptySuccessBatch: parseBoolean(process.env.STOP_ON_EMPTY_SUCCESS_BATCH, true),
      maxPages: Number(process.env.MAX_PAGES || 0),
      blockHeavyResources: parseBoolean(process.env.BLOCK_HEAVY_RESOURCES, false)
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
    return this.savePageScreenshot(this.page, filename);
  }

  async savePageScreenshot(page, filename) {
    if (!this.config.saveScreenshots || !page) {
      return null;
    }

    const screenshotPath = this.getOutputPath(filename);
    await page.screenshot({ path: screenshotPath });
    console.log(`📸 Screenshot tersimpan: ${screenshotPath}`);
    return screenshotPath;
  }

  deleteUploadedFile(filePath) {
    if (!this.config.autoDeleteUploadedFiles || !filePath) {
      return false;
    }

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🧹 File lokal dihapus setelah upload: ${filePath}`);
        return true;
      }
    } catch (error) {
      console.log(`⚠️ Gagal hapus file lokal ${filePath}: ${error.message}`);
    }

    return false;
  }

  deleteEmptyDirectory(dirPath) {
    if (!this.config.autoDeleteUploadedFiles || !dirPath) {
      return false;
    }

    try {
      if (fs.existsSync(dirPath) && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
        return true;
      }
    } catch (_) {}

    return false;
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

      await sleep(this.config.clickPollMs);
    }

    throw new Error(`Elemen dengan teks "${text}" tidak ditemukan. ${lastResult?.reason || ''}`.trim());
  }

  async selectRoleAndEnter() {
    console.log(`\n🎭 Memilih role ${this.config.roleName}...`);
    const roleSelected = await this._selectRoleIfPresent(this.page, 30000);
    await this.saveScreenshot('role-selected.png');

    await sleep(this.config.shortPauseMs);
    await this.saveScreenshot('after-role-enter.png');

    if (!roleSelected) {
      throw new Error(`Gagal memilih role "${this.config.roleName}"`);
    }
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

      await sleep(this.config.downloadPollMs);
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
      await sleep(this.config.clickPollMs);
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
    await sleep(this.config.shortPauseMs);

    const dropdownButton = await row.$('[data-bs-toggle="dropdown"]')
      || await row.$('button[title*="Aksi" i]')
      || await row.$('.dropdown button');

    if (!dropdownButton) {
      throw new Error(`Tombol titik tiga untuk form ${formCode} tidak ditemukan`);
    }

    await dropdownButton.click();
    console.log(`✅ Klik titik tiga untuk form ${formCode} berhasil`);
    await sleep(this.config.shortPauseMs);
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
      '/api/apl/submissions/:id/attachment',
      '/api/apl/submission/:id/attachment'
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

  buildMultipartHeaders(form, optionalAuth) {
    const effectiveCookies = Array.isArray(optionalAuth)
      ? optionalAuth
      : (optionalAuth?.cookies || this.cookies || []);
    const effectiveAuthToken = optionalAuth?.authToken
      || (Array.isArray(optionalAuth) ? optionalAuth.authToken : '')
      || this.authToken;

    const headers = {
      ...form.getHeaders(),
      'Accept': 'application/json',
      'X-SECRET-BOT': this.config.secretBot
    };

    if (effectiveAuthToken) {
      headers['Authorization'] = `Bearer ${effectiveAuthToken}`;
    }

    if (effectiveCookies.length > 0) {
      headers.Cookie = effectiveCookies
        .filter(c => c?.name && c?.value !== undefined && c.name !== 'Cookie' && c.name !== 'cookie')
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
    }

    return headers;
  }

  async uploadAttachmentToPath(endpointPath, filePath, freshAuth) {
    const url = this.buildApiUrl(endpointPath);
    const form = new FormData();
    form.append('attachment', fs.createReadStream(filePath), path.basename(filePath));

    console.log(`⬆️ Upload ke: ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildMultipartHeaders(form, freshAuth),
      body: form
    });

    const responseText = await response.text();
    let responseBody = {};
    try { if (responseText) responseBody = JSON.parse(responseText); } catch (_) {}

    if (!response.ok) {
      const msg = typeof responseBody === 'object' ? JSON.stringify(responseBody) : responseText;
      const err = new Error(`Upload gagal: ${response.status} ${response.statusText} - ${msg}`);
      err.status = response.status;
      throw err;
    }

    console.log('✅ Attachment berhasil di-upload');
    return responseBody;
  }

  async uploadAttachment(submissionId, filePath, freshAuth) {
    const uploadPaths = this.buildAttachmentUploadPaths(submissionId);
    let lastError = null;

    for (const endpointPath of uploadPaths) {
      try {
        return await this.uploadAttachmentToPath(endpointPath, filePath, freshAuth);
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
      waitUntil: this.config.navigationWaitUntil,
      timeout: 60000
    });

    await this.page.waitForSelector('tbody tr', { timeout: 30000 });
    await sleep(this.config.shortPauseMs);
    await this.saveScreenshot(`detail-${pengajuanId}-${safeFormCode}.png`);

    const downloadedFile = await this.generatePdfByCode(formCode);
    const uploadResult = await this.uploadAttachment(submissionId, downloadedFile);

    this.deleteUploadedFile(downloadedFile);
    await this.saveToFile(uploadResult, `upload-${submissionId}-${safeFormCode}.json`);
  }

  async openFormsFromSubmissions(apiData) {
    const submissions = Array.isArray(apiData?.data) ? apiData.data : [];

    if (submissions.length === 0) {
      console.log('\nℹ️ Tidak ada submission dari API, tidak ada form yang dibuka');
      return;
    }

    await this._processSubmissionsIndependent(submissions, Number(this.config.page));
  }

  /**
   * Inisialisasi browser Chromium
   */
  async initBrowser() {
    console.log('🚀 Memulai browser Chromium...');
    this.browser = await puppeteer.launch({
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
    
    this.page = await this.browser.newPage();
    await this._optimizePage(this.page);
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
        waitUntil: this.config.navigationWaitUntil,
        timeout: 60000 
      });

      // Tunggu halaman login muncul
      await sleep(this.config.shortPauseMs);

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
      await this._setInputValue(emailInput, this.config.email);
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
      await this._setInputValue(passwordInput, this.config.password);
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
        waitUntil: this.config.navigationWaitUntil,
        timeout: 30000 
      }).catch(() => {
        console.log('⚠️ Tidak ada navigasi, mungkin sudah di halaman yang benar');
      });

      await sleep(this.config.shortPauseMs);

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

      // Ambil token dari localStorage (jwt token)
      try {
        this.authToken = await this.page.evaluate(() => {
          return localStorage.getItem('token')
            || localStorage.getItem('access_token')
            || localStorage.getItem('jwt')
            || sessionStorage.getItem('token')
            || sessionStorage.getItem('access_token')
            || '';
        });
        if (this.authToken) {
          console.log('🔑 Token autentikasi berhasil diambil dari localStorage');
        } else {
          console.log('⚠️ Token tidak ditemukan di localStorage, cek cookie mungkin token ada di cookie');
        }
      } catch (e) {
        console.log('⚠️ Gagal mengambil token dari localStorage:', e.message);
        this.authToken = '';
      }

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
   * Upload PDF ke API dengan fresh cookies dari Chromium lane ini
   */
  async _uploadAttachment(submissionId, filePath, freshAuth) {
    return this.uploadAttachment(submissionId, filePath, freshAuth);
  }

  async saveToFile(data, filename = 'api-result.json') {
    const outputPath = this.getOutputPath(filename);
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
    console.log(`💾 Data tersimpan di: ${outputPath}`);
  }

  summarizeRows(rows) {
    return rows.reduce((summary, row) => {
      const status = row?.status || 'unknown';
      summary.total += 1;
      summary[status] = (summary[status] || 0) + 1;
      return summary;
    }, { total: 0, ok: 0, error: 0, skipped: 0, unknown: 0 });
  }

  logBatchSummary(pageNumber, summary) {
    console.log(
      `\n📊 Ringkasan halaman ${pageNumber}: ` +
      `OK=${summary.ok || 0}, ERROR=${summary.error || 0}, SKIP=${summary.skipped || 0}, TOTAL=${summary.total || 0}`
    );
  }

  groupSubmissionsByPengajuan(submissions) {
    const groupsByKey = new Map();

    submissions.forEach((submission, originalIndex) => {
      const pengajuanId = this.getSubmissionPengajuanId(submission) || `missing-${originalIndex}`;
      const key = String(pengajuanId);

      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          pengajuanId,
          submissions: []
        });
      }

      groupsByKey.get(key).submissions.push({ submission, originalIndex });
    });

    return Array.from(groupsByKey.values());
  }

  /**
   * ════════════════════════════════════════════════════════════════════
   *  WORKER-LANE ENGINE  —  SATU CHROMIUM PER SUBMISSION
   *
   *  Prinsip desain:
   *    • Setiap (chromium instance + page + cookies) = "lane" = "jalan"
   *    • Jalan tidak dibagi, tidak dishare, tidak di-reuse antar submission
   *    • Login dilakukan di setiap jalan secara independen
   *    • CONCURRENCY = jumlah jalan yang jalan BERSAMAAN di 1 halaman
   *    • Global while-loop: loop till API kosong
   * ════════════════════════════════════════════════════════════════════
   */

  /**
   * Fetch 1 halaman API lalu spawn CONCURRENCY Chromium independen
   * untuk memproses submission di halaman tersebut.
   *
   * @param {number} pageNumber
   * @returns {{rows: Array, isLastPage: boolean}}
   */
  async _fetchPageAndProcess(pageNumber) {
    const lspId = this.config.lspId;
    const limit  = this.config.limit;

    const url = `${this.config.apiBaseUrl}/api-bots?lsp_id=${lspId}&page=${pageNumber}&limit=${limit}`;
    console.log(`\n📄 Halaman ${pageNumber} | ${url}`);
    console.log(`   CONCURRENCY: ${this.config.concurrency}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-SECRET-BOT': this.config.secretBot,
        ...(this.cookies ? { Cookie: this.cookies.map(c => `${c.name}=${c.value}`).join('; ') } : {}),
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} - ${errorText}`);
    }

    const apiData = await response.json();
    const submissions = Array.isArray(apiData?.data) ? apiData.data : [];

    if (submissions.length === 0) {
      console.log(`\nℹ️ Halaman ${pageNumber} kosong – tidak ada submission lagi.`);
      return { rows: [], isLastPage: true };
    }

    const groupCount = this.config.groupByPengajuan
      ? this.groupSubmissionsByPengajuan(submissions).length
      : submissions.length;
    console.log(
      `   ✅ ${submissions.length} submission. ` +
      `Spawn ${Math.min(groupCount, this.config.concurrency)} Chromium untuk ${groupCount} lane …`
    );

    const rows = await this._processSubmissionsIndependent(submissions, pageNumber);
    const summary = this.summarizeRows(rows);
    this.logBatchSummary(pageNumber, summary);
    await this.saveToFile(rows, `api-bots-page-${pageNumber}-process-result.json`);

    return { rows, summary, isLastPage: submissions.length < Number(limit) };
  }

  /**
   * Jalankan tiap submission di CHROMIUM SENDIRI.
   * Tidak ada shared browser, tidak ada shared page, tidak ada shared cookies.
   *
   * @param {Array}  submissions
   * @param {number} pageNumber
   * @returns {Array} ringkasan hasil per submission
   */
  async _processSubmissionsIndependent(submissions, pageNumber = 1) {
    if (this.config.groupByPengajuan) {
      return this._processSubmissionGroups(submissions, pageNumber);
    }

    const workerCount = Math.min(this.config.concurrency, submissions.length);
    const results = new Array(submissions.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= submissions.length) break;

        results[currentIndex] = await this._runSingleSubmission(
          submissions[currentIndex],
          currentIndex + 1,
          submissions.length,
          pageNumber
        );
      }
    });

    await Promise.all(workers);
    return results;
  }

  async _processSubmissionGroups(submissions, pageNumber = 1) {
    const groups = this.groupSubmissionsByPengajuan(submissions);
    const workerCount = Math.min(this.config.concurrency, groups.length);
    const results = new Array(submissions.length);
    let nextGroupIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentGroupIndex = nextGroupIndex++;
        if (currentGroupIndex >= groups.length) break;

        const groupRows = await this._runSubmissionGroup(
          groups[currentGroupIndex],
          currentGroupIndex + 1,
          groups.length,
          pageNumber
        );

        groupRows.forEach((row) => {
          results[row.originalIndex] = row.result;
        });
      }
    });

    await Promise.all(workers);
    return results;
  }

  async _runSubmissionGroup(group, groupIndex, totalGroups, pageNumber = 1) {
    const validItems = group.submissions.filter(({ submission }) =>
      this.getSubmissionId(submission)
      && this.getSubmissionPengajuanId(submission)
      && this.getSubmissionFormCode(submission)
    );
    const invalidRows = group.submissions
      .filter(({ submission }) =>
        !this.getSubmissionId(submission)
        || !this.getSubmissionPengajuanId(submission)
        || !this.getSubmissionFormCode(submission)
      )
      .map(({ submission, originalIndex }) => ({
        originalIndex,
        result: {
          submissionId: this.getSubmissionId(submission) || '?',
          pengajuanId: this.getSubmissionPengajuanId(submission) || '?',
          formCode: this.getSubmissionFormCode(submission) || '?',
          status: 'skipped',
          reason: 'Data submission tidak lengkap'
        }
      }));

    if (validItems.length === 0) {
      return invalidRows;
    }

    const firstSubmission = validItems[0].submission;
    const pengajuanId = this.getSubmissionPengajuanId(firstSubmission);
    const detailUrl = this.buildDetailUrl(pengajuanId);
    const formCodes = validItems.map(({ submission }) => this.getSubmissionFormCode(submission));
    const downloadDir = path.join(
      this.outputDir,
      `dl-pengajuan-${this.sanitizeFilename(pengajuanId)}-${Date.now()}-${groupIndex}`
    );

    console.log(
      `\n📚 [group ${groupIndex}/${totalGroups} hal.${pageNumber}] ` +
      `Chromium BARU | pengajuan=${pengajuanId} | ${validItems.length} form`
    );
    console.log(`   🧩 ${formCodes.join(', ')}`);
    console.log(`   🔗 ${detailUrl}`);

    let browser = null;
    let page = null;
    const rows = [...invalidRows];

    try {
      browser = await puppeteer.launch({
        headless: this.config.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
        ],
      });
      page = await browser.newPage();
      await this._optimizePage(page);
      await page.setViewport({ width: 1366, height: 768 });

      fs.mkdirSync(downloadDir, { recursive: true });
      const cdpSession = await page.target().createCDPSession();
      await cdpSession.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
      await cdpSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      let myAuth = await this._loginAndGetCookies(page);
      await this._openDetailPage(page, detailUrl, pengajuanId);
      myAuth = await this._getPageAuth(page);

      for (const { submission, originalIndex } of validItems) {
        const submissionId = this.getSubmissionId(submission);
        const formCode = this.getSubmissionFormCode(submission);
        const safeFormCode = this.sanitizeFilename(formCode);

        try {
          const downloadStartedAt = new Date();
          await this._hoverAndGeneratePdf(page, formCode);
          const pdfPath = await this._waitForNewDownload(downloadDir, downloadStartedAt);
          const uploadResult = await this._uploadAttachment(submissionId, pdfPath, myAuth);
          const deletedLocalFile = this.deleteUploadedFile(pdfPath);

          try { await this.savePageScreenshot(page, `ok-${submissionId}-${safeFormCode}.png`); } catch (_) {}
          console.log(`   ✅ submission=${submissionId} form=${formCode}`);

          rows.push({
            originalIndex,
            result: { submissionId, pengajuanId, formCode, status: 'ok', deletedLocalFile, uploadResult }
          });
        } catch (error) {
          console.error(`   ❌ submission=${submissionId}: ${error.message}`);
          try { await this.savePageScreenshot(page, `err-${submissionId}-${safeFormCode}.png`); } catch (_) {}

          rows.push({
            originalIndex,
            result: { submissionId, pengajuanId, formCode, status: 'error', reason: error.message }
          });
        }
      }

      this.deleteEmptyDirectory(downloadDir);
      return rows;
    } catch (error) {
      console.error(`   ❌ pengajuan=${pengajuanId}: ${error.message}`);

      validItems.forEach(({ submission, originalIndex }) => {
        rows.push({
          originalIndex,
          result: {
            submissionId: this.getSubmissionId(submission),
            pengajuanId,
            formCode: this.getSubmissionFormCode(submission),
            status: 'error',
            reason: error.message
          }
        });
      });

      try { await this.savePageScreenshot(page, `err-pengajuan-${this.sanitizeFilename(pengajuanId)}.png`); } catch (_) {}
      return rows;
    } finally {
      if (page) { try { await page.close(); } catch (_) {} }
      if (browser) { try { await browser.close(); } catch (_) {} }
    }
  }

  /**
   * SATU JALAN = SATU CHROMIUM BARU = SATU SUBMISSION
   *
   * Alur per jalan:
   *   1. Launch Chromium baru  ← milik submission ini saja
   *   2. Buka web → login    ← cookies hanya untuk jalan ini
   *   3. Goto detail URL
   *   4. Generate PDF
   *   5. Upload attachment
   *   6. Tutup Chromium      ← dibersihkan sepenuhnya
   *
   * @param {Object} submission
   * @param {number} index
   * @param {number} total
   * @param {number} pageNumber
   * @returns {Object} ringkasan hasil
   */
  async _runSingleSubmission(submission, index, total, pageNumber = 1) {
    const submissionId = this.getSubmissionId(submission);
    const pengajuanId  = this.getSubmissionPengajuanId(submission);
    const formCode     = this.getSubmissionFormCode(submission);
    const safeFormCode = this.sanitizeFilename(formCode);
    const detailUrl    = this.buildDetailUrl(pengajuanId);
    const downloadDir  = path.join(
      this.outputDir,
      `dl-${this.sanitizeFilename(submissionId)}-${Date.now()}-${index}`
    );

    if (!submissionId || !pengajuanId || !formCode) {
      const msg = `Submission ${index}/${total} hal.${pageNumber} data tidak lengkap ` +
                  `(id=${!!submissionId} pengajuan=${!!pengajuanId} kode=${!!formCode})`;
      console.error(`❌ ${msg}`);
      return { submissionId: submissionId || '?', pengajuanId: pengajuanId || '?',
               formCode: formCode || '?', status: 'skipped', reason: msg };
    }

    console.log(`\n📄 [${index}/${total} hal.${pageNumber}] Chromium BARU | submission=${submissionId} form=${formCode}`);
    console.log(`   🔗 ${detailUrl}`);

    let browser = null;
    let page    = null;

    try {
      // ① Launch Chromium baru — hanya untuk submission ini
      browser = await puppeteer.launch({
        headless: this.config.headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-sync',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
        ],
      });
      page = await browser.newPage();
      await this._optimizePage(page);
      await page.setViewport({ width: 1366, height: 768 });

      // ② Setup download di folder sendiri
      fs.mkdirSync(downloadDir, { recursive: true });
      const cdpSession = await page.target().createCDPSession();
      await cdpSession.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
      await cdpSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

      // ③ Login dan ambil cookies untuk jalan ini
      let myAuth = await this._loginAndGetCookies(page);

      // ④ Navigasi ke detail + Generate PDF + Download
      const downloadStartedAt = new Date();
      await this._openDetailPage(page, detailUrl, pengajuanId);
      myAuth = await this._getPageAuth(page);

      await this._hoverAndGeneratePdf(page, formCode);
      const pdfPath = await this._waitForNewDownload(downloadDir, downloadStartedAt);

      // ⑤ Upload attachment menggunakan cookies kepala sendiri
      const uploadResult = await this._uploadAttachment(submissionId, pdfPath, myAuth);
      const deletedLocalFile = this.deleteUploadedFile(pdfPath);
      this.deleteEmptyDirectory(downloadDir);

      try { await this.savePageScreenshot(page, `ok-${submissionId}-${safeFormCode}.png`); } catch (_) {}
      console.log(`   ✅ submission=${submissionId} form=${formCode}`);
      return { submissionId, pengajuanId, formCode, status: 'ok', deletedLocalFile, uploadResult };

    } catch (error) {
      console.error(`   ❌ submission=${submissionId}: ${error.message}`);
      try { await this.savePageScreenshot(page, `err-${submissionId}-${safeFormCode}.png`); } catch (_) {}
      return { submissionId, pengajuanId, formCode, status: 'error', reason: error.message };
    } finally {
      if (page)    { try { await page.close(); }    catch (_) {} }
      if (browser) { try { await browser.close(); } catch (_) {} }
    }
  }

  async _optimizePage(page) {
    page.setDefaultTimeout(this.config.elementTimeoutMs);
    page.setDefaultNavigationTimeout(60000);

    if (!this.config.blockHeavyResources) {
      return;
    }

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['image', 'font', 'media'].includes(request.resourceType())) {
        request.abort();
        return;
      }

      request.continue();
    });
  }

  async _findFirstElement(page, selectors, timeout = this.config.elementTimeoutMs) {
    await page.waitForSelector(selectors.join(', '), { timeout }).catch(() => {});

    for (const selector of selectors) {
      const element = await page.$(selector).catch(() => null);
      if (element) return element;
    }

    return null;
  }

  async _readAuthToken(page) {
    return page.evaluate(() => {
      const directKeys = [
        'token',
        'access_token',
        'jwt',
        'authToken',
        'authorization',
        'bearer_token',
        'api_token'
      ];

      const cleanToken = (value) => {
        if (!value || typeof value !== 'string') return '';
        const trimmed = value.trim();
        const bearer = trimmed.match(/^bearer\s+(.+)$/i);
        if (bearer) return bearer[1].trim();
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
        if (trimmed.length >= 24 && /^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) return trimmed;
        return '';
      };

      const findTokenInValue = (value, depth = 0) => {
        if (!value || depth > 3) return '';
        if (typeof value === 'string') {
          const direct = cleanToken(value);
          if (direct) return direct;

          if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
            try {
              return findTokenInValue(JSON.parse(value), depth + 1);
            } catch (_) {}
          }

          return '';
        }

        if (Array.isArray(value)) {
          for (const item of value) {
            const token = findTokenInValue(item, depth + 1);
            if (token) return token;
          }
          return '';
        }

        if (typeof value === 'object') {
          for (const key of directKeys) {
            const token = findTokenInValue(value[key], depth + 1);
            if (token) return token;
          }

          for (const [key, nestedValue] of Object.entries(value)) {
            if (/token|jwt|authorization/i.test(key)) {
              const token = findTokenInValue(nestedValue, depth + 1);
              if (token) return token;
            }
          }
        }

        return '';
      };

      const readStorage = (storage) => {
        for (const key of directKeys) {
          const token = findTokenInValue(storage.getItem(key));
          if (token) return token;
        }

        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          const value = storage.getItem(key);
          if (/token|jwt|auth|user|persist/i.test(key || '')) {
            const token = findTokenInValue(value);
            if (token) return token;
          }
        }

        return '';
      };

      return readStorage(window.localStorage) || readStorage(window.sessionStorage) || '';
    }).catch(() => '');
  }

  async _getPageAuth(page) {
    const cookies = await page.cookies();
    const authToken = await this._readAuthToken(page);

    if (authToken) {
      this.authToken = authToken;
    }

    cookies.authToken = authToken || this.authToken || '';
    return { cookies, authToken: cookies.authToken };
  }

  async _setInputValue(inputHandle, value) {
    await inputHandle.evaluate((element, nextValue) => {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');

      if (descriptor?.set) {
        descriptor.set.call(element, nextValue);
      } else {
        element.value = nextValue;
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }

  async _waitForText(page, text, timeout = this.config.loginTransitionTimeoutMs) {
    await page.waitForFunction((targetText) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return normalize(document.body?.innerText || document.body?.textContent).includes(normalize(targetText));
    }, { timeout }, text);
  }

  async _waitForNavigationOrTimeout(page, timeout = this.config.loginTransitionTimeoutMs, text = '') {
    const waits = [
      page.waitForNavigation({ waitUntil: this.config.navigationWaitUntil, timeout }).catch(() => null),
      sleep(timeout)
    ];

    if (text) {
      waits.push(this._waitForText(page, text, timeout).catch(() => null));
    }

    await Promise.race(waits);
  }

  async _clickRoleButton(page, roleName, timeout = 8000) {
    const startedAt = Date.now();
    let lastReason = '';

    while (Date.now() - startedAt < timeout) {
      const result = await page.evaluate((targetRoleName) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = normalize(targetRoleName);

        const isVisible = (element) => {
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

        const textOf = (element) => normalize(
          element.innerText
          || element.textContent
          || element.value
          || element.getAttribute('aria-label')
          || element.getAttribute('title')
        );

        const roleButtons = Array.from(document.querySelectorAll(
          'button, a, [role="button"], [role="menuitem"], input[type="button"], input[type="submit"], [tabindex]'
        ))
          .filter((element) => isVisible(element) && !isDisabled(element))
          .map((element) => {
            const text = textOf(element);
            const childExact = Array.from(element.children || [])
              .some((child) => textOf(child) === target);
            return { element, text, childExact };
          })
          .filter(({ text }) => text && !text.includes('masuk sekarang') && (text === target || text.includes(target)));

        if (roleButtons.length === 0) {
          const visibleButtons = Array.from(document.querySelectorAll('button, a, [role="button"], [tabindex]'))
            .filter((element) => isVisible(element) && !isDisabled(element))
            .map(textOf)
            .filter(Boolean)
            .slice(0, 12);

          return {
            ok: false,
            reason: `button role "${targetRoleName}" belum terlihat. Opsi: ${visibleButtons.join(' | ')}`
          };
        }

        roleButtons.sort((a, b) => {
          if (a.childExact !== b.childExact) return a.childExact ? -1 : 1;
          if (a.text === target && b.text !== target) return -1;
          if (b.text === target && a.text !== target) return 1;
          return a.text.length - b.text.length;
        });

        const targetButton = roleButtons[0].element;
        targetButton.scrollIntoView({ block: 'center', inline: 'nearest' });
        targetButton.click();

        return {
          ok: true,
          tagName: targetButton.tagName.toLowerCase(),
          text: roleButtons[0].text
        };
      }, roleName).catch((error) => ({ ok: false, reason: error.message }));

      if (result.ok) {
        console.log(`   ✅ Role dipilih: ${result.text}`);
        return result;
      }

      lastReason = result.reason;
      await sleep(this.config.clickPollMs);
    }

    throw new Error(lastReason || `Button role "${roleName}" tidak ditemukan`);
  }

  async _clickEnabledTextButton(page, text, timeout = 8000) {
    const startedAt = Date.now();
    let lastResult = null;

    while (Date.now() - startedAt < timeout) {
      lastResult = await page.evaluate((targetText) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = normalize(targetText);

        const isVisible = (element) => {
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

        const candidates = Array.from(document.querySelectorAll(
          'button, a, [role="button"], [role="menuitem"], input[type="button"], input[type="submit"], [tabindex]'
        ))
          .filter((element) => {
            const text = normalize(
              element.innerText
              || element.textContent
              || element.value
              || element.getAttribute('aria-label')
              || element.getAttribute('title')
            );
            return isVisible(element) && text.includes(target);
          });

        const enabled = candidates.find((element) => !isDisabled(element));
        if (!enabled) {
          return {
            ok: false,
            found: candidates.length,
            disabled: candidates.some((element) => isDisabled(element))
          };
        }

        enabled.scrollIntoView({ block: 'center', inline: 'nearest' });
        enabled.click();

        return {
          ok: true,
          tagName: enabled.tagName.toLowerCase(),
          text: (enabled.innerText || enabled.textContent || enabled.value || '').replace(/\s+/g, ' ').trim()
        };
      }, text).catch((error) => ({ ok: false, reason: error.message }));

      if (lastResult.ok) {
        return lastResult;
      }

      await sleep(this.config.clickPollMs);
    }

    throw new Error(
      `Button "${text}" belum aktif. ` +
      `found=${lastResult?.found || 0}, disabled=${lastResult?.disabled ? 'yes' : 'no'}`
    );
  }

  _looksLikeRolePage(state) {
    return Boolean(state?.hasRoleSelectionText
      || state?.url?.includes('/select-role')
      || (state?.hasRoleText && state?.hasMasukSekarang && !state?.hasLoginInput));
  }

  async _waitForRolePage(page, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let state = null;

    while (Date.now() < deadline) {
      state = await this._readPageState(page);
      if (this._looksLikeRolePage(state)) {
        return state;
      }

      if (state.rowCount > 0 || (!state.hasLoginInput && !state.url.includes('/sign-in') && !state.hasMasukSekarang)) {
        return null;
      }

      await sleep(this.config.clickPollMs);
    }

    return this._looksLikeRolePage(state) ? state : null;
  }

  async _waitForRoleExit(page, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let state = null;

    while (Date.now() < deadline) {
      state = await this._readPageState(page);
      if (state.hasLoginInput) {
        return { ok: false, state };
      }

      if (!this._looksLikeRolePage(state) && state.snippet) {
        return { ok: true, state };
      }

      await sleep(this.config.clickPollMs);
    }

    return { ok: false, state: state || await this._readPageState(page) };
  }

  async _waitForPageSettled(page, timeout = 5000) {
    await page.waitForFunction(() => {
      const bodyText = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      return document.readyState !== 'loading' && bodyText.length > 0;
    }, { timeout }).catch(() => {});

    await sleep(Math.max(this.config.shortPauseMs, 500));
  }

  async _selectRoleIfPresent(page, timeout = 8000) {
    const state = await this._waitForRolePage(page, timeout);
    if (!state) {
      return false;
    }

    await this._clickRoleButton(page, this.config.roleName, timeout);
    const waitAfterRoleEnter = this._waitForNavigationOrTimeout(
      page,
      Math.min(this.config.loginTransitionTimeoutMs, 8000)
    );
    const enterResult = await this._clickEnabledTextButton(page, 'Masuk Sekarang', timeout);
    await waitAfterRoleEnter;

    const exitResult = await this._waitForRoleExit(
      page,
      Math.min(Math.max(this.config.loginTransitionTimeoutMs, 12000), 20000)
    );
    if (!exitResult.ok) {
      console.log(`   ⚠️ Setelah klik "${enterResult.text || 'Masuk Sekarang'}" masih di pilih role: ${exitResult.state?.snippet || '-'}`);
      return false;
    }

    await this._waitForPageSettled(page);
    return true;
  }

  async _readPageState(page) {
    return page.evaluate((roleName) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const bodyText = document.body?.innerText || document.body?.textContent || '';
      const normalizedBody = normalize(bodyText);
      const rowCount = document.querySelectorAll('tbody tr').length;
      const hasLoginInput = Boolean(
        document.querySelector('input[type="password"], input[name="password"], input[type="email"], input[name="email"]')
      );
      const hasRoleText = normalizedBody.includes(normalize(roleName));
      const hasMasukSekarang = normalizedBody.includes('masuk sekarang');
      const hasRoleSelectionText = normalizedBody.includes('pilih role')
        || normalizedBody.includes('pilih peran')
        || normalizedBody.includes('select role');

      return {
        url: location.href,
        title: document.title || '',
        rowCount,
        hasLoginInput,
        hasRoleText,
        hasMasukSekarang,
        hasRoleSelectionText,
        snippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, 220)
      };
    }, this.config.roleName).catch((error) => ({
      url: page.url(),
      title: '',
      rowCount: 0,
      hasLoginInput: false,
      hasRoleText: false,
      hasMasukSekarang: false,
      hasRoleSelectionText: false,
      snippet: error.message
    }));
  }

  async _waitForDetailState(page, timeout = this.config.detailReadyTimeoutMs) {
    const deadline = Date.now() + timeout;
    let lastState = null;

    while (Date.now() < deadline) {
      lastState = await this._readPageState(page);
      if (lastState.rowCount > 0) {
        return { ok: true, state: lastState };
      }

      if (lastState.hasLoginInput || lastState.hasMasukSekarang || lastState.hasRoleSelectionText) {
        return { ok: false, state: lastState };
      }

      await sleep(this.config.clickPollMs);
    }

    return { ok: false, state: lastState || await this._readPageState(page) };
  }

  async _openDetailPage(page, detailUrl, pengajuanId) {
    let lastState = null;

    for (let attempt = 1; attempt <= this.config.detailRetryCount; attempt++) {
      await page.goto(detailUrl, { waitUntil: this.config.navigationWaitUntil, timeout: 60000 }).catch((error) => {
        if (!/timeout/i.test(error.message || '')) {
          throw error;
        }

        console.log(`   ⚠️ Navigasi detail timeout, lanjut cek DOM (${attempt}/${this.config.detailRetryCount})`);
      });
      const result = await this._waitForDetailState(page);

      if (result.ok) {
        console.log(`   ✅ Detail pengajuan=${pengajuanId} siap (${result.state.rowCount} row)`);
        return result.state;
      }

      lastState = result.state;
      if (lastState?.hasLoginInput) {
        console.log(`   ↻ Detail balik ke login, login ulang lalu retry (${attempt}/${this.config.detailRetryCount})`);
        await this._loginAndGetCookies(page);
        continue;
      }

      if (lastState?.hasMasukSekarang || lastState?.hasRoleSelectionText) {
        console.log(`   ↻ Detail tertahan di pilih role, masuk role lalu retry (${attempt}/${this.config.detailRetryCount})`);
        await this._selectRoleIfPresent(page);
        continue;
      }

      console.log(
        `   ↻ Detail belum siap (${attempt}/${this.config.detailRetryCount}) ` +
        `url=${lastState?.url || page.url()} snippet="${lastState?.snippet || '-'}"`
      );
    }

    throw new Error(
      `Detail pengajuan ${pengajuanId} tidak memunculkan tabel. ` +
      `URL akhir: ${lastState?.url || page.url()} | ${lastState?.snippet || 'tanpa teks'}`
    );
  }

  /**
   * Login di dalam Chromium baru, return cookies + token milik sesi login tersebut.
   *
   * @param {Page} page  page milik Chromium baru
   * @returns {{cookies: Array, authToken: string}}
   */
  async _loginAndGetCookies(page) {
    await page.goto(this.config.webUrl, { waitUntil: this.config.navigationWaitUntil, timeout: 60000 });

    // Isi email
    const emailSelectors = [
      'input[type="email"]', 'input[name="email"]', 'input[id="email"]',
      'input[placeholder*="email" i]', 'input[placeholder*="username" i]',
    ];
    const emailInput = await this._findFirstElement(page, emailSelectors);
    if (!emailInput) throw new Error('Input email tidak ditemukan');
    await this._setInputValue(emailInput, this.config.email);

    // Isi password
    const passwordSelectors = [
      'input[type="password"]', 'input[name="password"]', 'input[id="password"]',
    ];
    const passwordInput = await this._findFirstElement(page, passwordSelectors);
    if (!passwordInput) throw new Error('Input password tidak ditemukan');
    await this._setInputValue(passwordInput, this.config.password);

    // Submit
    const submitSelectors = [
      'button[type="submit"]', 'input[type="submit"]', 'button.btn-login', 'button#login',
    ];
    const waitAfterSubmit = this._waitForNavigationOrTimeout(
      page,
      this.config.loginTransitionTimeoutMs,
      this.config.roleName
    );
    let submitted = false;
    for (const sel of submitSelectors) {
      try { const btn = await page.$(sel); if (btn) { await btn.click(); submitted = true; break; } } catch (_) {}
    }
    if (!submitted) {
      try { await this._clickByText(page, 'Login', { timeout: 3000 }); submitted = true; } catch (_) {}
    }
    if (!submitted) {
      try { await this._clickByText(page, 'Masuk',  { timeout: 3000, exact: false }); submitted = true; } catch (_) {}
    }
    if (!submitted) await passwordInput.press('Enter');
    await waitAfterSubmit;

    const roleSelected = await this._selectRoleIfPresent(
      page,
      Math.min(Math.max(this.config.loginTransitionTimeoutMs, 12000), 20000)
    ).catch(() => false);

    const auth = await this._getPageAuth(page);
    console.log(
      `   🍪 Login OK, ${auth.cookies.length} cookies diambil` +
      `${auth.authToken ? ' + token login' : ''}` +
      `${roleSelected ? ' + role masuk' : ''}`
    );
    return auth;
  }

  /**
   * Stripped-down `clickElementByText` untuk dipakai di dalam lane tanpa `this.page`.
   */
  async _clickByText(page, text, options = {}) {
    const timeout = options.timeout || 10000;
    const exact   = options.exact !== false;
    const preferInteractive = Boolean(options.preferInteractive);
    const startedAt = Date.now();
    let lastReason = '';

    while (Date.now() - startedAt < timeout) {
      const result = await page.evaluate((targetText, ex, interactiveOnly) => {
        const normalize = v => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = normalize(targetText);

        const isVisible = (element) => {
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

        const isInteractive = (element) => {
          const tagName = element.tagName.toLowerCase();
          return ['button', 'a', 'input'].includes(tagName)
            || element.getAttribute('role') === 'button'
            || element.getAttribute('role') === 'menuitem'
            || element.tabIndex >= 0;
        };

        const getTexts = (element) => [
          element.innerText,
          element.textContent,
          element.value,
          element.getAttribute('aria-label'),
          element.getAttribute('title')
        ].map(normalize).filter(Boolean);

        const selector = interactiveOnly
          ? 'button, a, input[type="button"], input[type="submit"], [role="button"], [role="menuitem"], [tabindex]'
          : 'button, a, input[type="button"], input[type="submit"], [role="button"], [role="menuitem"], [tabindex], span, div';

        const candidates = Array.from(document.querySelectorAll(selector))
          .filter(el => {
            if (!isVisible(el) || isDisabled(el)) return false;
            const texts = getTexts(el);
            return ex
              ? texts.some(value => value === target)
              : texts.some(value => value === target || value.includes(target));
          });

        if (!candidates[0]) {
          return { ok: false, reason: `teks "${targetText}" belum terlihat` };
        }

        let targetElement = candidates[0];
        if (!interactiveOnly && !isInteractive(targetElement)) {
          targetElement = targetElement.closest('button, a, input, [role="button"], [role="menuitem"], [tabindex]')
            || targetElement;
        }

        targetElement.click();
        return { ok: true, tagName: targetElement.tagName.toLowerCase() };
      }, text, exact, preferInteractive).catch((error) => ({
        ok: false,
        reason: error.message
      }));

      if (result.ok) return result;
      lastReason = result.reason;
      await sleep(this.config.clickPollMs);
    }

    throw new Error(`Teks "${text}" tidak terlihat. ${lastReason}`.trim());
  }

  // ── helpers yang dipakai oleh _runSingleSubmission ─────────────────

  _setupPageDownload(page, downloadDir) {
    return page.target().createCDPSession()
      .then(s => {
        s.send('Page.setDownloadBehavior',     { behavior: 'allow', downloadPath: downloadDir }).catch(() => {});
        s.send('Browser.setDownloadBehavior',  { behavior: 'allow', downloadPath: downloadDir }).catch(() => {});
        return s;
      });
  }

  async _hoverAndGeneratePdf(page, formCode) {
    const rowIdx = await this._findRowByCode(page, formCode);
    const rows   = await page.$$('tbody tr');
    const row    = rows[rowIdx];
    if (!row) throw new Error(`Row form ${formCode} hilang setelah re-render`);

    await page.keyboard.press('Escape').catch(() => {});
    await row.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await sleep(this.config.shortPauseMs);

    const dropdown = await row.$('[data-bs-toggle="dropdown"]')
                  || await row.$('button[title*="Aksi" i]')
                  || await row.$('.dropdown button');
    if (!dropdown) throw new Error(`Tombol titik tiga form ${formCode} tidak ada`);
    await dropdown.click();
    await page.waitForSelector('.dropdown-menu, [role="menu"]', {
      timeout: 1000,
      visible: true
    }).catch(() => {});

    const targetText = 'generate pdf';
    const menuResult = await row.evaluate((rowElement, t) => {
      const target = (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0;
      };

      const candidates = Array.from(rowElement.querySelectorAll(
        '.dropdown-menu.show button, .dropdown-menu.show a, .dropdown-menu.show [role="menuitem"], button.dropdown-item, a.dropdown-item, [role="menuitem"]'
      ));
      const visibleCandidates = candidates.filter(isVisible);
      const searchableCandidates = visibleCandidates.length > 0 ? visibleCandidates : candidates;
      const visibleTexts = searchableCandidates
        .map(el => (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 12);

      const match = searchableCandidates.find(el => {
        const txt = normalize(el.textContent || el.innerText);
        return txt === target || txt.includes(target);
      });
      if (match) {
        (match.closest('button, a, [role="menuitem"], [role="button"]') || match).click();
        return { clicked: true, visibleTexts };
      }

      const rough = searchableCandidates.find(el => {
        const txt = (el.textContent || el.innerText || '').replace(/[\s_-]+/g, ' ').trim().toLowerCase();
        return txt.includes(target) || target.includes(txt);
      });
      if (rough) {
        (rough.closest('button, a, [role="menuitem"], [role="button"]') || rough).click();
        return { clicked: true, visibleTexts };
      }

      return { clicked: false, visibleTexts };
    }, targetText);

    if (!menuResult.clicked) {
      try { await this.savePageScreenshot(page, `drop-err-${this.sanitizeFilename(formCode)}.png`); } catch (_) {}
      const options = menuResult.visibleTexts?.length ? menuResult.visibleTexts.join(' | ') : 'kosong';
      throw new Error(`Menu "Generate PDF" tidak ada untuk form ${formCode}. Opsi terlihat: ${options}`);
    }
    console.log(`   ✅ Generate PDF diklik`);
  }

  async _findRowByCode(page, formCode, timeout = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const result = await page.evaluate((targetCode) => {
        const normalize = v => (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const rows = Array.from(document.querySelectorAll('tbody tr'));
        const rowIndex = rows.findIndex(row =>
          Array.from(row.querySelectorAll('td')).some(cell =>
            normalize(cell.innerText || cell.textContent) === normalize(targetCode)
          )
        );
        return rowIndex === -1 ? { ok: false } : { ok: true, rowIndex };
      }, formCode).catch(() => ({ ok: false }));

      if (result.ok) return result.rowIndex;
      await sleep(this.config.clickPollMs);
    }
    throw new Error(`Row ${formCode} tidak ditemukan dalam ${timeout}ms`);
  }

  /**
   * Poll folder download sampai file baru (oleh Chromium ini sendiri) muncul.
   *
   * @param {string} downloadDir   folder download khusus submission ini
   * @param {Date|number} startedAt timestamp sebelum klik Generate PDF
   * @returns {string} path PDF yang selesai
   */
  async _waitForNewDownload(downloadDir, startedAt) {
    const deadline  = Date.now() + (this.config.downloadTimeoutMs || 120000);
    const startedMs = startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);

    while (Date.now() < deadline) {
      try {
        const files = fs.readdirSync(downloadDir)
          .filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'))
          .map(f => {
            const filePath = path.join(downloadDir, f);
            const stat = fs.statSync(filePath);
            return { name: f, path: filePath, stat };
          })
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

        const done = files.find(f => {
          try {
            const completedAt = Math.max(f.stat.mtimeMs, f.stat.ctimeMs);
            return f.stat.isFile()
              && f.stat.size > 0
              && completedAt >= startedMs - 1000
              && !fs.existsSync(`${f.path}.crdownload`);
          } catch (_) { return false; }
        });

        if (done) {
          console.log(`   📥 PDF: ${done.name} (${done.stat.size} bytes)`);
          return done.path;
        }
      } catch (_) { /* folder race */ }
      await sleep(this.config.downloadPollMs);
    }
    throw new Error(`Download timeout ${this.config.downloadTimeoutMs}ms`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  GLOBAL LOOP — fetch halaman → spawn jalan → loop sampai kosong
  // ─────────────────────────────────────────────────────────────────────

  /**
   * while(true)
   *   fetch halaman N
   *   jika kosong → stop
   *   spawn CONCURRENCY Chromium independen untuk semua submission
   *   N++ → ulang
   */
  async _pollSubmissionsLoop(initialPage) {
    let pageNumber   = initialPage;
    let totalProcessed = 0;
    let totalOk = 0;

    while (true) {
      if (this.config.maxPages > 0 && pageNumber >= initialPage + this.config.maxPages) {
        console.log(`\n⏹️ MAX_PAGES tercapai (${this.config.maxPages}), loop berhenti.`);
        break;
      }

      const { rows: batchRows, summary, isLastPage } = await this._fetchPageAndProcess(pageNumber);
      totalProcessed += batchRows.length;
      totalOk += summary.ok || 0;

      if (this.config.stopOnEmptySuccessBatch && batchRows.length > 0 && (summary.ok || 0) === 0) {
        console.log('\n⛔ Tidak ada satu pun submission sukses di halaman ini, loop dihentikan supaya tidak buang proses.');
        break;
      }

      if (isLastPage) {
        console.log(`\n🏁 API kosong — loop berhenti. Total submission diproses: ${totalProcessed}, sukses: ${totalOk}`);
        break;
      }
      pageNumber++;
      await sleep(this.config.shortPauseMs);
    }
    return { totalProcessed, totalOk };
  }

  /**
   * Jalankan bot lengkap (browser + API + concurrent loop)
   */
  async run() {
    try {
      console.log('='.repeat(60));
      console.log('🤖 DITEKINDO BOT — MULTI-CHROMIUM ENGINE');
      console.log(`   CONCURRENCY: ${this.config.concurrency} jalan paralel`);
      console.log(`   GROUP_BY_PENGAJUAN: ${this.config.groupByPengajuan ? 'ON' : 'OFF'}`);
      console.log('   PATCH: role-button + row-dropdown + login-token');
      console.log('='.repeat(60));

      // Default: satu Chromium memproses satu pengajuan berisi beberapa form.
      console.log(`\n🏃 Loop dimulai — CONCURRENCY: ${this.config.concurrency}`);
      const { totalProcessed, totalOk } = await this._pollSubmissionsLoop(Number(this.config.page));
      console.log(`\n🏁 SELESAI. Total submission diproses: ${totalProcessed}, sukses: ${totalOk}`);

      console.log('\n' + '='.repeat(60));
      console.log('✅ BOT SELESAI');
      console.log('='.repeat(60));

    } catch (error) {
      console.error('\n❌ BOT ERROR:', error.message);
      console.error(error.stack);
    }
    // Tidak ada finally – setiap lane menutup chromium-nya sendiri sendiri
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
