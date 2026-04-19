const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// 임시 파일 디렉토리
const TMP_DIR = path.join(os.tmpdir(), 'tube-worker');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// 작업 상태 저장 (메모리, 추후 Redis로 교체)
const jobs = {};

// ── 헬퍼: URL → 로컬 파일 다운로드 ──────────────────────────────
async function download(url, ext) {
  const filePath = path.join(TMP_DIR, `${uuidv4()}.${ext}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(filePath, Buffer.from(response.data));
  return filePath;
}

// ── 헬퍼: 파일 정리 ──────────────────────────────────────────────
function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

// ── 작업 처리기 ───────────────────────────────────────────────────
async function processJob(jobId, job) {
  jobs[jobId] = { ...job, status: 'processing', startedAt: Date.now() };
  console.log(`[${jobId}] 시작:`, job.type);

  try {
    let resultUrl;

    if (job.type === 'merge') {
      resultUrl = await jobMerge(jobId, job);
    } else if (job.type === 'concat') {
      resultUrl = await jobConcat(jobId, job);
    } else {
      throw new Error(`알 수 없는 작업 타입: ${job.type}`);
    }

    jobs[jobId] = { ...jobs[jobId], status: 'done', resultUrl, finishedAt: Date.now() };
    console.log(`[${jobId}] 완료:`, resultUrl);

    // Webhook 콜백 (설정된 경우)
    if (job.callbackUrl) {
      await axios.post(job.callbackUrl, { jobId, status: 'done', resultUrl }).catch(() => {});
    }
  } catch (err) {
    jobs[jobId] = { ...jobs[jobId], status: 'error', error: err.message, finishedAt: Date.now() };
    console.error(`[${jobId}] 오류:`, err.message);

    if (job.callbackUrl) {
      await axios.post(job.callbackUrl, { jobId, status: 'error', error: err.message }).catch(() => {});
    }
  }
}

// ── 작업 1: 영상 + 음성 합성 ─────────────────────────────────────
// videoUrl: mp4/webm, audioUrl: mp3/wav, outputUrl: 업로드할 곳 (Firebase Storage signed URL)
async function jobMerge(jobId, job) {
  const { videoUrl, audioUrl, uploadUrl } = job;

  const videoPath = await download(videoUrl, 'mp4');
  const audioPath = await download(audioUrl, 'mp3');
  const outputPath = path.join(TMP_DIR, `${jobId}_merged.mp4`);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',      // 영상 재인코딩 없이 복사 (빠름)
        '-c:a aac',       // 오디오 AAC 인코딩
        '-map 0:v:0',     // 첫 번째 입력의 비디오
        '-map 1:a:0',     // 두 번째 입력의 오디오
        '-shortest',      // 짧은 쪽에 맞춤
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // Firebase Storage signed URL로 업로드
  const resultUrl = await uploadToSignedUrl(outputPath, uploadUrl);
  cleanup(videoPath, audioPath, outputPath);
  return resultUrl;
}

// ── 작업 2: 여러 영상 클립 이어붙이기 ────────────────────────────
// clips: [{ videoUrl, audioUrl, duration }], uploadUrl
async function jobConcat(jobId, job) {
  const { clips, uploadUrl } = job;

  const localClips = [];
  const concatListPath = path.join(TMP_DIR, `${jobId}_list.txt`);

  // 각 클립 다운로드 + 필요시 오디오 합성
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    jobs[jobId].progress = `클립 ${i + 1}/${clips.length} 다운로드 중`;

    if (clip.videoUrl && clip.audioUrl) {
      // 영상+음성 합성 후 사용
      const videoPath = await download(clip.videoUrl, 'mp4');
      const audioPath = await download(clip.audioUrl, 'mp3');
      const mergedPath = path.join(TMP_DIR, `${jobId}_clip${i}.mp4`);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0', '-shortest'])
          .output(mergedPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      cleanup(videoPath, audioPath);
      localClips.push(mergedPath);
    } else if (clip.videoUrl) {
      const videoPath = await download(clip.videoUrl, 'mp4');
      localClips.push(videoPath);
    }
  }

  // concat 리스트 파일 생성
  const listContent = localClips.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(concatListPath, listContent);

  // 이어붙이기
  const outputPath = path.join(TMP_DIR, `${jobId}_final.mp4`);
  jobs[jobId].progress = '영상 합치는 중';

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  const resultUrl = await uploadToSignedUrl(outputPath, uploadUrl);
  cleanup(concatListPath, outputPath, ...localClips);
  return resultUrl;
}

// ── Firebase Storage signed URL로 파일 업로드 ────────────────────
async function uploadToSignedUrl(filePath, signedUrl) {
  if (!signedUrl) {
    // uploadUrl 없으면 로컬 파일을 base64로 반환 (테스트용)
    const buf = fs.readFileSync(filePath);
    return `data:video/mp4;base64,${buf.toString('base64').substring(0, 100)}...(truncated)`;
  }

  const fileBuffer = fs.readFileSync(filePath);
  await axios.put(signedUrl, fileBuffer, {
    headers: { 'Content-Type': 'video/mp4' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  // signed URL에서 다운로드 가능한 URL 추출 (Firebase 형식)
  const downloadUrl = signedUrl.split('?')[0].replace(
    'storage.googleapis.com/',
    'firebasestorage.googleapis.com/v0/b/'
  ).replace('/o/', '/o/') + '?alt=media';

  return downloadUrl;
}

// ════════════════════════════════════════════════════════════════
// API 엔드포인트
// ════════════════════════════════════════════════════════════════

// 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'tube-worker', jobs: Object.keys(jobs).length });
});

// 작업 등록
app.post('/jobs', (req, res) => {
  const secret = req.headers['x-worker-secret'];
  if (process.env.WORKER_SECRET && secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: '인증 실패' });
  }

  const jobId = uuidv4();
  const job = req.body;

  if (!job.type) return res.status(400).json({ error: 'type 필드 필요 (merge | concat)' });

  jobs[jobId] = { ...job, status: 'queued', createdAt: Date.now() };

  // 비동기로 처리 시작 (응답은 즉시)
  processJob(jobId, job).catch(console.error);

  res.json({ jobId, status: 'queued' });
});

// 작업 상태 조회
app.get('/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없음' });
  res.json(job);
});

// 완료된 작업 정리 (1시간 이상 된 것)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.finishedAt && job.finishedAt < cutoff) delete jobs[id];
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`tube-worker 시작됨: http://localhost:${PORT}`);
  console.log('FFmpeg 경로:', require('child_process').execSync('which ffmpeg').toString().trim());
});
