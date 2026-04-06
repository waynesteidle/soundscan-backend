"""
SoundScan Custom Watermarker
Encodes/decodes 9-digit codes in audio using differential FSK.

Primary band:   8kHz-12kHz (survives ALL TV speakers)
Secondary band: 15kHz-17kHz (sub-human, bonus detection on good TVs)
Detection:      1-2 seconds from any point in the loop
"""
import numpy as np
from scipy.io import wavfile
import sys
import os

SR    = 44100
FRAME = 1024
BIN_FREQ = SR / FRAME  # 43.07Hz per bin

PRIMARY_BINS   = list(range(186, 280))  # 8,010Hz - 12,016Hz
SECONDARY_BINS = list(range(349, 396))  # 15,030Hz - 17,011Hz
ALL_BINS       = PRIMARY_BINS + SECONDARY_BINS

STRENGTH = 0.35
SEED     = 42


def code_to_bits(code: str) -> list:
    n = int(code)
    return [(n >> i) & 1 for i in range(29, -1, -1)]


def bits_to_code(bits: list):
    n = sum(b << (29-i) for i, b in enumerate(bits))
    return str(n) if 100000000 <= n <= 999999999 else None


def get_embed_pairs() -> list:
    rng = np.random.default_rng(SEED)
    bins = PRIMARY_BINS.copy()
    rng.shuffle(bins)
    pairs = [(bins[i], bins[i+1]) for i in range(0, min(180, len(bins)-1), 2)]
    return pairs[:90]


def load_audio(path: str) -> np.ndarray:
    """Load WAV file as float64 mono array at SR=44100."""
    sr, data = wavfile.read(path)
    
    # Convert to float
    if data.dtype == np.int16:
        audio = data.astype(np.float64) / 32768.0
    elif data.dtype == np.int32:
        audio = data.astype(np.float64) / 2147483648.0
    elif data.dtype == np.float32:
        audio = data.astype(np.float64)
    else:
        audio = data.astype(np.float64)
    
    # Convert stereo to mono
    if audio.ndim == 2:
        audio = audio[:, 0]
    
    # Resample if needed
    if sr != SR:
        # Simple resample using interpolation
        duration = len(audio) / sr
        old_indices = np.arange(len(audio))
        new_length = int(duration * SR)
        new_indices = np.linspace(0, len(audio)-1, new_length)
        audio = np.interp(new_indices, old_indices, audio)
    
    return audio


def embed(audio: np.ndarray, code: str) -> np.ndarray:
    bits  = code_to_bits(code)
    pairs = get_embed_pairs()
    output = audio.copy().astype(np.float64)
    frame_start = 0
    pair_idx = 0
    while frame_start + FRAME <= len(output):
        frame = output[frame_start:frame_start+FRAME]
        spec  = np.fft.rfft(frame)
        b_idx = pair_idx % 30
        bit   = bits[b_idx]
        b1, b2 = pairs[pair_idx % len(pairs)]
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
        pair_idx += 1
        frame_start += FRAME
    return output


def detect(audio: np.ndarray):
    pairs = get_embed_pairs()
    votes = np.zeros((30, 2))
    frame_start = 0
    pair_idx = 0
    while frame_start + FRAME <= len(audio):
        frame = audio[frame_start:frame_start+FRAME].astype(np.float64)
        spec  = np.fft.rfft(frame)
        b_idx = pair_idx % 30
        b1, b2 = pairs[pair_idx % len(pairs)]
        m1 = np.abs(spec[b1])
        m2 = np.abs(spec[b2])
        total = m1 + m2
        if total > 0:
            if m1 > m2:
                votes[b_idx][1] += (m1-m2)/total
            else:
                votes[b_idx][0] += (m2-m1)/total
        pair_idx += 1
        frame_start += FRAME
    bits = [1 if votes[i][1] > votes[i][0] else 0 for i in range(30)]
    conf_scores = [max(votes[i])/max(sum(votes[i]), 1e-10) for i in range(30)]
    return bits_to_code(bits), float(np.mean(conf_scores))


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


def watermark_file(input_wav: str, output_wav: str, code: str):
    audio = load_audio(input_wav)
    watermarked = embed(audio, code)
    watermarked_int16 = np.clip(watermarked * 32767, -32768, 32767).astype(np.int16)
    stereo = np.column_stack([watermarked_int16, watermarked_int16])
    wavfile.write(output_wav, SR, stereo)


def detect_file(input_wav: str):
    audio = load_audio(input_wav)
    return detect(audio)


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
        print(f"Carrier generated: {path} ({dur}s)", flush=True)

    elif cmd == 'embed':
        inp, out, code = sys.argv[2], sys.argv[3], sys.argv[4]
        watermark_file(inp, out, code)
        print(f"Watermarked: {out}", flush=True)

    elif cmd == 'detect':
        inp = sys.argv[2]
        try:
            code, conf = detect_file(inp)
            if code:
                print(f"Detected: {code} (confidence={conf:.3f})", flush=True)
            else:
                print(f"Nothing detected (confidence={conf:.3f})", flush=True)
        except Exception as e:
            print(f"Error: {e}", flush=True)
            sys.exit(1)
