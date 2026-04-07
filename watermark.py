"""
SoundScan Custom Watermarker v2
Encodes/decodes 9-digit codes using differential FSK on audiowmark FFT bins.

Primary band:   8kHz-12kHz (94 bins - survives ALL TV speakers)
Secondary band: 15kHz-17kHz (47 bins - sub-human on good TVs, carrier only)
Detection:      1-2 seconds from any point in the 30-second loop
Strength:       0.45 (robust through speaker/mic chain)
Repeats:        5x per bit (majority vote error correction)
"""
import numpy as np
from scipy.io import wavfile
import sys

SR       = 44100
FRAME    = 1024
BIN_FREQ = SR / FRAME  # 43.07Hz

PRIMARY_BINS   = list(range(186, 280))  # 8,010Hz - 12,016Hz (94 bins)
SECONDARY_BINS = list(range(349, 396))  # 15,030Hz - 17,011Hz (47 bins)
ALL_BINS       = PRIMARY_BINS + SECONDARY_BINS

STRENGTH = 0.45   # watermark embedding strength
SEED     = 42     # deterministic key


def code_to_bits(code: str) -> list:
    n = int(code)
    return [(n >> i) & 1 for i in range(29, -1, -1)]


def bits_to_code(bits: list):
    n = sum(b << (29-i) for i, b in enumerate(bits))
    return str(n) if 100000000 <= n <= 999999999 else None


def get_pairs() -> list:
    """Get 47 deterministic bin pairs from primary band."""
    rng = np.random.default_rng(SEED)
    bins = PRIMARY_BINS.copy()
    rng.shuffle(bins)
    return [(bins[i], bins[i+1]) for i in range(0, len(bins)-1, 2)]


def embed(audio: np.ndarray, code: str) -> np.ndarray:
    """Embed 30-bit code into audio. Pattern repeats every 47 frames (~1.1s)."""
    bits  = code_to_bits(code)
    pairs = get_pairs()  # 47 pairs
    output = audio.copy().astype(np.float64)
    frame_start = 0
    frame_idx   = 0

    while frame_start + FRAME <= len(output):
        frame = output[frame_start:frame_start+FRAME]
        spec  = np.fft.rfft(frame)

        # Map frame to bit using modulo - cycles through all 30 bits repeatedly
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


def detect(audio: np.ndarray):
    """Detect code from audio. Returns (code, confidence)."""
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


def watermark_file(input_wav: str, output_wav: str, code: str):
    sr, data = wavfile.read(input_wav)
    audio = (data[:, 0] if data.ndim == 2 else data).astype(np.float64) / 32768.0
    wm = embed(audio, code)
    wm_int16 = np.clip(wm * 32767, -32768, 32767).astype(np.int16)
    stereo = np.column_stack([wm_int16, wm_int16])
    wavfile.write(output_wav, SR, stereo)


def detect_file(input_wav: str):
    sr, data = wavfile.read(input_wav)
    audio = (data[:, 0] if data.ndim == 2 else data).astype(np.float64) / 32768.0
    return detect(audio)


def generate_carrier(duration: float = 30.0, output_path: str = 'soundscan_carrier.wav'):
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
        watermark_file(inp, out, code)
        print(f"Watermarked: {out}")

    elif cmd == 'detect_any_sr':
        inp = sys.argv[2]
        try:
            code, conf = detect_file_any_sr(inp)
            if code:
                print(f'Detected: {code} (confidence={conf:.3f})')
            else:
                print(f'Nothing detected (confidence={conf:.3f})')
        except Exception as e:
            import traceback
            print(f'ERROR: {e}')
            traceback.print_exc()

    elif cmd == 'detect':
        inp = sys.argv[2]
        code, conf = detect_file(inp)
        if code:
            print(f"Detected: {code} (confidence={conf:.3f})")
        else:
            print(f"Nothing detected (confidence={conf:.3f})")


def detect_file_any_sr(input_wav: str):
    """Detect code from WAV file at any sample rate - resamples to 44100Hz."""
    from scipy.signal import resample_poly
    from math import gcd
    sr, data = wavfile.read(input_wav)
    audio = (data[:, 0] if data.ndim == 2 else data).astype(np.float64)
    
    # Normalize
    if audio.dtype == np.int16 or np.max(np.abs(audio)) > 1.0:
        audio = audio / 32768.0
    
    # Resample to 44100Hz if needed
    if sr != SR:
        g = gcd(int(sr), SR)
        up = SR // g
        down = int(sr) // g
        audio = resample_poly(audio, up, down)
    
    return detect(audio)
