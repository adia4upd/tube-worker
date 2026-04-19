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
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'https://tube-worker-production.up.railway.app';

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
async function jobMerge(jobId, job) {
  const { videoUrl, audioUrl } = job;

  const videoPath = await download(videoUrl, 'mp4');
  const audioPath = await download(audioUrl, 'mp3');
  const outputPath = path.join(TMP_DIR, `${jobId}_merged.mp4`);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0', '-shortest'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  cleanup(videoPath, audioPath);
  jobs[jobId].resultFile = outputPath;
  return `${SERVER_BASE_URL}/jobs/${jobId}/result`;
}

// ── 작업 2: 여러 영상/이미지 클립 이어붙이기 + 나레이션 합성 ──────
// clips: [{ videoUrl?, imageUrl?, duration? }], audioUrl (전체 나레이션), ratio
async function jobConcat(jobId, job) {
  const { clips, audioUrl, ratio } = job;

  // 출력 해상도
  const [outW, outH] = ratio === '9:16' ? [1080, 1920] : ratio === '1:1' ? [1080, 1080] : [1920, 1080];
  const scaleFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  const localClips = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    jobs[jobId].progress = `클립 ${i + 1}/${clips.length} 처리 중`;
    const clipPath = path.join(TMP_DIR, `${jobId}_clip${i}.mp4`);

    if (clip.videoUrl) {
      // 영상 다운로드 → 통일된 포맷으로 재인코딩
      const tmpPath = await download(clip.videoUrl, 'mp4');
      await new Promise((resolve, reject) => {
        ffmpeg(tmpPath)
          .outputOptions(['-c:v libx264', '-an', '-pix_fmt yuv420p', '-r 25', `-vf ${scaleFilter}`])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      cleanup(tmpPath);
      localClips.push(clipPath);
    } else if (clip.imageUrl) {
      // 이미지 → 영상 변환 (Ken Burns 효과 포함)
      const tmpPath = await download(clip.imageUrl, 'jpg');
      const duration = clip.duration || 5;
      const fps = 25;
      const frames = Math.round(duration * fps);

      let kenFilter;
      switch (clip.kenBurns) {
        case 'zoom-in':
          kenFilter = `zoompan=z='min(zoom+${(0.12/frames).toFixed(6)},1.12)':d=${frames}:s=${outW}x${outH}:fps=${fps}`;
          break;
        case 'zoom-out':
          kenFilter = `zoompan=z='if(eq(on\\,1)\\,1.12\\,max(zoom-${(0.12/frames).toFixed(6)}\\,1.0))':d=${frames}:s=${outW}x${outH}:fps=${fps}`;
          break;
        case 'ken-burns':
          kenFilter = `zoompan=z='min(zoom+${(0.15/frames).toFixed(6)},1.15)':x='iw/2-(iw/zoom/2)+on*(iw*0.02/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${outW}x${outH}:fps=${fps}`;
          break;
        case 'pan-left':
          kenFilter = `zoompan=z=1.08:x='iw/2-(iw/zoom/2)+on*(iw*0.06/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${outW}x${outH}:fps=${fps}`;
          break;
        case 'pan-right':
          kenFilter = `zoompan=z=1.08:x='iw/2-(iw/zoom/2)-on*(iw*0.06/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${outW}x${outH}:fps=${fps}`;
          break;
        default:
          kenFilter = scaleFilter;
      }
      const vf = clip.kenBurns && clip.kenBurns !== 'none'
        ? `scale=${outW*2}:${outH*2},${kenFilter},setsar=1`
        : scaleFilter;

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(tmpPath)
          .inputOptions(['-loop 1'])
          .outputOptions([`-t ${duration}`, '-c:v libx264', '-pix_fmt yuv420p', `-r ${fps}`, `-vf ${vf}`])
          .output(clipPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      cleanup(tmpPath);
      localClips.push(clipPath);
    }
  }

  if (localClips.length === 0) throw new Error('처리할 클립이 없습니다');

  // 클립 이어붙이기
  const concatListPath = path.join(TMP_DIR, `${jobId}_list.txt`);
  fs.writeFileSync(concatListPath, localClips.map(p => `file '${p}'`).join('\n'));

  const concatPath = path.join(TMP_DIR, `${jobId}_concat.mp4`);
  jobs[jobId].progress = '영상 합치는 중';

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .output(concatPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  cleanup(concatListPath, ...localClips);

  // 전체 나레이션 합성
  let outputPath = concatPath;
  if (audioUrl) {
    jobs[jobId].progress = '나레이션 합성 중';
    const audioPath = await download(audioUrl, 'mp3');
    const finalPath = path.join(TMP_DIR, `${jobId}_final.mp4`);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .input(audioPath)
        .complexFilter('[1:a]apad[aout]')
        .outputOptions(['-map 0:v:0', '-map [aout]', '-c:v copy', '-c:a aac', '-shortest'])
        .output(finalPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    cleanup(audioPath, concatPath);
    outputPath = finalPath;
  }

  // 결과 파일 경로 저장 (다운로드 엔드포인트에서 제공)
  jobs[jobId].resultFile = outputPath;
  return `${SERVER_BASE_URL}/jobs/${jobId}/result`;
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

// 결과 파일 다운로드
app.get('/jobs/:jobId/result', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없음' });
  if (job.status !== 'done' || !job.resultFile) return res.status(404).json({ error: '결과 없음' });
  if (!fs.existsSync(job.resultFile)) return res.status(410).json({ error: '파일 만료됨' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="merged_video.mp4"');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(job.resultFile).pipe(res);
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
