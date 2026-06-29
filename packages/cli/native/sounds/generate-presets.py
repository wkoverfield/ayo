#!/usr/bin/env python3
"""
Generate Ayo's starter notification-sound presets as 16-bit PCM mono WAV (44.1kHz).

These are SYNTHESIZED placeholders — distinct + redistributable (no sampled IP).
Swap in designed sounds later; keep the filenames so `AyoSound{kind:"preset"}` ids
stay stable. Output: packages/cli/assets/sounds/<id>.wav

    python3 generate-presets.py
"""
import math, os, struct, wave

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "sounds")


def env(i, n, attack=0.006, release=0.06):
    """Attack/release envelope (avoids click pops at edges)."""
    t, dur = i / SR, n / SR
    a = min(1.0, t / attack) if attack > 0 else 1.0
    r = min(1.0, (dur - t) / release) if release > 0 else 1.0
    return max(0.0, a) * max(0.0, r)


def osc(shape, f, t):
    x = (f * t) % 1.0
    if shape == "sine":
        return math.sin(2 * math.pi * f * t)
    if shape == "square":
        return 1.0 if x < 0.5 else -1.0
    if shape == "saw":
        return 2.0 * x - 1.0
    if shape == "tri":
        return 4.0 * abs(x - 0.5) - 1.0
    raise ValueError(shape)


def tone(freq, dur, shape="sine", vol=0.6, decay=0.0):
    """freq may be a constant or a function of t (for sweeps)."""
    n = int(dur * SR)
    out = []
    for i in range(n):
        t = i / SR
        f = freq(t) if callable(freq) else freq
        s = osc(shape, f, t) * vol * env(i, n)
        if decay:
            s *= math.exp(-decay * t)
        out.append(s)
    return out


def silence(dur):
    return [0.0] * int(dur * SR)


def write(name, samples):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in samples:
            s = max(-1.0, min(1.0, s))
            frames += struct.pack("<h", int(s * 32767))
        w.writeframes(frames)
    print(f"  {name}.wav  ({len(samples)/SR:.2f}s)")


# id -> samples. Distinct timbres so teammates are tellable by ear.
PRESETS = {
    # clean high blip — the default
    "ping": tone(880, 0.16, "sine", 0.6),
    # doorbell ding-dong
    "chime": tone(660, 0.18, "sine", 0.55) + silence(0.02) + tone(988, 0.34, "sine", 0.55),
    # low friendly downward boop
    "boop": tone(lambda t: 330 - 90 * (t / 0.22), 0.22, "tri", 0.6),
    # retro coin: two quick rising squares
    "coin": tone(988, 0.07, "square", 0.4) + tone(1319, 0.2, "square", 0.4, decay=4),
    # kalimba-ish decaying pluck
    "pluck": tone(523, 0.55, "sine", 0.75, decay=6),
    # comedic buzzy airhorn
    "airhorn": tone(233, 0.5, "saw", 0.42),
    # two soft low knocks
    "knock": tone(150, 0.05, "sine", 0.7, decay=30) + silence(0.09)
    + tone(150, 0.09, "sine", 0.7, decay=22),
}

if __name__ == "__main__":
    print("generating presets ->", os.path.normpath(OUT))
    for name, samples in PRESETS.items():
        write(name, samples)
    print("done. ids:", ", ".join(PRESETS))
