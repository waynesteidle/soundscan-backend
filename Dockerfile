FROM ubuntu:24.04

# Install Python, Node.js, ffmpeg and dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    python3 \
    python3-pip \
    python3-numpy \
    python3-scipy \
    libzita-resampler1 \
    libmpg123-0 \
    libgcrypt20 \
    libfftw3-single3 \
    libsndfile1 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Make audiowmark binary executable (kept as fallback)
RUN chmod +x /app/audiowmark-linux

EXPOSE 8080
CMD ["node", "server.js"]
