import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fixed", ROOT / "spectrum-fixed.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def config(**extra):
    cfg = dict(fs=80, low=0.1, high=40, segment=8192, hop=4096, prominence=10,
               smoothing_hz=0.02, format="column")
    cfg.update(extra)
    return cfg


class AnalysisTests(unittest.TestCase):
    def test_local_contrast_beats_large_low_frequency_background(self):
        # Many large low-frequency peaks on a large background must not evict
        # a weaker but much more distinct high-frequency line from the top 80.
        f = np.arange(3000, dtype=float) / 100
        a = np.ones(3000)
        a[:1200] = 10
        a[np.arange(60, 1100, 8)] = 40
        a[2000] = 9
        smoothed, sigma = m.smooth_spectrum(a, .01, 0)
        peaks, truncated = m.find_peaks(f, a, smoothed, .1, 29, 10, .001, sigma)
        self.assertTrue(truncated)
        self.assertEqual(len(peaks), 80)
        self.assertTrue(any(p["frequency_hz"] == 20 for p in peaks))
        self.assertEqual(max(peaks, key=lambda p: p["prominence_db"])["frequency_hz"], 20)

    def test_harmonics_and_amplitudes_with_drift(self):
        t = np.arange(81920) / 80
        x = 1000 + .3 * t + sum(a * np.sin(2 * np.pi * f * t) for f, a in [(1.25, 10), (2.5, 5), (3.75, 3)])
        result, f, raw, smoothed = m.analyze(x, config())
        for freq, expected in [(1.25, 10), (2.5, 5), (3.75, 3)]:
            p = min(result["peaks"], key=lambda p: abs(p["frequency_hz"] - freq))
            self.assertAlmostEqual(p["frequency_hz"], freq, places=10)
            self.assertAlmostEqual(p["amplitude"], expected, places=4)
        self.assertAlmostEqual(result["harmonic_families"][0]["fundamental_hz"], 1.25, places=9)
        self.assertLessEqual(len(result["spectrum"]["frequency_hz"]), 2400)

    def test_constant_linear_zero(self):
        for x in [np.zeros(1000), np.full(1000, 1000.), 1000 + np.arange(1000) * .01]:
            data, _, _, _ = m.analyze(x, config())
            self.assertEqual(data["peaks"], [])

    def test_odd_even_nyquist(self):
        for n in [800, 801]:
            k = n // 2
            x = 7 * np.cos(2 * np.pi * k * np.arange(n) / n)
            _, a = m.amplitude(x, 80)
            # Even Nyquist must not be doubled; odd highest bin must be doubled.
            # Odd near-Nyquist Hann lobes overlap: compare exact DFT convention.
            t = np.linspace(-1, 1, n)
            y = x - x.mean(); y -= t * np.dot(t, y) / np.dot(t, t)
            z = abs(np.sum(y * np.hanning(n) * np.exp(-2j * np.pi * k * np.arange(n) / n))) / np.hanning(n).sum()
            self.assertAlmostEqual(a[-1], z * (1 if n % 2 == 0 else 2), places=8)
        self.assertAlmostEqual(m.amplitude(7 * (-1.) ** np.arange(800), 80)[1][-1], 7, places=5)

    def test_band_limits(self):
        t = np.arange(8192) / 80
        cfg = config(); cfg.update(low=2, high=3)
        r, _, _, _ = m.analyze(np.sin(2*np.pi*1.25*t) + np.sin(2*np.pi*2.5*t), cfg)
        self.assertTrue(r["peaks"])
        self.assertTrue(all(2 <= p["frequency_hz"] <= 3 for p in r["peaks"]))
        self.assertTrue(all(2 <= f <= 3 for f in r["spectrum"]["frequency_hz"]))

    def test_nearby_peaks_merge_with_configured_smoothing(self):
        n, fs = 80000, 80
        t = np.arange(n) / fs
        x = np.sin(2*np.pi*2.496*t) + .9*np.sin(2*np.pi*2.505*t)
        merged, _, _, _ = m.analyze(x, config(fs=fs, low=2.45, high=2.55, segment=8192,
                                               hop=4096, smoothing_hz=.02))
        separate, _, _, _ = m.analyze(x, config(fs=fs, low=2.45, high=2.55, segment=8192,
                                                 hop=4096, smoothing_hz=.002))
        self.assertEqual(len(merged["peaks"]), 1)
        self.assertGreaterEqual(len(separate["peaks"]), 2)
        self.assertAlmostEqual(merged["peaks"][0]["frequency_hz"], 2.496, places=3)

    def test_parsers(self):
        payload = "[!DTR:80:" + "+1-2" * 8 + "]"
        for encoding in ["utf-8-sig", "utf-16", "cp1251"]:
            x, _ = m.parse(("Давление " + payload).encode(encoding), "dtr", 80)
            self.assertEqual(x.tolist(), [1, -2] * 8)
        x, _ = m.parse(("1,25\n-2e1\n" * 8).encode(), "column", 80)
        self.assertEqual(x[:2].tolist(), [1.25, -20])
        for bad in [payload[:-1], payload.replace("80", "40"), payload.replace("+1", "+1junk", 1)]:
            with self.assertRaises(m.InputError): m.parse(bad.encode(), "dtr", 80)
        for bad in ["NaN\n" * 16, "1 2\n" * 16, "1e999\n" * 16, "1\n" * 15]:
            with self.assertRaises(m.InputError): m.parse(bad.encode(), "column", 80)

    def test_run_manifest_and_invalid_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "input.txt"; cfg_path = root / "settings.json"
            for data in [b"1\n" * 64, b"broken data"]:
                source.write_bytes(data)
                cfg = config(input_sha256=m.sha(data), script_sha256=m.sha((ROOT / "spectrum-fixed.py").read_bytes()), run_id="test")
                cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
                m.run(source, cfg_path, root / "out")
                result = json.loads((root / "out/analysis.json").read_text(encoding="utf-8"))
                self.assertEqual(result["provenance"]["config_sha256"], m.sha(cfg_path.read_bytes()))
                self.assertEqual(result["status"], "invalid_input" if data.startswith(b"broken") else "needs_review")
                self.assertEqual((root / "out/analysis.py").read_bytes(), (ROOT / "spectrum-fixed.py").read_bytes())
            cfg["script_sha256"] = "wrong"
            cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
            with self.assertRaises(RuntimeError): m.run(source, cfg_path, root / "out")


if __name__ == "__main__":
    unittest.main()
