"""
SoundScan Custom Watermarker v4 - Phase Independent
Embeds ALL 30 bits in EVERY frame - detection works from any start point.

Cross-band pairs: 4-8kHz (low) vs 8-12kHz (high)
Robust against: room reflections, comb filtering, speaker rolloff, noise
Detection speed: 0.1 seconds from ANY point in the loop
"""
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly
from math import gcd
import sys
import traceback

SR       = 44100
FRAME    = 1024
BIN_FREQ = SR / FRAME  # 43.07Hz

LOW_BINS  = list(range(93,  186))  # 4,005Hz - 7,967Hz
HIGH_BINS = list(range(186, 280))  # 8,010Hz - 12,016Hz
ALL_BINS  = LOW_BINS + HIGH_BINS

STRENGTH = 0.45
SEED     = 42


def code_to_bits(code):
    n = int(code)
    return [(n >> i) & 1 for i in range(29, -1, -1)]


def bits_to_code(bits):
    n = sum(b << (29-i) for i, b in enumerate(bits))
    return str(n) if 100000000 <= n <= 999999999 else None


def get_pairs():
    """30 cross-band pairs: pair[i] always encodes/detects bit[i]"""
    rng = np.random.default_rng(SEED)
    low  = LOW_BINS.copy()
    high = HIGH_BINS.copy()
    rng.shuffle(low)
    rng.shuffle(high)
    return [(low[i], high[i]) for i in range(30)]


def embed(audio, code):
    """Embed ALL 30 bits in EVERY frame - phase independent detection"""
    bits  = code_to_bits(code)
    pairs = get_pairs()
    output = audio.copy().astype(np.float64)
    fs = 0
    while fs + FRAME <= len(output):
        frame = output[fs:fs+FRAME]
        spec  = np.fft.rfft(frame)
        for b_idx in range(30):
            b1, b2 = pairs[b_idx]
            bit = bits[b_idx]
            m1, m2 = np.abs(spec[b1]), np.abs(spec[b2])
            if m1+m2 > 0:
                if bit == 1:
                    spec[b1] *= (1+STRENGTH); spec[b2] *= (1-STRENGTH)
                else:
                    spec[b1] *= (1-STRENGTH); spec[b2] *= (1+STRENGTH)
        output[fs:fs+FRAME] = np.fft.irfft(spec, FRAME)
        fs += FRAME
    return output


def detect(audio):
    """Each frame votes on all 30 bits - works from any start point"""
    pairs = get_pairs()
    votes = np.zeros((30, 2))
    fs = 0
    while fs + FRAME <= len(audio):
        frame = audio[fs:fs+FRAME].astype(np.float64)
        spec  = np.fft.rfft(frame)
        for b_idx in range(30):
            b1, b2 = pairs[b_idx]
            m1, m2 = np.abs(spec[b1]), np.abs(spec[b2])
            t = m1+m2
            if t > 0:
                if m1 > m2: votes[b_idx][1] += (m1-m2)/t
                else:       votes[b_idx][0] += (m2-m1)/t
        fs += FRAME
    bits = [1 if votes[i][1]>votes[i][0] else 0 for i in range(30)]
    conf = float(np.mean([max(votes[i])/max(sum(votes[i]),1e-10) for i in range(30)]))
    return bits_to_code(bits), conf


def load_audio(path):
    sr, data = wavfile.read(path)
    if data.ndim == 2: data = data[:, 0]
    audio = data.astype(np.float64)
    if np.max(np.abs(audio)) > 1.0:
        audio = audio / 32768.0
    return audio, sr


def resample_to_44100(audio, sr):
    if sr == SR: return audio
    g = gcd(int(sr), SR)
    return resample_poly(audio, SR//g, int(sr)//g)


def watermark_file(input_wav, output_wav, code):
    audio, sr = load_audio(input_wav)
    audio = resample_to_44100(audio, sr)
    wm = embed(audio, code)
    wm_int16 = np.clip(wm * 32767, -32768, 32767).astype(np.int16)
    stereo = np.column_stack([wm_int16, wm_int16])
    wavfile.write(output_wav, SR, stereo)


def detect_file(input_wav):
    audio, sr = load_audio(input_wav)
    audio = resample_to_44100(audio, sr)
    return detect(audio)


def generate_carrier(duration=30.0, output_path='soundscan_carrier.wav'):
    N = int(SR * duration)
    t = np.linspace(0, duration, N, endpoint=False)
    np.random.seed(SEED)
    carrier = np.zeros(N)
    for b in ALL_BINS:
        freq  = b * BIN_FREQ
        phase = np.random.uniform(0, 2*np.pi)
        carrier += np.sin(2*np.pi*freq*t + phase)
    carrier = carrier / np.max(np.abs(carrier)) * 0.8
    carrier_int16 = (carrier * 32767).astype(np.int16)
    stereo = np.column_stack([carrier_int16, carrier_int16])
    wavfile.write(output_path, SR, stereo)
    return output_path


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python watermark.py generate [output.wav] [duration]")
        print("  python watermark.py embed <input.wav> <output.wav> <code>")
        print("  python watermark.py detect <input.wav>")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'generate':
        out = sys.argv[2] if len(sys.argv) > 2 else 'soundscan_carrier.wav'
        dur = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
        generate_carrier(dur, out)
        print(f"Carrier generated: {out} ({dur}s)")

    elif cmd == 'embed':
        inp, out, code = sys.argv[2], sys.argv[3], sys.argv[4]
        try:
            watermark_file(inp, out, code)
            print(f"Watermarked: {out}")
        except Exception as e:
            print(f"ERROR: {e}"); traceback.print_exc()

    elif cmd == 'detect_raw':
        inp = sys.argv[2]
        try:
            audio, sr = load_audio(inp)
            audio = resample_to_44100(audio, sr)
            pairs = get_pairs()
            votes = np.zeros((30, 2))
            fs = 0
            while fs + FRAME <= len(audio):
                frame = audio[fs:fs+FRAME].astype(np.float64)
                spec = np.fft.rfft(frame)
                for b_idx in range(30):
                    b1, b2 = pairs[b_idx]
                    m1, m2 = np.abs(spec[b1]), np.abs(spec[b2])
                    t = m1+m2
                    if t > 0:
                        if m1 > m2: votes[b_idx][1] += (m1-m2)/t
                        else:       votes[b_idx][0] += (m2-m1)/t
                fs += FRAME
            bits = [1 if votes[i][1]>votes[i][0] else 0 for i in range(30)]
            conf = float(np.mean([max(votes[i])/max(sum(votes[i]),1e-10) for i in range(30)]))
            n = sum(b << (29-i) for i,b in enumerate(bits))
            print(f"Raw: {n} Confidence: {conf:.3f}")
        except Exception as e:
            print(f"ERROR: {e}")
            traceback.print_exc()

    elif cmd == 'detect':
        inp = sys.argv[2]
        try:
            code, conf = detect_file(inp)
            if code:
                print(f"Detected: {code} (confidence={conf:.3f})")
            else:
                print(f"Nothing detected (confidence={conf:.3f})")
        except Exception as e:
            print(f"ERROR: {e}"); traceback.print_exc()

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
