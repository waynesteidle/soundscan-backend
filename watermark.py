"""
SoundScan Custom Watermarker v2
Encodes/decodes 9-digit codes using differential FSK on audiowmark FFT bins.

Primary band:   8kHz-12kHz (94 bins - survives ALL TV speakers)
Secondary band: 15kHz-17kHz (47 bins - sub-human on good TVs, carrier only)
Detection:      1-2 seconds from any point in the 30-second loop
"""
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly
from math import gcd
import sys
import traceback

SR       = 44100
FRAME    = 1024
BIN_FREQ = SR / FRAME

PRIMARY_BINS   = list(range(186, 280))
SECONDARY_BINS = list(range(349, 396))
ALL_BINS       = PRIMARY_BINS + SECONDARY_BINS

STRENGTH = 0.75
SEED     = 42


def code_to_bits(code):
    n = int(code)
    return [(n >> i) & 1 for i in range(29, -1, -1)]


def bits_to_code(bits):
    n = sum(b << (29-i) for i, b in enumerate(bits))
    return str(n) if 100000000 <= n <= 999999999 else None


def get_pairs():
    rng = np.random.default_rng(SEED)
    bins = PRIMARY_BINS.copy()
    rng.shuffle(bins)
    return [(bins[i], bins[i+1]) for i in range(0, len(bins)-1, 2)]


def embed(audio, code):
    bits  = code_to_bits(code)
    pairs = get_pairs()
    output = audio.copy().astype(np.float64)
    frame_start = 0
    frame_idx   = 0
    while frame_start + FRAME <= len(output):
        frame = output[frame_start:frame_start+FRAME]
        spec  = np.fft.rfft(frame)
        pair  = pairs[frame_idx % len(pairs)]
        b_idx = frame_idx % 30
        bit   = bits[b_idx]
        b1, b2 = pair
        m1 = np.abs(spec[b1])
        m2 = np.abs(spec[b2])
        if (m1 + m2) > 0:
            if bit == 1:
                spec[b1] *= (1 + STRENGTH)
                spec[b2] *= (1 - STRENGTH)
            else:
                spec[b1] *= (1 - STRENGTH)
                spec[b2] *= (1 + STRENGTH)
        output[frame_start:frame_start+FRAME] = np.fft.irfft(spec, FRAME)
        frame_start += FRAME
        frame_idx   += 1
    return output


def detect(audio):
    pairs = get_pairs()
    votes = np.zeros((30, 2))
    frame_start = 0
    frame_idx   = 0
    while frame_start + FRAME <= len(audio):
        frame = audio[frame_start:frame_start+FRAME].astype(np.float64)
        spec  = np.fft.rfft(frame)
        pair  = pairs[frame_idx % len(pairs)]
        b_idx = frame_idx % 30
        b1, b2 = pair
        m1 = np.abs(spec[b1])
        m2 = np.abs(spec[b2])
        total = m1 + m2
        if total > 0:
            if m1 > m2:
                votes[b_idx][1] += (m1-m2)/total
            else:
                votes[b_idx][0] += (m2-m1)/total
        frame_start += FRAME
        frame_idx   += 1
    bits = [1 if votes[i][1] > votes[i][0] else 0 for i in range(30)]
    conf = float(np.mean([max(votes[i])/max(sum(votes[i]), 1e-10) for i in range(30)]))
    return bits_to_code(bits), conf


def load_audio(path):
    """Load WAV file, return (audio_float64, sample_rate)"""
    sr, data = wavfile.read(path)
    if data.ndim == 2:
        audio = data[:, 0]
    else:
        audio = data
    audio = audio.astype(np.float64)
    if audio.dtype != np.float64 or np.max(np.abs(audio)) > 1.0:
        audio = audio / 32768.0
    return audio, sr


def resample_to_44100(audio, sr):
    """Resample audio to 44100Hz if needed"""
    if sr == SR:
        return audio
    g = gcd(int(sr), SR)
    up   = SR // g
    down = int(sr) // g
    return resample_poly(audio, up, down)


def watermark_file(input_wav, output_wav, code):
    audio, sr = load_audio(input_wav)
    audio = resample_to_44100(audio, sr)
    wm = embed(audio, code)
    wm_int16 = np.clip(wm * 32767, -32768, 32767).astype(np.int16)
    stereo = np.column_stack([wm_int16, wm_int16])
    wavfile.write(output_wav, SR, stereo)


def detect_file(input_wav):
    """Detect from WAV file at any sample rate"""
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
        amp   = 1.5 if b in SECONDARY_BINS else 1.0
        carrier += amp * np.sin(2*np.pi*freq*t + phase)
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
        out  = sys.argv[2] if len(sys.argv) > 2 else 'soundscan_carrier.wav'
        dur  = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
        path = generate_carrier(dur, out)
        print(f"Carrier generated: {path} ({dur}s)")

    elif cmd == 'embed':
        inp, out, code = sys.argv[2], sys.argv[3], sys.argv[4]
        try:
            watermark_file(inp, out, code)
            print(f"Watermarked: {out}")
        except Exception as e:
            print(f"ERROR: {e}")
            traceback.print_exc()

    elif cmd == 'detect' or cmd == 'detect_any_sr':
        inp = sys.argv[2]
        try:
            code, conf = detect_file(inp)
            if code:
                print(f"Detected: {code} (confidence={conf:.3f})")
            else:
                print(f"Nothing detected (confidence={conf:.3f})")
        except Exception as e:
            print(f"ERROR: {e}")
            traceback.print_exc()

    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
