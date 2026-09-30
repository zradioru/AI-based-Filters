"""Reproduce the supplied recording with the exact shipped Python script."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fixed", ROOT / "spectrum-fixed.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
source = ROOT / "Axel_Decoder_decoder_output_20260624_235753_20260625_002525_UTC+500_PW=0.400.dec.txt"
out = ROOT / "results/20260625"
out.mkdir(parents=True, exist_ok=True)
cfg = dict(fs=100, low=.1, high=10, segment=8192, hop=4096, prominence=10, smoothing_hz=.02, format="dtr",
           notes="Локальная проверка предоставленной записи, диапазон как на скриншоте.", run_id="record-20260625-fixed-2.2.0",
           input_sha256=m.sha(source.read_bytes()), script_sha256=m.sha((ROOT / "spectrum-fixed.py").read_bytes()))
config_path = out / "settings.json"
config_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
m.run(source, config_path, out)
data = json.loads((out / "analysis.json").read_text(encoding="utf-8"))
print(json.dumps(data["signal"], ensure_ascii=False))
print("TOP LOCAL CONTRAST")
for p in sorted(data["peaks"], key=lambda p: -p["prominence_db"])[:15]:
    print(f'{p["frequency_hz"]:.6f} Hz  amplitude {p["amplitude"]:.6f}  contrast {p["prominence_db"]:.3f} dB')
print("HARMONIC FAMILIES", len(data["harmonic_families"]))
