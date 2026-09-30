/* Browser integration checks. All OpenAI requests are intercepted: no key or billing. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
let playwright;
try { playwright = require('playwright'); }
catch {
  const bundled = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  playwright = createRequire(path.join(bundled, 'spectrum-qa.cjs'))('playwright');
}
const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root, 'spectrum-analyzer.html')).href;
const fakeKey = 'sk-test-SPECTRUM_NOT_A_REAL_KEY';
const fixture = () => ({
  schema_version: '1.0', status: 'ok',
  signal: { sample_rate_hz: 80, sample_count: 81920, duration_s: 1024, units: 'единицы DTR', mean: 0, std: 1, min: -2, max: 2 },
  analysis: { frequency_range_hz: [0.1, 40], fft_size: 81920, bin_spacing_hz: 80 / 81920, window: 'hann_symmetric', detrend: 'linear', amplitude_convention: 'one_sided_peak', segment_samples: 8192, hop_samples: 4096, peak_prominence_db: 10, smoothing_method: 'gaussian_amplitude_fwhm', smoothing_hz: 0.02, minimum_peak_separation_hz: 0.02 },
  peaks: [1.25, 2.5, 3.75].map((f, i) => ({ frequency_hz: f, amplitude: [10, 5, 3][i], smoothed_center_hz: f, smoothed_amplitude: [8, 4, 2.4][i], prominence_db: 20 - i * 2, family_id: 'H1', harmonic_order: i + 1 })),
  harmonic_families: [{ id: 'H1', fundamental_hz: 1.25, peak_indices: [0, 1, 2], fitting_error_hz: 0, tracked_min_hz: 1.24, tracked_max_hz: 1.26, assessment_ru: 'Контрольный ответ API, не научное измерение.' }],
  spectrum: { frequency_hz: [0.125, 1, 1.25, 1.5, 2, 2.5, 3, 3.75, 4, 10, 20, 30, 40], amplitude: [0.1, 0.1, 10, 0.2, 0.1, 5, 0.1, 3, 0.1, 0.05, 0.02, 0.01, 0.001], representation: 'max_per_bucket' },
  summary_ru: 'Проверочный результат. <img src=x onerror="window.injected=true">', warnings: ['Данные получены из имитации API.']
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mockApi(page, options = {}) {
  const seen = [], counter = { responses: 0, deletes: 0, gets: 0, cancels: 0 };
  await page.route('https://api.openai.com/**', async route => {
    const req = route.request(), parsed = new URL(req.url()), endpoint = parsed.pathname, method = req.method();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'content-type': 'application/json' };
    const send = (data, status = 200, contentType) => route.fulfill({ status, headers: { ...headers, ...(contentType ? { 'content-type': contentType } : {}) }, body: typeof data === 'string' ? data : JSON.stringify(data) });
    if (method === 'OPTIONS') return send('', 204);
    seen.push({ endpoint, method, body: req.postData() });
    assert.equal(req.headers().authorization, `Bearer ${fakeKey}`);
    if (endpoint === '/v1/containers' && method === 'POST') {
      if (options.unauthorized) return send({ error: { message: `Invalid API key: ${fakeKey}` } }, 401);
      return send({ id: 'cntr_test' });
    }
    if (endpoint === '/v1/containers/cntr_test/files' && method === 'POST') {
      assert.match(req.headers()['content-type'], /multipart\/form-data; boundary=/);
      return send({ id: 'cfile_input', path: '/mnt/data/prefixed_input.txt', container_id: 'cntr_test' });
    }
    if (endpoint === '/v1/responses' && method === 'POST') {
      counter.responses++;
      const body = JSON.parse(req.postData());
      assert.equal(body.background, true);
      assert.equal(body.model, 'gpt-5.6-luna');
      assert.equal(body.reasoning.effort, 'medium');
      assert.equal(body.tools[0].type, 'code_interpreter');
      assert.equal(body.tools[0].container, 'cntr_test');
      assert.equal(body.tool_choice, 'required');
      assert.ok(!req.postData().includes(fakeKey));
      if (counter.responses === 1) {
        assert.ok(body.input.includes('/mnt/data/prefixed_input.txt'));
        assert.ok(body.input.includes('analysis.py'));
      } else assert.equal(body.previous_response_id, 'resp_test_1');
      if (options.slowCreate) await delay(700);
      if (options.incomplete) return send({ id: 'resp_test_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
      return send({ id: `resp_test_${counter.responses}`, status: options.immediate ? 'completed' : 'queued', output: options.immediate ? [{ type: 'code_interpreter_call', status: 'completed', code: '# mocked' }] : [] });
    }
    if (/\/v1\/responses\/resp_test_\d+$/.test(endpoint) && method === 'GET') {
      counter.gets++;
      if (options.stayRunning) return send({ id: endpoint.split('/').pop(), status: 'in_progress', output: [] });
      return send({ id: endpoint.split('/').pop(), status: 'completed', usage: { total_tokens: 123 }, output: options.noPython ? [] : [{ type: 'code_interpreter_call', status: 'completed', code: '# mocked code execution' }] });
    }
    if (/\/v1\/responses\/resp_test_\d+\/cancel$/.test(endpoint)) {
      counter.cancels++;
      return send({ id: endpoint.split('/').at(-2), status: 'cancelled' });
    }
    if (endpoint === '/v1/containers/cntr_test/files' && method === 'GET') {
      return send({ data: ['analysis.json', 'analysis.py', 'spectrum.csv'].map((name, i) => ({ id: `cfile_${i}`, path: `/mnt/data/${name}` })), has_more: false });
    }
    if (endpoint === '/v1/containers/cntr_test/files/cfile_0/content') {
      if (options.badJsonOnce && counter.responses === 1) return send('{ broken json', 200, 'application/json');
      const data = fixture();
      if (options.invalidInput) return send({ schema_version: '1.0', status: 'invalid_input', summary_ru: 'DTR-строк не найдено.', warnings: [] });
      if (options.badFrequency) data.peaks[0].frequency_hz = 80;
      if (options.emptyPeaks) { data.peaks = []; data.harmonic_families = []; }
      return send(data);
    }
    if (endpoint === '/v1/containers/cntr_test/files/cfile_1/content') return send('# mock script for browser tests only\n', 200, 'text/plain');
    if (endpoint === '/v1/containers/cntr_test/files/cfile_2/content') return send('frequency_hz,raw_amplitude,smoothed_amplitude\n0,0,0\n1.25,10,8\n', 200, 'text/csv');
    if (endpoint === '/v1/containers/cntr_test' && method === 'DELETE') {
      counter.deletes++;
      if (options.cleanupFailsOnce && counter.deletes === 1) return send({ error: { message: 'Temporary failure' } }, 503);
      return send({ id: 'cntr_test', deleted: true });
    }
    throw new Error(`Unexpected network request: ${method} ${endpoint}`);
  });
  return { seen, counter };
}
async function prepare(page) {
  await page.locator('#fileInput').setInputFiles({ name: 'input.txt', mimeType: 'text/plain', buffer: Buffer.from('[!DTR:80:+1+2-1-2]\n') });
  await page.locator('#apiKey').fill(fakeKey);
}
async function done(page) { await page.waitForFunction(() => !document.getElementById('runButton').disabled, null, { timeout: 30000 }); }
async function run() {
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  let passCount = 0;
  async function test(name, options, fn) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1120 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    const api = await mockApi(page, options);
    try {
      await page.goto(url);
      await fn(page, api);
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0, 'No credentials stored');
      passCount++;
      process.stdout.write(`PASS ${name}\n`);
    } finally { await context.close(); }
  }
  try {
    await test('initial, demo, responsive, tabs', {}, async (page, api) => {
      assert.equal(await page.locator('#statusTitle').innerText(), 'Готов к анализу');
      assert.equal(await page.locator('#downloadJson').isDisabled(), true);
      await page.screenshot({ path: path.join(root, 'qa/spectrum-idle.png'), fullPage: true });
      await page.locator('#demoButton').click();
      assert.equal(await page.locator('#peaksBody tr').count(), 7);
      assert.equal(await page.locator('#demoNotice').isVisible(), true);
      await page.locator('#tabPeaks').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#panelFamilies').isVisible(), true);
      await page.locator('#scaleLinear').click();
      assert.equal(await page.locator('#scaleLinear').getAttribute('aria-pressed'), 'true');
      await page.locator('#tabPeaks').click();
      await page.screenshot({ path: path.join(root, 'qa/spectrum-demo-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
      await page.screenshot({ path: path.join(root, 'qa/spectrum-demo-mobile.png'), fullPage: true });
      assert.equal(api.seen.length, 0, 'Demo is offline');
    });
    await test('local input validation', {}, async (page, api) => {
      await page.locator('#runButton').click();
      assert.ok((await page.locator('#message').innerText()).includes('API key'));
      await prepare(page);
      await page.locator('#frequencyMax').fill('41');
      await page.locator('#runButton').click();
      assert.ok((await page.locator('#message').innerText()).includes('Найквиста'));
      assert.equal(api.seen.length, 0);
      await page.locator('#fileInput').setInputFiles({ name: 'encrypted.log', mimeType: 'application/octet-stream', buffer: Buffer.from('bad') });
      assert.ok((await page.locator('#message').innerText()).includes('расшифрованный TXT'));
      assert.equal(await page.locator('#fileName').innerText(), 'input.txt');
    });
    await test('successful background analysis, download, safe rendering', {}, async (page, api) => {
      await prepare(page);
      await page.locator('#runButton').click();
      await done(page);
      assert.equal(await page.locator('#statusTitle').innerText(), 'Анализ завершён');
      assert.equal(await page.locator('#peaksBody tr').count(), 3);
      assert.equal(api.counter.responses, 1);
      assert.equal(api.counter.deletes, 1);
      assert.equal(api.counter.gets, 1);
      assert.equal(await page.locator('#downloadPython').isEnabled(), true);
      assert.equal(await page.locator('#reportText img').count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      assert.ok(!(await page.locator('body').innerText()).includes(fakeKey));
      const waiting = page.waitForEvent('download');
      await page.locator('#downloadJson').click();
      const download = await waiting;
      assert.equal(download.suggestedFilename(), 'analysis.json');
      const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.deepEqual(data, fixture());
      await page.screenshot({ path: path.join(root, 'qa/spectrum-success.png'), fullPage: true });
    });
    await test('401 redacts key, does not retry POST', { unauthorized: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.ok((await page.locator('#message').innerText()).includes('401'));
      assert.ok(!(await page.locator('body').innerText()).includes(fakeKey));
      assert.equal(api.seen.length, 1);
      assert.equal(await page.locator('#downloadJson').isDisabled(), true);
    });
    await test('incomplete response is not accepted', { incomplete: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.ok((await page.locator('#message').innerText()).includes('max_output_tokens'));
      assert.equal(await page.locator('#downloadJson').isDisabled(), true);
      assert.equal(api.counter.deletes, 1);
    });
    await test('missing Python execution is not accepted', { noPython: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.ok((await page.locator('#message').innerText()).includes('исполнения Python'));
      assert.equal(await page.locator('#downloadJson').isDisabled(), true);
      assert.equal(api.counter.responses, 1);
    });
    await test('malformed JSON repaired once', { badJsonOnce: true, immediate: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.equal(api.counter.responses, 2);
      assert.equal(await page.locator('#statusTitle').innerText(), 'Анализ завершён');
      assert.equal(await page.locator('#downloadJson').isEnabled(), true);
    });
    await test('out-of-band result rejected after bounded repair', { badFrequency: true, immediate: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.equal(api.counter.responses, 2);
      assert.equal(await page.locator('#downloadJson').isDisabled(), true);
      assert.equal(api.counter.deletes, 1);
    });
    await test('invalid TXT returns diagnostic JSON', { invalidInput: true, immediate: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.equal(await page.locator('#statusTitle').innerText(), 'Данные не прошли проверку');
      assert.equal(await page.locator('#downloadJson').isEnabled(), true);
      assert.equal(await page.locator('#downloadCsv').isDisabled(), true);
      assert.equal(api.counter.responses, 1);
    });
    await test('empty peak set is legitimate', { emptyPeaks: true, immediate: true }, async (page) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.equal(await page.locator('#statusTitle').innerText(), 'Анализ завершён');
      assert.equal(await page.locator('#peaksBody tr').count(), 0);
      assert.ok((await page.locator('#peaksEmpty').innerText()).includes('не обнаружено'));
    });
    await test('cancel while response is being created gets ID and cancels remotely', { slowCreate: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click();
      await page.waitForFunction(() => document.getElementById('statusTitle').textContent === 'Выполняется анализ');
      while (!api.counter.responses) await delay(20);
      await page.locator('#cancelButton').click();
      await done(page);
      assert.equal(api.counter.cancels, 1);
      assert.equal(api.counter.deletes, 1);
      assert.equal(await page.locator('#statusTitle').innerText(), 'Анализ остановлен');
    });
    await test('cancel queued work', { stayRunning: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click();
      while (!api.counter.responses) await delay(20);
      await delay(100); await page.locator('#cancelButton').click(); await done(page);
      assert.equal(api.counter.cancels, 1);
      assert.equal(api.counter.deletes, 1);
    });
    await test('cleanup error retains results and supports explicit retry', { cleanupFailsOnce: true, immediate: true }, async (page, api) => {
      await prepare(page); await page.locator('#runButton').click(); await done(page);
      assert.equal(await page.locator('#downloadJson').isEnabled(), true);
      await page.locator('#technical summary').click();
      assert.equal(await page.locator('#retryCleanup').isVisible(), true);
      await page.locator('#retryCleanup').click();
      await page.locator('#retryCleanup').waitFor({ state: 'hidden' });
      assert.equal(api.counter.deletes, 2);
      assert.ok((await page.locator('#message').innerText()).includes('очищены'));
    });
    assert.deepEqual(errors, []);
    process.stdout.write(`\n${passCount} browser scenarios passed. No real OpenAI requests.\n`);
  } finally { await browser.close(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
