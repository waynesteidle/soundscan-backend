"""Log spectrum of audio file for diagnostics"""
import numpy as np
from scipy.io import wavfile
import sys

if len(sys.argv) < 2:
    print("Usage: python spectrum.py <file.wav>")
    sys.exit(1)

sr, data = wavfile.read(sys.argv[1])
if data.ndim == 2: data = data[:,0]
audio = data.astype(np.float64)
if np.max(np.abs(audio)) > 1.0:
    audio = audio / 32768.0

# Use first second
n = min(len(audio), sr)
fft = np.abs(np.fft.rfft(audio[:n]))
freqs = np.fft.rfftfreq(n, 1/sr)

amp = np.max(np.abs(audio))
print(f"AMP:{amp:.4f}")
for f1, f2 in [(500,2000),(2000,4000),(4000,8000),(8000,12000),(12000,16000)]:
    mask = (freqs >= f1) & (freqs < f2)
    e = np.mean(fft[mask]) if mask.any() else 0
    print(f"B{f1//1000}k-{f2//1000}k:{e:.3f}")
