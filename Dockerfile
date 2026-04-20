FROM node:20-slim

# FFmpeg + 한국어 폰트 설치
RUN apt-get update && apt-get install -y \
  ffmpeg \
  curl \
  fonts-noto-cjk \
  fontconfig \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
