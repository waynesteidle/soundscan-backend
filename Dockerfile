FROM ubuntu:24.04

# Install runtime dependencies for audiowmark and Node.js
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    libfftw3-single3 \
    libsndfile1 \
    libglib2.0-0 \
    libzita-resampler1 \
    libmpg123-0 \
    libgcrypt20 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Make audiowmark binary executable
RUN chmod +x /app/audiowmark-linux

EXPOSE 8080
CMD ["node", "server.js"]
