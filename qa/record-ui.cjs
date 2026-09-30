const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const bundle = path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const { chromium } = createRequire(path.join(bundle, 'qa.cjs'))('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const name of ['spectrum-analyzer-fixed.html', 'spectrum-analyzer.html']) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('https://api.openai.com/**', route => { errors.push('Unexpected API request'); return route.abort(); });
      await page.goto(pathToFileURL(path.join(root, name)).href);
      await page.locator('#importJson').setInputFiles(path.join(root, 'results/20260625/analysis.json'));
      await page.waitForFunction(() => document.getElementById('statusTitle').textContent === 'Загружен результат из JSON');
      assert.equal(await page.locator('#metricCount').innerText(), '162 896');
      assert.equal(await page.locator('#metricPeak').innerText(), '0,2173');
      const first = await page.locator('#peaksBody tr').first().innerText();
      assert.ok(first.includes('5,001351'), first);
      const peakTable = await page.locator('#peaksBody').innerText();
      assert.ok(peakTable.includes('2,505279'), peakTable);
      assert.ok(!peakTable.includes('2,496071'), 'Nearby 2.496/2.505 Hz maxima must be merged');
      const labels = await page.locator('#spectrumPlot').textContent();
      assert.ok(labels.includes('5,001'), labels);
      assert.ok(labels.includes('2,505'), labels);
      assert.ok(labels.includes('4,255'), labels);
      if (name.includes('fixed')) {
        await page.locator('section[aria-label="Спектр сигнала"]').screenshot({ path: path.join(root, 'results/20260625/spectrum-corrected.png') });
        await page.screenshot({ path: path.join(root, 'results/20260625/application-corrected.png'), fullPage: true });
        // Preserve exact SVG in addition to the raster preview.
        fs.writeFileSync(path.join(root, 'results/20260625/spectrum-corrected.svg'), await page.locator('#spectrumPlot').evaluate(svg => { const copy=svg.cloneNode(true); copy.setAttribute('xmlns','http://www.w3.org/2000/svg'); return copy.outerHTML; }));
      }
      await page.locator('#peakOrder').selectOption('amplitude');
      const byAmplitude = await page.locator('#peaksBody tr').first().innerText();
      assert.ok(byAmplitude.includes('0,291597'), byAmplitude);
      assert.equal(await page.locator('#metricPeak').innerText(), '0,2173');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ' mobile overflow');
      assert.deepEqual(errors, []);
      console.log('PASS actual recording, frequencies, ranking switch, offline import: ' + name);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
