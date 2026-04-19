FROM node:20-slim

# FFmpeg 설치
RUN apt-get update && apt-get install -y \
  ffmpeg \
  curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
