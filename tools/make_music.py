#!/usr/bin/env python3
"""PostForge built-in music library.

Every track here is composed and synthesised by this script (no samples, no third-party
recordings), so PostForge owns them outright and users can put them in any post.

Run:  python3 tools/make_music.py   (needs numpy + scipy + ffmpeg on PATH or FFMPEG=…)
Writes public/music/<key>.mp3 and public/music/library.json
"""
import json, os, subprocess, sys
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
LEN = 30.0                      # seconds — longer than any slideshow, loops cleanly
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'music')
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')

NOTE = {n: i for i, n in enumerate(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'])}
def hz(midi): return 440.0 * 2 ** ((midi - 69) / 12)
def chord(root, kind, octave=4):
    base = 12 * (octave + 1) + NOTE[root]
    iv = {'maj': [0, 4, 7], 'min': [0, 3, 7], 'maj7': [0, 4, 7, 11], 'min7': [0, 3, 7, 10], '7': [0, 4, 7, 10],
          'sus2': [0, 2, 7], 'add9': [0, 4, 7, 14]}[kind]
    return [base + i for i in iv]

# ---------------------------------------------------------------- building blocks
def env(n, a=0.005, d=0.1, s=0.6, r=0.1):
    e = np.ones(n) * s
    ai = min(int(a * SR), n); di = min(int(d * SR), n - ai); ri = min(int(r * SR), n)
    if ai: e[:ai] = np.linspace(0, 1, ai)
    if di: e[ai:ai + di] = np.linspace(1, s, di)
    if ri: e[-ri:] *= np.linspace(1, 0, ri)
    return e

def lowpass(x, f, order=2):
    return sosfilt(butter(order, min(f, SR / 2 - 100) / (SR / 2), 'low', output='sos'), x)
def highpass(x, f, order=2):
    return sosfilt(butter(order, f / (SR / 2), 'high', output='sos'), x)
def bandpass(x, lo, hi):
    return sosfilt(butter(2, [lo / (SR / 2), hi / (SR / 2)], 'band', output='sos'), x)

def pluck(f, dur, bright=0.5, rng=None):
    """Karplus-Strong string (guitar / ukulele / harp-like)."""
    n = int(dur * SR); p = max(2, int(SR / f))
    buf = (rng or np.random).uniform(-1, 1, p)
    buf = lowpass(buf, 2000 + 8000 * bright) if p > 20 else buf
    out = np.zeros(n + p)
    decay = 0.996
    for k in range(0, n, p):                      # one period at a time (vectorised Karplus-Strong)
        out[k:k + p] = buf
        buf = decay * 0.5 * (buf + np.roll(buf, -1))
    out = out[:n]
    return out * env(n, 0.002, 0.05, 1.0, 0.05)

def keys(f, dur, bright=0.5):
    """Electric-piano / piano-ish: decaying harmonics."""
    n = int(dur * SR); t = np.arange(n) / SR
    x = np.zeros(n)
    for k, a in enumerate([1, 0.5, 0.28, 0.16, 0.09, 0.05], start=1):
        x += a * np.exp(-t * (1.6 + k * (1.2 - bright * 0.6))) * np.sin(2 * np.pi * f * k * t + 0.2 * k)
    x += 0.15 * np.sin(2 * np.pi * f * t) * np.exp(-t * 0.6)  # body
    return x * env(n, 0.004, 0.05, 1.0, 0.08)

def bell(f, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    mod = 2.4 * np.exp(-t * 3) * np.sin(2 * np.pi * f * 3.5 * t)
    return np.sin(2 * np.pi * f * t + mod) * np.exp(-t * 2.2) * env(n, 0.002, 0.02, 1.0, 0.05)

def saw(f, t, detune=0.0):
    x = np.zeros_like(t)
    for d in (-detune, 0, detune) if detune else (0,):
        ph = (f * (1 + d) * t) % 1.0
        x += 2 * ph - 1
    return x / (3 if detune else 1)

def pad(freqs, dur, cutoff=1800, att=0.6):
    n = int(dur * SR); t = np.arange(n) / SR
    x = sum(saw(hz(m), t, 0.006) for m in freqs) / len(freqs)
    x = lowpass(x, cutoff, 2)
    return x * env(n, att, 0.3, 0.85, min(0.8, dur * 0.4))

def synth_lead(f, dur, cutoff=3000):
    n = int(dur * SR); t = np.arange(n) / SR
    x = 0.6 * saw(f, t, 0.004) + 0.4 * np.sign(np.sin(2 * np.pi * f * t)) * 0.5
    vib = 1 + 0.003 * np.sin(2 * np.pi * 5.5 * t)
    x = lowpass(x * vib, cutoff)
    return x * env(n, 0.01, 0.12, 0.55, 0.06)

def bass(f, dur, kind='sine'):
    n = int(dur * SR); t = np.arange(n) / SR
    if kind == 'saw':
        x = lowpass(saw(f, t, 0.003), 700, 2)
    else:
        x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * f * 2 * t)
    return x * env(n, 0.005, 0.08, 0.75, 0.05)

def kick(punch=1.0):
    n = int(0.42 * SR); t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 28) * punch
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * np.exp(-t * 7.5)
    x[:200] += np.random.uniform(-0.3, 0.3, 200) * np.linspace(1, 0, 200)
    return x

def snare(tone=0.4):
    n = int(0.28 * SR); t = np.arange(n) / SR
    noise = bandpass(np.random.uniform(-1, 1, n), 1200, 8000) * np.exp(-t * 16)
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 26)
    return noise * (1 - tone) * 1.6 + body * tone

def clap():
    n = int(0.25 * SR); t = np.arange(n) / SR
    x = bandpass(np.random.uniform(-1, 1, n), 900, 5000)
    e = np.exp(-t * 22)
    for d in (0.012, 0.024):
        k = int(d * SR); e[:k] = np.maximum(e[:k], 0)
        e[k:k + 300] += 0.8 * np.exp(-np.arange(min(300, n - k)) / 60)
    return x * e * 1.4

def hat(open_=False):
    n = int((0.22 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return bandpass(np.random.uniform(-1, 1, n), 6500, 13000) * np.exp(-t * (14 if open_ else 70)) * 0.8

def shaker():
    n = int(0.09 * SR); t = np.arange(n) / SR
    e = np.minimum(t / 0.02, 1) * np.exp(-t * 35)
    return bandpass(np.random.uniform(-1, 1, n), 5000, 12000) * e

# ---------------------------------------------------------------- mixing helpers
class Track:
    def __init__(self, bpm):
        self.bpm = bpm; self.beat = 60.0 / bpm
        self.L = np.zeros(int(LEN * SR) + SR * 3); self.R = np.zeros_like(self.L)
        self.verb_send = np.zeros_like(self.L)
    def add(self, x, at, gain=1.0, pan=0.0, verb=0.0):
        i = int(at * SR)
        if i >= len(self.L): return
        x = x[: len(self.L) - i] * gain
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        self.L[i:i + len(x)] += x * l * 1.41; self.R[i:i + len(x)] += x * r * 1.41
        if verb: self.verb_send[i:i + len(x)] += x * verb
    def render(self, verb_len=2.2, name='track'):
        n = int(verb_len * SR); t = np.arange(n) / SR
        ir_l = np.random.uniform(-1, 1, n) * np.exp(-t * 3.2 / verb_len * 2)
        ir_r = np.random.uniform(-1, 1, n) * np.exp(-t * 3.2 / verb_len * 2)
        ir_l = lowpass(ir_l, 6000); ir_r = lowpass(ir_r, 6000)
        wl = fftconvolve(self.verb_send, ir_l)[: len(self.L)] * 0.035
        wr = fftconvolve(self.verb_send, ir_r)[: len(self.L)] * 0.035
        L, R = self.L + wl, self.R + wr
        n = int(LEN * SR); L, R = L[:n], R[:n]
        st = np.stack([L, R], 1)
        st = highpass(st.T, 30).T
        st /= (np.max(np.abs(st)) + 1e-9)
        st = np.tanh(st * 1.15) / np.tanh(1.15)        # gentle limiting
        fi, fo = int(0.04 * SR), int(1.6 * SR)
        st[:fi] *= np.linspace(0, 1, fi)[:, None]
        st[-fo:] *= np.linspace(1, 0, fo)[:, None]
        return st * 0.89

def bars(t): return int(LEN / (4 * t.beat)) + 1

def drum_pattern(t, style, start_bar=0, gain=1.0):
    b = t.beat
    for bar in range(start_bar, bars(t)):
        s = bar * 4 * b
        if style == 'four':
            for k in range(4): t.add(kick(), s + k * b, 0.9 * gain)
            for k in (1, 3): t.add(clap(), s + k * b, 0.45 * gain, verb=0.3)
            for k in range(4): t.add(hat(True), s + k * b + b / 2, 0.18 * gain, 0.3)
            for k in range(8): t.add(hat(), s + k * b / 2, 0.12 * gain, -0.3)
        elif style == 'pop':
            for k in (0, 2.5): t.add(kick(), s + k * b, 0.85 * gain)
            if bar % 2: t.add(kick(), s + 3.5 * b, 0.6 * gain)
            for k in (1, 3): t.add(snare(0.35), s + k * b, 0.5 * gain, verb=0.35)
            for k in range(8): t.add(hat(), s + k * b / 2, (0.14 if k % 2 else 0.09) * gain, 0.25)
        elif style == 'lofi':
            for k in (0, 1.75, 2.5): t.add(kick(0.7), s + k * b, 0.7 * gain)
            for k in (1, 3): t.add(snare(0.55), s + k * b + 0.02, 0.38 * gain, verb=0.4)
            for k in range(8): t.add(hat(), s + k * b / 2 + (0.03 if k % 2 else 0), 0.07 * gain, 0.2)
        elif style == 'boom':
            for k in (0, 0.75, 2.5): t.add(kick(1.1), s + k * b, 0.9 * gain)
            for k in (1, 3): t.add(snare(0.3), s + k * b, 0.6 * gain, verb=0.25)
            for k in range(16):
                if k % 4 != 2: t.add(hat(), s + k * b / 4, 0.06 * gain, 0.3)
        elif style == 'acoustic':
            for k in (0, 2): t.add(kick(0.6), s + k * b, 0.5 * gain)
            for k in (1, 3): t.add(clap(), s + k * b, 0.33 * gain, -0.1, verb=0.4)
            for k in range(8): t.add(shaker(), s + k * b / 2, (0.16 if k % 2 else 0.1) * gain, 0.35)
        elif style == 'soft':
            t.add(kick(0.5), s, 0.45 * gain)
            t.add(kick(0.5), s + 2.5 * b, 0.35 * gain)
            for k in range(4): t.add(shaker(), s + k * b + b / 2, 0.09 * gain, 0.3)

def chords_over(t, prog, fn, per_bar=1, start_bar=0, end_bar=None):
    b = t.beat; end_bar = end_bar or bars(t)
    for bar in range(start_bar, end_bar):
        c = prog[bar % len(prog)]
        fn(bar * 4 * b, c, bar)

def melody(t, prog, inst, pattern, octave_shift=12, gain=0.3, start_bar=0, seed=1, pan=0.0, verb=0.3, length=0.5):
    rng = np.random.default_rng(seed)
    b = t.beat
    phrase = [rng.integers(0, 4) for _ in range(len(pattern))]
    for bar in range(start_bar, bars(t)):
        c = prog[bar % len(prog)]
        tones = sorted(set(c + [c[0] + 12]))
        if bar % 4 == 0: phrase = [rng.integers(0, len(tones)) for _ in range(len(pattern))]
        for (pos, dur), idx in zip(pattern, phrase):
            m = tones[idx % len(tones)] + octave_shift
            t.add(inst(hz(m), dur * b * length * 2), bar * 4 * b + pos * b, gain, pan, verb)

# ---------------------------------------------------------------- the tracks
def sunny_market():
    t = Track(118); rng = np.random.default_rng(3)
    prog = [chord('C', 'maj'), chord('G', 'maj', 3), chord('A', 'min', 3), chord('F', 'maj', 3)]
    def strum(s, c, bar):
        for k in range(8):
            if k in (0, 3, 4, 6):
                for j, m in enumerate(c): t.add(pluck(hz(m + 12), 0.6, 0.7, rng), s + k * t.beat / 2 + j * 0.008, 0.14, -0.25, 0.2)
        t.add(bass(hz(c[0] - 12), t.beat * 1.8), s, 0.5); t.add(bass(hz(c[0] - 12), t.beat * 1.6), s + 2 * t.beat, 0.45)
    chords_over(t, prog, strum)
    melody(t, prog, lambda f, d: keys(f, d, 0.8), [(0, .5), (1, .5), (1.5, .5), (2.5, .5), (3, 1)], 12, 0.2, start_bar=2, seed=4, pan=0.2)
    drum_pattern(t, 'pop', 1)
    return t

def chill_cafe():
    t = Track(80)
    prog = [chord('D', 'min7', 3), chord('G', '7', 3), chord('C', 'maj7', 3), chord('A', 'min7', 3)]
    def ep(s, c, bar):
        for j, m in enumerate(c): t.add(keys(hz(m + 12), t.beat * 3.6, 0.3), s + j * 0.015, 0.16, -0.15, 0.5)
        for j, m in enumerate(c): t.add(keys(hz(m + 12), t.beat * 1.2, 0.3), s + 2.5 * t.beat + j * 0.015, 0.09, -0.15, 0.5)
        t.add(bass(hz(c[0] - 12), t.beat * 2.5), s, 0.5); t.add(bass(hz(c[2] - 12), t.beat * 1.2), s + 2.75 * t.beat, 0.35)
    chords_over(t, prog, ep)
    melody(t, prog, lambda f, d: keys(f, d, 0.6), [(0.5, .5), (1.5, .25), (2, .75), (3.25, .5)], 24, 0.1, start_bar=2, seed=7, pan=0.25, verb=0.6)
    drum_pattern(t, 'lofi', 0)
    crackle = (np.random.uniform(0, 1, len(t.L)) > 0.9993) * np.random.uniform(-0.3, 0.3, len(t.L))
    t.add(lowpass(crackle, 4000) + lowpass(np.random.uniform(-1, 1, len(t.L)), 900) * 0.008, 0, 0.6)
    return t

def big_sale():
    t = Track(128)
    prog = [chord('A', 'min', 3), chord('F', 'maj', 3), chord('C', 'maj', 3), chord('G', 'maj', 3)]
    def stabs(s, c, bar):
        for k in range(8):
            if k % 2 == 1 or k == 0:
                for m in c: t.add(synth_lead(hz(m + 12), t.beat * 0.35, 2600), s + k * t.beat / 2, 0.09, 0, 0.25)
        for k in range(8): t.add(bass(hz(c[0] - 12), t.beat * 0.45, 'saw'), s + k * t.beat / 2, 0.42)
    chords_over(t, prog, stabs)
    melody(t, prog, lambda f, d: synth_lead(f, d, 4200), [(0, .5), (0.75, .25), (1.5, .5), (2, .5), (3, .5), (3.5, .5)], 24, 0.1, 4, seed=11, pan=0.15)
    drum_pattern(t, 'four', 0)
    return t

def bright_business():
    t = Track(105)
    prog = [chord('E', 'maj', 3), chord('B', 'maj', 3), chord('C#', 'min', 3), chord('A', 'add9', 3)]
    def arp(s, c, bar):
        seq = c + [c[1] + 12, c[0] + 12, c[1] + 12, c[2]]
        for k in range(8): t.add(keys(hz(seq[k % len(seq)] + 12), t.beat * 0.9, 0.7), s + k * t.beat / 2, 0.15, (k % 2) * 0.4 - 0.2, 0.35)
        t.add(pad(c, 4 * t.beat, 1400, 0.4), s, 0.12, 0, 0.4)
        t.add(bass(hz(c[0] - 12), t.beat * 3.8), s, 0.45)
    chords_over(t, prog, arp)
    drum_pattern(t, 'soft', 2)
    return t

def festive_bells():
    t = Track(112)
    prog = [chord('F', 'maj', 3), chord('C', 'maj', 3), chord('D', 'min', 3), chord('A#', 'maj', 3)]
    def go(s, c, bar):
        for k in range(4):
            for j, m in enumerate(c): t.add(keys(hz(m + 12), t.beat * 0.8, 0.6), s + k * t.beat + 0.5 * t.beat + j * 0.01, 0.08, -0.2, 0.3)
        t.add(bass(hz(c[0] - 12), t.beat * 1.8), s, 0.45); t.add(bass(hz(c[2] - 24), t.beat * 1.8), s + 2 * t.beat, 0.4)
    chords_over(t, prog, go)
    melody(t, prog, bell, [(0, .5), (0.5, .5), (1, 1), (2, .5), (2.5, .5), (3, 1)], 24, 0.13, 0, seed=21, pan=0.2, verb=0.5)
    for bar in range(bars(t)):
        for k in range(8): t.add(shaker(), bar * 4 * t.beat + k * t.beat / 2, 0.12, 0.4)
        for k in (1, 3): t.add(clap(), bar * 4 * t.beat + k * t.beat, 0.3, 0, 0.3)
        t.add(kick(0.7), bar * 4 * t.beat, 0.6); t.add(kick(0.7), bar * 4 * t.beat + 2 * t.beat, 0.55)
    return t

def acoustic_morning():
    t = Track(96); rng = np.random.default_rng(5)
    prog = [chord('G', 'maj', 3), chord('D', 'maj', 3), chord('E', 'min', 3), chord('C', 'add9', 3)]
    def pick(s, c, bar):
        seq = [c[0] - 12, c[2], c[1] + 12, c[2], c[0] + 12, c[2], c[1] + 12, c[2]]
        for k, m in enumerate(seq): t.add(pluck(hz(m + 12), 1.2, 0.45, rng), s + k * t.beat / 2, 0.22, -0.2 + (k % 3) * 0.2, 0.3)
        t.add(bass(hz(c[0] - 12), t.beat * 3.5), s, 0.3)
    chords_over(t, prog, pick)
    melody(t, prog, lambda f, d: pluck(f, d * 2, 0.8, rng), [(0, 1), (1.5, .5), (2, 1), (3, .5)], 24, 0.15, 2, seed=8, pan=0.3)
    drum_pattern(t, 'acoustic', 1)
    return t

def luxury_night():
    t = Track(88)
    prog = [chord('C', 'min7', 3), chord('G#', 'maj7', 2), chord('A#', 'maj', 2), chord('G', 'min7', 2)]
    def lux(s, c, bar):
        t.add(pad([m + 12 for m in c], 4 * t.beat + 0.3, 1100, 0.9), s, 0.2, 0, 0.6)
        t.add(bass(hz(c[0]), t.beat * 3.8), s, 0.5)
        for j, m in enumerate(c[1:]): t.add(keys(hz(m + 24), t.beat * 2, 0.4), s + t.beat * (1.5 + j * 0.5), 0.08, 0.3, 0.7)
    chords_over(t, prog, lux)
    drum_pattern(t, 'lofi', 2, 0.8)
    return t

def tech_pulse():
    t = Track(122)
    prog = [chord('B', 'min', 3), chord('G', 'maj', 3), chord('D', 'maj', 3), chord('A', 'maj', 3)]
    def arp(s, c, bar):
        seq = [c[0], c[1], c[2], c[0] + 12, c[2], c[1]]
        for k in range(16): t.add(synth_lead(hz(seq[k % 6] + 12), t.beat * 0.22, 1800 + 1600 * ((bar % 4) / 3)), s + k * t.beat / 4, 0.1, 0.3 if k % 2 else -0.3, 0.2)
        for k in range(8): t.add(bass(hz(c[0] - 12), t.beat * 0.4, 'saw'), s + k * t.beat / 2 + t.beat / 4, 0.38)
        t.add(pad(c, 4 * t.beat, 900, 0.5), s, 0.1)
    chords_over(t, prog, arp)
    drum_pattern(t, 'four', 2, 0.9)
    return t

def calm_spa():
    t = Track(68)
    prog = [chord('D', 'maj7', 3), chord('B', 'min7', 2), chord('G', 'maj7', 2), chord('A', 'sus2', 2)]
    def calm(s, c, bar):
        t.add(pad([m + 12 for m in c], 4 * t.beat + 1.0, 900, 1.6), s, 0.24, 0, 0.8)
        t.add(bass(hz(c[0]), t.beat * 4), s, 0.25)
    chords_over(t, prog, calm)
    melody(t, prog, bell, [(0, 1), (2, 1)], 24, 0.07, 1, seed=31, pan=0.3, verb=0.9)
    return t

def street_groove():
    t = Track(90)
    prog = [chord('F', 'min7', 3), chord('C', 'min7', 3), chord('C#', 'maj7', 3), chord('C', 'min7', 3)]
    def g(s, c, bar):
        for k in (0, 1.5, 2.75):
            for j, m in enumerate(c): t.add(keys(hz(m + 12), t.beat * 0.9, 0.5), s + k * t.beat + j * 0.01, 0.12, -0.2, 0.3)
        t.add(bass(hz(c[0] - 12), t.beat * 1.4), s, 0.6); t.add(bass(hz(c[0] - 12), t.beat * 0.6), s + 1.75 * t.beat, 0.45)
        t.add(bass(hz(c[2] - 12), t.beat * 1.2), s + 2.5 * t.beat, 0.5)
    chords_over(t, prog, g)
    drum_pattern(t, 'boom', 0)
    return t

def party_night():
    t = Track(124)
    prog = [chord('G', 'min', 3), chord('D#', 'maj', 3), chord('A#', 'maj', 3), chord('F', 'maj', 3)]
    def p(s, c, bar):
        for k in range(8):
            if k % 2:
                for m in c: t.add(keys(hz(m + 12), t.beat * 0.4, 0.9), s + k * t.beat / 2, 0.1, 0, 0.2)
        for k in range(8): t.add(bass(hz(c[0] - 12 + (12 if k % 2 else 0)), t.beat * 0.4, 'saw'), s + k * t.beat / 2, 0.36)
    chords_over(t, prog, p)
    melody(t, prog, lambda f, d: synth_lead(f, d, 3500), [(0, .5), (1, .5), (1.5, 1), (3, .5), (3.5, .5)], 24, 0.09, 4, seed=41, pan=-0.15)
    drum_pattern(t, 'four', 0)
    return t

def happy_kids():
    t = Track(126); rng = np.random.default_rng(9)
    prog = [chord('D', 'maj', 3), chord('A', 'maj', 3), chord('B', 'min', 3), chord('G', 'maj', 3)]
    def u(s, c, bar):
        for k in range(8):
            for j, m in enumerate(c): t.add(pluck(hz(m + 12), 0.4, 0.9, rng), s + k * t.beat / 2 + j * 0.006, 0.09 if k % 2 else 0.13, 0.1, 0.2)
        t.add(bass(hz(c[0] - 12), t.beat), s, 0.45); t.add(bass(hz(c[2] - 12), t.beat), s + 2 * t.beat, 0.4)
    chords_over(t, prog, u)
    melody(t, prog, bell, [(0, .5), (0.5, .5), (1, .5), (2, .5), (3, .5)], 24, 0.1, 2, seed=51, pan=-0.2, verb=0.3)
    drum_pattern(t, 'acoustic', 0)
    return t

TRACKS = [
    ('sunny-market', 'Sunny Market', 'Upbeat', 'Bright guitar pop — sales, new arrivals', sunny_market),
    ('chill-cafe', 'Chill Café', 'Chill', 'Lo-fi keys — cafés, food, slow mornings', chill_cafe),
    ('big-sale', 'Big Sale', 'Energetic', 'Punchy dance beat — flash sales, offers', big_sale),
    ('bright-business', 'Bright Business', 'Corporate', 'Clean piano arps — services, B2B, launches', bright_business),
    ('festive-bells', 'Festive Bells', 'Festive', 'Bells and claps — Dashain, Tihar, Christmas, Eid', festive_bells),
    ('acoustic-morning', 'Acoustic Morning', 'Acoustic', 'Fingerpicked guitar — handmade, organic, bakery', acoustic_morning),
    ('luxury-night', 'Luxury Night', 'Elegant', 'Warm pads and soft keys — beauty, jewellery, fashion', luxury_night),
    ('tech-pulse', 'Tech Pulse', 'Electronic', 'Driving synth arps — phones, gadgets, tech', tech_pulse),
    ('calm-spa', 'Calm Spa', 'Relaxing', 'Soft ambient — spa, salon, wellness', calm_spa),
    ('street-groove', 'Street Groove', 'Hip-hop', 'Laid-back boom-bap — streetwear, sneakers', street_groove),
    ('party-night', 'Party Night', 'Dance', 'Club beat — events, nightlife, weekends', party_night),
    ('happy-kids', 'Happy Days', 'Cheerful', 'Ukulele and bells — kids, toys, family', happy_kids),
]

def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    lib = []
    for key, name, mood, desc, fn in TRACKS:
        if only and key not in only: continue
        np.random.seed(sum(map(ord, key)) * 7919 % (2 ** 31))
        t = fn(); st = t.render(name=key)
        pcm = (st * 32767).astype('<i2').tobytes()
        mp3 = os.path.join(OUT, key + '.mp3')
        subprocess.run([FFMPEG, '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', '-', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', str(SR), '-c:a', 'libmp3lame', '-b:a', '128k',
                        '-metadata', f'title={name}', '-metadata', 'artist=PostForge', '-metadata', 'copyright=PostForge original — free to use in your posts', mp3],
                       input=pcm, check=True)
        lib.append({'key': key, 'name': name, 'mood': mood, 'description': desc, 'bpm': t.bpm, 'seconds': LEN, 'file': f'/music/{key}.mp3'})
        print('made', key)
    if not only:
        with open(os.path.join(OUT, 'library.json'), 'w') as f: json.dump(lib, f, indent=1, ensure_ascii=False)

if __name__ == '__main__':
    main()
