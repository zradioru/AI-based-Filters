/* API is intercepted. Uploaded Python actually runs locally on synthetic TXT. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const bundle = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies');
const { chromium } = createRequire(path.join(bundle, 'node/node_modules/qa.cjs'))('playwright');
const python = process.env.SPECTRUM_PYTHON || path.join(bundle, 'python/python.exe');
const root = path.resolve(__dirname, '..');
const key = 'sk-test-NOT_A_REAL_KEY_123456';
const samples = Array.from({ length: 16384 }, (_, i) => 1000 + .01*i + 10*Math.sin(2*Math.PI*1.25*i/80) + 5*Math.sin(2*Math.PI*2.5*i/80) + 3*Math.sin(2*Math.PI*3.75*i/80)).join('\n');

async function scenario(browser, name, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axel-fixed-'));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1120 }, acceptDownloads: true });
  const page = await context.newPage();
  const failures = [], uploads = [];
  let result, deletes = 0, cancels = 0, posts = 0;
  page.on('pageerror', e => failures.push(e.message));
  await page.route('https://api.openai.com/**', async route => {
    const req = route.request(), p = new URL(req.url()).pathname, method = req.method();
    const send = (data, status = 200) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' }, body: Buffer.isBuffer(data) ? data : JSON.stringify(data) });
    try {
      if (method === 'OPTIONS') return send('', 204);
      assert.equal(req.headers().authorization, 'Bearer ' + key);
      if (p === '/v1/containers' && method === 'POST') return send({ id: 'cntr_test' });
      if (p === '/v1/containers/cntr_test/files' && method === 'POST') {
        const bytes = req.postDataBuffer(), boundary = req.headers()['content-type'].split('boundary=')[1];
        const split = bytes.indexOf('\r\n\r\n'), end = bytes.lastIndexOf('\r\n--' + boundary);
        const name = /filename="([^"]+)"/.exec(bytes.subarray(0, split).toString())[1];
        const content = bytes.subarray(split + 4, end);
        uploads.push(name); fs.writeFileSync(path.join(tmp, name), content);
        return send({ id: 'file_' + uploads.length, path: '/mnt/data/upload_' + name });
      }
      if (p === '/v1/responses' && method === 'POST') {
        posts++;
        const body = req.postDataJSON();
        assert.deepEqual(uploads, ['input.txt', 'spectrum-fixed.py', 'settings.json']);
        assert.equal(body.model, 'gpt-5.6-luna');
        assert.equal(body.reasoning.effort, options.custom ? 'high' : 'low');
        assert.equal(body.max_output_tokens, options.custom ? 64000 : 32000);
        assert.equal(body.tools[0].container, 'cntr_test');
        assert.equal(body.background, true);
        assert.ok(body.input.includes('/mnt/data/upload_spectrum-fixed.py'));
        assert.ok(body.input.includes('/mnt/data/upload_settings.json'));
        assert.ok(!body.input.includes(samples.slice(0, 150)));
        assert.ok(!req.postData().includes(key));
        assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')).smoothing_hz, 0.02);
        assert.equal(fs.readFileSync(path.join(tmp, 'spectrum-fixed.py'), 'utf8').replace(/\r\n/g, '\n'), fs.readFileSync(path.join(root, 'spectrum-fixed.py'), 'utf8').replace(/\r\n/g, '\n'));
        if (!options.noPython) {
          const run = spawnSync(python, [path.join(tmp, 'spectrum-fixed.py'), '--input', path.join(tmp, 'input.txt'), '--config', path.join(tmp, 'settings.json'), '--output', tmp], { encoding: 'utf8', windowsHide: true });
          assert.equal(run.status, 0, run.stderr);
          result = JSON.parse(fs.readFileSync(path.join(tmp, 'analysis.json'), 'utf8'));
          if (options.badHash) result.provenance.input_sha256 = 'wrong';
          if (options.malformed) result = '{not JSON';
        }
        return send({ id: 'resp_fixed', status: 'queued', output: [] });
      }
      if (p === '/v1/responses/resp_fixed' && method === 'GET') return send({ id: 'resp_fixed', status: options.running ? 'in_progress' : options.incomplete ? 'incomplete' : 'completed', incomplete_details: options.incomplete ? { reason: 'max_output_tokens' } : null, output: options.noPython ? [] : [{ type: 'code_interpreter_call', status: 'completed' }] });
      if (p === '/v1/responses/resp_fixed/cancel') { cancels++; return send({ id: 'resp_fixed', status: 'cancelled' }); }
      if (p === '/v1/containers/cntr_test/files' && method === 'GET') return send({ has_more: false, data: ['analysis.json','analysis.py', ...(options.invalid ? [] : ['spectrum.csv'])].map((name, i) => ({ id: 'out_' + i, path: '/mnt/data/' + name })) });
      if (p.endsWith('/out_0/content')) return send(typeof result === 'string' ? Buffer.from(result) : result);
      if (p.endsWith('/out_1/content')) return send(options.badScript ? Buffer.from('# modified') : fs.readFileSync(path.join(tmp, 'analysis.py')));
      if (p.endsWith('/out_2/content')) return send(options.badCsv ? Buffer.from('frequency_hz,amplitude\n0,9\n') : fs.readFileSync(path.join(tmp, 'spectrum.csv')));
      if (p === '/v1/containers/cntr_test' && method === 'DELETE') { deletes++; return send({ deleted: true }); }
      throw Error('Unexpected endpoint: ' + method + ' ' + p);
    } catch (error) { failures.push(error.stack); return send({ error: { message: 'Test mock failed' } }, 500); }
  });
  try {
    await page.goto(pathToFileURL(path.join(root, 'spectrum-analyzer-fixed.html')).href);
    if (options.demo) {
      const waiting = page.waitForEvent('download'); await page.locator('#downloadSource').evaluate(el => el.click());
      const download = await waiting;
      assert.equal(fs.readFileSync(await download.path(), 'utf8').replace(/\r\n/g, '\n'), fs.readFileSync(path.join(root, 'spectrum-fixed.py'), 'utf8').replace(/\r\n/g, '\n'));
      await page.locator('#demoButton').click();
      assert.equal(await page.locator('#peaksBody tr').count(), 7);
      await page.screenshot({ path: path.join(root, 'qa/fixed-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(root, 'qa/fixed-mobile.png'), fullPage: true });
      assert.equal(posts, 0);
    } else {
      await page.locator('#apiKey').fill(key);
      await page.locator('#dataFormat').selectOption('column');
      await page.locator('#fileInput').setInputFiles({ name: 'signal.txt', mimeType: 'text/plain', buffer: Buffer.from(options.invalid ? 'invalid data' : samples) });
      if (options.custom) { await page.locator('#reasoningEffort').selectOption('high'); await page.locator('#maxOutputTokens').fill('64000'); }
      await page.locator('#runButton').click();
      if (options.running) { await page.waitForFunction(() => document.getElementById('statusTitle').textContent === 'Выполняется готовый скрипт'); await page.locator('#cancelButton').click(); }
      await page.waitForFunction(() => !document.getElementById('runButton').disabled, null, { timeout: 30000 });
      const rejected = options.badHash || options.badScript || options.badCsv || options.noPython || options.malformed || options.running;
      assert.equal(await page.locator('#downloadJson').isEnabled(), !rejected);
      assert.equal(deletes, 1);
      if (options.running) assert.equal(cancels, 1);
      if (!rejected) {
        assert.equal(await page.locator('#downloadSettings').isEnabled(), true);
        const waiting = page.waitForEvent('download'); await page.locator('#downloadJson').click();
        const download = await waiting;
        const downloaded = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.deepEqual(downloaded, result);
        if (!options.invalid) {
          for (const freq of [1.25, 2.5, 3.75]) assert.ok(downloaded.peaks.some(p => Math.abs(p.frequency_hz - freq) < 1e-8));
          assert.ok(downloaded.harmonic_families.length >= 1);
        }
        if (options.incomplete) assert.ok((await page.locator('#technicalLog').textContent()).includes('полный набор файлов'));
      }
      assert.equal(posts, 1, 'Fixed script must not be rewritten by a repair response');
    }
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.ok(!(await page.locator('body').innerText()).includes(key));
    assert.deepEqual(failures, []);
    process.stdout.write('PASS ' + name + '\n');
  } finally {
    await context.close();
    // Remove only the exact unique test directory created by mkdtemp above.
    assert.ok(path.basename(tmp).startsWith('axel-fixed-') && path.dirname(tmp) === os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const [name, options] of [
      ['offline source download, demo, desktop/mobile', { demo: true }],
      ['real uploaded Python -> JSON -> browser', {}],
      ['selected reasoning and token budget', { custom: true }],
      ['invalid TXT diagnostic JSON', { invalid: true }],
      ['changed script rejected', { badScript: true }],
      ['changed CSV rejected', { badCsv: true }],
      ['wrong input provenance rejected', { badHash: true }],
      ['malformed JSON rejected without rewriting script', { malformed: true }],
      ['incomplete response, complete verified artifacts recovered', { incomplete: true }],
      ['incomplete response without Python rejected', { incomplete: true, noPython: true }],
      ['cancellation and cleanup', { running: true }],
    ]) await scenario(browser, name, options);
    process.stdout.write('11 browser scenarios passed. No real OpenAI requests.\n');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
