"""Axel Spectrum fixed analysis v2.2.0. Python 3 + NumPy; no model decisions.

python spectrum-fixed.py --input input.txt --config settings.json --output result
JSON is written last. Input errors produce diagnostic JSON; execution errors fail.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import sys

import numpy as np

VERSION = "2.2.0"
NUMBER = r"[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?"


class InputError(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    try:
        return data.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("cp1251"), "cp1251"


def parse(data, fmt, fs):
    try:
        text, encoding = decode(data)
    except UnicodeError as e:
        raise InputError("Не удалось декодировать TXT без потери байтов.") from e
    values = []
    if fmt == "column":
        for i, line in enumerate(text.splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            if re.fullmatch(NUMBER, line) is None:
                raise InputError(f"Строка {i}: ожидается один числовой отсчёт.")
            values.append(float(line.replace(",", ".")))
    elif fmt == "dtr":
        count = 0
        for i, line in enumerate(text.splitlines(), 1):
            starts = line.count("[!DTR:")
            if not starts:
                continue
            records = list(re.finditer(r"\[!DTR:([0-9]+(?:\.[0-9]+)?):([^\[\]]*)\]", line))
            if len(records) != starts:
                raise InputError(f"Строка {i}: повреждённая или незакрытая запись DTR.")
            for match in records:
                rate, payload = float(match[1]), match[2].strip()
                if not math.isclose(rate, fs, rel_tol=1e-12, abs_tol=1e-12):
                    raise InputError(f"Строка {i}: Fs в DTR ({rate}) не совпадает с {fs} Гц.")
                if re.fullmatch(r"(?:[+-]\d+\s*)+", payload) is None:
                    raise InputError(f"Строка {i}: повреждены отсчёты DTR.")
                values.extend(float(v) for v in re.findall(r"[+-]\d+", payload))
                count += 1
        if count == 0:
            raise InputError("DTR-записей не найдено.")
    else:
        raise InputError("Неизвестный формат TXT.")
    x = np.asarray(values, dtype=np.float64)
    if len(x) < 16 or not np.isfinite(x).all():
        raise InputError("Нужно минимум 16 конечных отсчётов.")
    return x, encoding


def amplitude(x, fs):
    # Centred least-squares linear detrend, then symmetric Hann and real FFT.
    n = len(x)
    t = np.linspace(-1.0, 1.0, n)
    y = x - np.mean(x)
    y -= t * (np.dot(t, y) / np.dot(t, t))
    if np.max(np.abs(y)) <= 32 * np.finfo(float).eps * max(float(np.max(np.abs(x))), np.finfo(float).tiny):
        y[:] = 0  # Do not interpret floating-point detrend residuals as tones.
    w = np.hanning(n)
    a = np.abs(np.fft.rfft(y * w)) / w.sum()
    a[1:-1 if n % 2 == 0 else None] *= 2
    return np.fft.rfftfreq(n, 1 / fs), a


def smooth_spectrum(a, df, width_hz):
    """Gaussian smoothing of linear amplitude; width_hz is the FWHM."""
    if width_hz <= 0 or len(a) < 3:
        return a.copy(), 0.0
    sigma_bins = width_hz / (2 * math.sqrt(2 * math.log(2)) * df)
    if sigma_bins < 0.25:
        return a.copy(), sigma_bins
    radius = min(len(a) - 1, max(1, int(math.ceil(4 * sigma_bins))))
    offsets = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (offsets / sigma_bins) ** 2)
    kernel /= kernel.sum()
    size = len(a) + len(kernel) - 1
    nfft = 1 << (size - 1).bit_length()
    transformed = np.fft.rfft(kernel, nfft)
    start = radius
    full = np.fft.irfft(np.fft.rfft(a, nfft) * transformed, nfft)[:size]
    norm = np.fft.irfft(np.fft.rfft(np.ones_like(a), nfft) * transformed, nfft)[:size]
    smoothed = full[start:start + len(a)] / np.maximum(norm[start:start + len(a)], np.finfo(float).tiny)
    return np.maximum(smoothed, 0), sigma_bins


def find_peaks(f, raw, smoothed, low, high, threshold, minimum_separation_hz, sigma_bins):
    # Detect on the smoothed spectrum; report the strongest raw FFT bin in
    # each merged band so amplitude keeps its one-sided FFT meaning.
    candidates = np.flatnonzero((smoothed[1:-1] > smoothed[:-2]) & (smoothed[1:-1] >= smoothed[2:])) + 1
    if len(smoothed) > 1 and smoothed[-1] > smoothed[-2]:
        candidates = np.append(candidates, len(smoothed) - 1)
    candidates = candidates[(f[candidates] >= low) & (f[candidates] <= high)]
    floor = max(float(smoothed.max()) * 1e-10, np.finfo(float).tiny)
    df = float(f[1] - f[0]) if len(f) > 1 else 1.0
    guard = max(2, int(math.ceil(2 * sigma_bins)))
    radius = max(50, 5 * guard)
    representative_radius = max(1, int(math.ceil(max(minimum_separation_hz, df) / (2 * df))))
    result = []
    for k in candidates:
        if smoothed[k] <= floor:
            continue
        smooth_background = np.concatenate((smoothed[max(1, k - radius):max(1, k - guard)],
                                            smoothed[k + guard + 1:k + radius + 1]))
        smooth_base = max(float(np.median(smooth_background)) if len(smooth_background) else floor, floor)
        smooth_contrast = 20 * math.log10(float(smoothed[k]) / smooth_base)
        left, right = max(1, k - representative_radius), min(len(raw), k + representative_radius + 1)
        raw_index = left + int(np.argmax(raw[left:right]))
        raw_floor = max(float(raw.max()) * 1e-10, np.finfo(float).tiny)
        raw_background = np.concatenate((raw[max(1, raw_index - 50):max(1, raw_index - 2)],
                                         raw[raw_index + 3:raw_index + 51]))
        raw_base = max(float(np.median(raw_background)) if len(raw_background) else raw_floor, raw_floor)
        prominence = 20 * math.log10(float(raw[raw_index]) / raw_base)
        if prominence >= threshold:
            result.append({"frequency_hz": float(f[raw_index]), "amplitude": float(raw[raw_index]),
                           "smoothed_center_hz": float(f[k]), "smoothed_amplitude": float(smoothed[k]),
                           "prominence_db": prominence, "smoothed_contrast_db": smooth_contrast,
                           "family_id": None, "harmonic_order": None})
    result.sort(key=lambda p: (-p["prominence_db"], -p["amplitude"], p["frequency_hz"]))
    selected = []
    for peak in result:
        if all(abs(peak["smoothed_center_hz"] - other["smoothed_center_hz"]) >= minimum_separation_hz
               for other in selected):
            selected.append(peak)
    result = selected
    truncated = len(result) > 80
    return sorted(result[:80], key=lambda p: p["frequency_hz"]), truncated


def families(peaks, df):
    # Only observed fundamentals, at least three different orders, maximum 12.
    # Greedy non-overlapping groups; these are hypotheses, not source identity.
    result, used = [], set()
    for i, base in enumerate(peaks):
        if i in used:
            continue
        f0 = base["frequency_hz"]
        tolerance = 1.5 * df
        # Avoid ambiguous order assignments when fundamental is too close to DC.
        if f0 <= 3 * df:
            continue
        matches = {1: (i, 0.0)}
        for j in range(i + 1, len(peaks)):
            if j in used:
                continue
            order = int(round(peaks[j]["frequency_hz"] / f0))
            error = abs(peaks[j]["frequency_hz"] - order * f0)
            if 2 <= order <= 12 and error <= tolerance:
                if order not in matches or error < matches[order][1]:
                    matches[order] = (j, error)
        if len(matches) < 3:
            continue
        orders = np.asarray(sorted(matches), dtype=float)
        indices = [matches[int(o)][0] for o in orders]
        freqs = np.asarray([peaks[j]["frequency_hz"] for j in indices])
        fitted = float(np.dot(orders, freqs) / np.dot(orders, orders))
        residual = np.abs(freqs - orders * fitted)
        if float(residual.max()) > tolerance:
            continue
        ident = f"H{len(result) + 1}"
        for order, j in zip(orders, indices):
            peaks[j]["family_id"], peaks[j]["harmonic_order"] = ident, int(order)
            used.add(j)
        result.append({"id": ident, "fundamental_hz": fitted, "peak_indices": indices,
                       "fitting_error_hz": float(np.sqrt(np.mean(residual ** 2))),
                       "tracked_min_hz": None, "tracked_max_hz": None,
                       "assessment_ru": "Не менее трёх пиков с целыми порядками 1–12; допуск 1.5 шага FFT. Наблюдаемая основная частота обязательна. Совпадение не доказывает общий источник."})
    return result


def analyze(x, cfg):
    fs, low, high = cfg["fs"], cfg["low"], cfg["high"]
    n = len(x)
    segment, hop = min(cfg["segment"], n), min(cfg["hop"], min(cfg["segment"], n))
    f, raw = amplitude(x, fs)
    smoothed, sigma_bins = smooth_spectrum(raw, fs / n, cfg["smoothing_hz"])
    if not np.isfinite(raw).all() or not np.isfinite(smoothed).all():
        raise InputError("Переполнение вычислений: проверьте масштаб отсчётов.")
    peaks, truncated = find_peaks(f, raw, smoothed, low, high, cfg["prominence"],
                                  cfg["smoothing_hz"], sigma_bins)
    groups = families(peaks, fs / n)
    warnings = ["Равномерность отсчётов и отсутствие пропусков по этому формату не подтверждены; предполагается непрерывная запись.",
                "Частота и amplitude пика соответствуют сильнейшему исходному FFT-бину объединённой полосы. Межбиновые частоты могут иметь заниженную амплитуду; df не является доверительным интервалом.",
                f"Обнаружение и график используют гауссово сглаживание амплитуды с FWHM={cfg['smoothing_hz']:g} Гц; разные физические линии внутри этой ширины могут объединиться.",
                "Поиск гармоник — фиксированная эвристика; отсутствие основной частоты, близкие линии и общий делитель нескольких источников могут давать пропуски или ложные группы."]
    if truncated:
        warnings.append("Показаны 80 пиков с наибольшим превышением над локальным фоном, а не с наибольшей абсолютной амплитудой.")
    if n < cfg["segment"]:
        warnings.append("Запись короче окна: размер окна уменьшен до N.")
    starts = np.arange(0, n - segment + 1, hop, dtype=np.int64)
    total_windows = len(starts)
    max_windows = max(2, min(1000, 16000000 // segment))
    if total_windows > max_windows:
        starts = starts[np.unique(np.linspace(0, total_windows - 1, max_windows, dtype=int))]
        warnings.append(f"Для трекинга выбрано {len(starts)} равномерно распределённых окон; быстрые изменения между ними могут быть пропущены.")
    tracked = [[] for _ in groups]
    if groups and len(starts) >= 2:
        for start in starts:
            wf, wraw = amplitude(x[start:start + segment], fs)
            wsmooth, wsigma = smooth_spectrum(wraw, fs / segment, cfg["smoothing_hz"])
            wp, _ = find_peaks(wf, wraw, wsmooth, low, high, cfg["prominence"],
                               cfg["smoothing_hz"], wsigma)
            for k, group in enumerate(groups):
                near = [p for p in wp if abs(p["frequency_hz"] - group["fundamental_hz"]) <= 2 * fs / segment]
                if near:
                    tracked[k].append(min(near, key=lambda p: abs(p["frequency_hz"] - group["fundamental_hz"]))["frequency_hz"])
    for group, values in zip(groups, tracked):
        group["tracking_detections"] = len(values)
        if len(values) >= 2:
            group["tracked_min_hz"], group["tracked_max_hz"] = min(values), max(values)
        group["assessment_ru"] += f" Трекинг основной: {len(values)} обнаружений; допуск ±2 Fs/окно, шаг {fs / segment:.6g} Гц. Диапазон — по бинам, не точная оценка дрейфа."
    mask = np.flatnonzero((f >= low) & (f <= high))
    bins = [int(bucket[np.argmax(smoothed[bucket])]) for bucket in np.array_split(mask, min(2400, len(mask))) if len(bucket)] if len(mask) else []
    data = {"schema_version": "1.0", "status": "needs_review", "warnings": warnings,
            "signal": {"sample_rate_hz": fs, "sample_count": n, "duration_s": n / fs,
                       "units": "исходные единицы", "mean": float(np.mean(x)), "std": float(np.std(x, ddof=1)), "min": float(x.min()), "max": float(x.max())},
            "analysis": {"frequency_range_hz": [low, high], "fft_size": n, "bin_spacing_hz": fs / n,
                         "window": "hann_symmetric", "detrend": "linear", "amplitude_convention": "one_sided_peak",
                         "segment_samples": segment, "hop_samples": hop, "peak_prominence_db": cfg["prominence"],
                         "background_method": "peak contrast uses raw median of +/-50 bins excluding +/-2; candidates use Gaussian-smoothed amplitude",
                         "peak_ranking": "local_background_contrast_db",
                         "smoothing_method": "gaussian_amplitude_fwhm", "smoothing_hz": cfg["smoothing_hz"],
                         "smoothing_sigma_bins": sigma_bins, "minimum_peak_separation_hz": cfg["smoothing_hz"],
                         "tracking_windows_total": total_windows, "tracking_windows_used": len(starts),
                         "harmonic_max_order": 12, "harmonic_tolerance_bins": 1.5},
            "peaks": peaks, "harmonic_families": groups,
            "spectrum": {"frequency_hz": f[bins].tolist(), "amplitude": smoothed[bins].tolist(), "representation": "max_per_bucket"},
            "summary_ru": f"Скрипт {VERSION}: {n} отсчётов, {n / fs:.3f} с, Fs={fs:g} Гц. Спектр сглажен по частоте с FWHM={cfg['smoothing_hz']:g} Гц; более близкие максимумы объединяются. В диапазоне {low:g}–{high:g} Гц найдено {len(peaks)} пиков и {len(groups)} предполагаемых гармонических семейств. Пики автоматически не объявляются помехами. FIR-фильтрация не выполняется."}
    return data, f, raw, smoothed


def run(input_path, config_path, output_dir):
    source, config_bytes, script = Path(input_path).read_bytes(), Path(config_path).read_bytes(), Path(__file__).read_bytes()
    cfg = json.loads(config_bytes)
    # Detect changed uploads before calculation. Browser verifies the same hashes.
    if sha(source) != cfg["input_sha256"] or sha(script) != cfg["script_sha256"]:
        raise RuntimeError("Контрольная сумма входного файла или скрипта не совпала.")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    script_target = out / "analysis.py"
    if script_target.resolve() != Path(__file__).resolve():
        shutil.copyfile(__file__, script_target)
    provenance = {"script_version": VERSION, "script_sha256": sha(script), "input_sha256": sha(source),
                  "config_sha256": sha(config_bytes), "run_id": cfg["run_id"],
                  "python_version": sys.version.split()[0], "numpy_version": np.__version__}
    try:
        if not all(math.isfinite(cfg[k]) for k in ("fs", "low", "high", "prominence", "smoothing_hz")) or not (0 <= cfg["low"] < cfg["high"] <= cfg["fs"] / 2):
            raise InputError("Некорректные Fs или диапазон частот.")
        if not (0 <= cfg["smoothing_hz"] <= cfg["high"] - cfg["low"]):
            raise InputError("Ширина сглаживания должна быть от 0 до ширины анализируемого диапазона.")
        if not (isinstance(cfg["segment"], int) and isinstance(cfg["hop"], int) and 1 <= cfg["hop"] <= cfg["segment"] and cfg["segment"] >= 16):
            raise InputError("Некорректные параметры временных окон.")
        x, encoding = parse(source, cfg["format"], cfg["fs"])
        data, f, raw, smoothed = analyze(x, cfg)
        provenance["encoding"] = encoding
        csv = out / "spectrum.csv"
        np.savetxt(csv, np.column_stack((f, raw, smoothed)), delimiter=",",
                   header="frequency_hz,raw_amplitude,smoothed_amplitude", comments="", fmt="%.17g")
        provenance["spectrum_csv_sha256"] = sha(csv.read_bytes())
    except InputError as e:
        data = {"schema_version": "1.0", "status": "invalid_input", "summary_ru": str(e), "warnings": []}
    data["provenance"] = provenance
    data["user_notes"] = cfg.get("notes", "")
    # Completed JSON is the final commit marker; disallow NaN/Infinity.
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2)
    temporary = out / "analysis.json.tmp"
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(out / "analysis.json")
    print(json.dumps({"status": data["status"], "run_id": cfg["run_id"], "script_version": VERSION}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    run(args.input, args.config, args.output)
