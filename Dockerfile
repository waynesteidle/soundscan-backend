FROM node:22-slim

# Install build dependencies and audiowmark
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    build-essential \
    pkg-config \
    libfftw3-dev \
    libsndfile1-dev \
    libglib2.0-dev \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# Download and build audiowmark
RUN wget -q https://uplex.de/audiowmark/audiowmark-0.6.2.tar.zst -O /tmp/aw.tar.zst \
    && cd /tmp && zstd -d aw.tar.zst && tar xf aw.tar \
    && cd audiowmark-0.6.2 \
    && ./configure --prefix=/usr/local \
    && make -j$(nproc) \
    && make install \
    && cd / && rm -rf /tmp/audiowmark* /tmp/aw*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
