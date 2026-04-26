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
// audioBase64(나레이션 MP3 base64)가 1~3MB 수준이라 기본 100KB 제한을 50MB로 상향.
app.use(express.json({ limit: '50mb' }));

// ── Firebase Admin 초기화 ─────────────────────────────────────────
let firebaseAdmin = null;
let firebaseBucket = null;

function getFirebaseBucket() {
  if (firebaseBucket) return firebaseBucket;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'dodo-tube-factory.firebasestorage.app';
  if (!serviceAccountJson) return null;
  try {
    const admin = require('firebase-admin');
    if (!firebaseAdmin) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      firebaseAdmin = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: bucketName,
      });
    }
    firebaseBucket = admin.storage().bucket();
    return firebaseBucket;
  } catch (e) {
    console.warn('[Firebase] 초기화 실패:', e.message);
    return null;
  }
}

// ── Firebase Storage 업로드 → 영구 URL 반환 ──────────────────────
async function uploadToFirebase(localPath, destPath) {
  const bucket = getFirebaseBucket();
  if (!bucket) return null;
  try {
    await bucket.upload(localPath, {
      destination: destPath,
      metadata: { contentType: 'video/mp4' },
    });
    const [url] = await bucket.file(destPath).getSignedUrl({
      action: 'read',
      expires: '2099-01-01', // 사실상 영구
    });
    return url;
  } catch (e) {
    console.warn('[Firebase] 업로드 실패:', e.message);
    return null;
  }
}

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

// ── 텔레그램 메시지 전송 헬퍼 ────────────────────────────────────
async function sendTg(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'HTML',
  }).catch(e => console.warn('[tg] 메시지 실패:', e.message));
}

async function sendTgVideo(chatId, videoUrl, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  await axios.post(`https://api.telegram.org/bot${token}/sendVideo`, {
    chat_id: chatId, video: videoUrl, caption, parse_mode: 'HTML',
  }).catch(e => console.warn('[tg] 비디오 전송 실패:', e.message));
}

// ── ASS 자막 생성 ─────────────────────────────────────────────────
function generateAss(scenes, ratio) {
  const isShort = ratio === '9:16';
  const [playResX, playResY] = isShort ? [1080, 1920] : [1920, 1080];
  const marginV = Math.round(playResY * 0.08);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
Collisions: Normal

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK KR,${isShort ? 52 : 44},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const toAss = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.round((sec % 1) * 100);
    return `${String(h).padStart(1,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
  };

  let t = 0;
  const events = scenes.map(scene => {
    const dur = scene.estimatedDuration || scene.duration || 5;
    const text = (scene.scriptText || scene.narration || '').replace(/\n/g, '\\N');
    const line = `Dialogue: 0,${toAss(t)},${toAss(t + dur - 0.1)},Default,,0,0,0,,${text}`;
    t += dur;
    return line;
  }).join('\n');

  return header + events;
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
    } else if (job.type === 'auto-pipeline') {
      resultUrl = await jobAutoPipeline(jobId, job);
    } else if (job.type === 'douyin-merge') {
      resultUrl = await jobDouyinMerge(jobId, job);
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

// ── ffprobe로 오디오 실제 길이 측정 ──────────────────────────────
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) reject(err);
      else resolve(parseFloat(meta.format.duration) || 0);
    });
  });
}

// ── 씬 수 하드 제한 테이블 ────────────────────────────────────────
const DURATION_CONFIG = {
  '30sec': { maxScenes: 5,  durationMin: '0.5', targetSec: 30  },
  '60sec': { maxScenes: 7,  durationMin: '1',   targetSec: 60  },
  '2min':  { maxScenes: 12, durationMin: '2',   targetSec: 120 },
  '3min':  { maxScenes: 15, durationMin: '3',   targetSec: 180 },
};

// ── 작업 0: 자동 파이프라인 (YouTube → 완성 영상) ──────────────────
async function jobAutoPipeline(jobId, job) {
  const {
    youtubeUrl, topic, chatId,
    format = 'shortform', duration = '60sec', style = 'realistic',
    scriptGuideline = null, guidelineTitle = null,
  } = job;

  const BASE = process.env.VERCEL_BASE_URL || 'https://dodo-tube-factory.vercel.app';
  const ratio = format === 'shortform' ? '9:16' : '16:9';
  const cfg = DURATION_CONFIG[duration] || DURATION_CONFIG['60sec'];

  const progress = (msg) => { jobs[jobId].progress = msg; console.log(`[${jobId}]`, msg); };

  // ── Step 1: 소스 확보 (YouTube 자막 or 직접 주제) ──────────────
  progress('1/5 소스 분석 중...');

  let sourceText = '';
  let sourceLabel = '';

  if (youtubeUrl) {
    await sendTg(chatId, '🎬 영상 자동 제작을 시작합니다!\n\n📥 <b>Step 1/5</b> YouTube 자막 추출 중...');
    const { YoutubeTranscript } = require('youtube-transcript');
    const vidMatch = youtubeUrl.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!vidMatch) throw new Error('YouTube URL에서 영상 ID를 찾을 수 없습니다.');
    const videoId = vidMatch[1];
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'ko' })
        .catch(() => YoutubeTranscript.fetchTranscript(videoId));
      sourceText = `[레퍼럴 재창작] ${items.map(i => i.text).join(' ').slice(0, 600)}`;
      sourceLabel = `YouTube/${videoId}`;
    } catch (e) {
      throw new Error(`자막 추출 실패: ${e.message}`);
    }
  } else if (topic) {
    await sendTg(chatId, `🎬 영상 자동 제작을 시작합니다!\n\n📝 주제: <b>${topic}</b>`);
    sourceText = topic;
    sourceLabel = topic.slice(0, 40);
  } else {
    throw new Error('youtubeUrl 또는 topic이 필요합니다.');
  }

  // ── Step 2: 스토리보드 생성 (씬 수 하드 제한 적용) ────────────
  progress('2/5 대본+씬 생성 중...');
  await sendTg(chatId,
    `📝 <b>Step 2/5</b> ${cfg.maxScenes}개 씬 대본 구성 중...` +
    (guidelineTitle ? `\n📋 지침: ${guidelineTitle}` : '')
  );

  const sbRes = await axios.post(`${BASE}/api/generate-storyboard`, {
    topic: sourceText,
    refVideoTitle: sourceLabel,
    guideline: `영상 길이: ${cfg.durationMin}분 / 씬 수: 정확히 ${cfg.maxScenes}개 / 포맷: ${format === 'shortform' ? '숏폼' : '롱폼'} / 씬당 대사는 짧고 임팩트 있게`,
    format: format === 'shortform' ? 'shorts' : 'longform',
    style,
    scriptGuideline,
  }, { timeout: 120000 });

  let scenes = sbRes.data?.scenes;
  if (!scenes?.length) throw new Error('씬 생성 실패 — 스토리보드 API 응답 없음');

  // 씬 수 초과 시 강제 절삭
  if (scenes.length > cfg.maxScenes) {
    console.warn(`[${jobId}] 씬 수 초과 (${scenes.length} → ${cfg.maxScenes}개로 절삭)`);
    scenes = scenes.slice(0, cfg.maxScenes);
  }

  // ── Step 3: 이미지 프롬프트 생성 ──────────────────────────────
  progress('3/5 이미지 프롬프트 생성 중...');
  let promptedScenes = scenes;
  try {
    const prRes = await axios.post(`${BASE}/api/generate-scene-prompts`, {
      scenes, style, format: format === 'shortform' ? 'shorts' : 'longform',
    }, { timeout: 60000 });
    promptedScenes = prRes.data?.scenes || scenes;
  } catch (e) {
    console.warn(`[${jobId}] 프롬프트 생성 실패, 원본 씬 사용:`, e.message);
  }

  // ── Step 4: TTS 먼저 생성 → 실제 오디오 길이 확정 ────────────
  // 이미지는 TTS와 병렬로 생성 (속도 유지)
  progress('4/5 나레이션 생성 + 이미지 병렬 생성 중...');
  await sendTg(chatId, `🎙️ <b>Step 4/5</b> 나레이션 + ${promptedScenes.length}개 이미지 생성 중...`);

  const fullScript = promptedScenes.map(s => s.scriptText || s.narration || '').join(' ');
  const audioPath = path.join(TMP_DIR, `${jobId}_audio.mp3`);

  const [imageResults, ttsBuffer] = await Promise.all([
    // 이미지 병렬 생성
    Promise.all(promptedScenes.map(async (scene, i) => {
      const prompt = scene.imagePrompt || scene.visualDescription || scene.scriptText || `씬 ${i + 1}`;
      try {
        const res = await axios.post(`${BASE}/api/generate-image`, {
          prompt, style, ratio, model: 'dall-e',
        }, { timeout: 90000 });
        const { imageUrl } = res.data;
        const imgPath = path.join(TMP_DIR, `${jobId}_img${i}.png`);
        if (imageUrl?.startsWith('data:')) {
          fs.writeFileSync(imgPath, Buffer.from(imageUrl.split(',')[1], 'base64'));
        } else {
          const buf = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
          fs.writeFileSync(imgPath, Buffer.from(buf.data));
        }
        return { ...scene, localPath: imgPath };
      } catch (e) {
        console.warn(`[${jobId}] 이미지 ${i + 1} 실패:`, e.message);
        return { ...scene, localPath: null };
      }
    })),

    // TTS 생성
    axios.post(`${BASE}/api/tts`, {
      text: fullScript, engine: 'ElevenLabs', voiceId: '21m00Tcm4TlvDq8ikWAM',
    }, { responseType: 'arraybuffer', timeout: 120000 })
      .then(r => Buffer.from(r.data))
      .catch(async (e) => {
        console.warn(`[${jobId}] ElevenLabs 실패, Google TTS 시도:`, e.message);
        const r = await axios.post(`${BASE}/api/tts`, {
          text: fullScript, engine: 'GoogleTTS', voiceId: 'ko-KR-Wavenet-A',
        }, { responseType: 'arraybuffer', timeout: 60000 });
        return Buffer.from(r.data);
      }),
  ]);

  // TTS 저장 후 실제 오디오 길이 측정
  fs.writeFileSync(audioPath, ttsBuffer);
  const actualAudioSec = await getAudioDuration(audioPath);
  console.log(`[${jobId}] 실제 오디오 길이: ${actualAudioSec.toFixed(2)}초`);

  // 씬별 길이 = 실제 오디오 길이를 텍스트 비율로 분배
  const totalTextLen = promptedScenes.reduce((sum, s) => sum + (s.scriptText || s.narration || '').length, 0);
  const scenesWithDuration = promptedScenes.map(s => {
    const textLen = (s.scriptText || s.narration || '').length || 1;
    const ratio_t = totalTextLen > 0 ? textLen / totalTextLen : 1 / promptedScenes.length;
    const dur = Math.max(2, parseFloat((actualAudioSec * ratio_t).toFixed(2)));
    return { ...s, calculatedDuration: dur };
  });

  const validScenes = imageResults
    .map((r, i) => ({ ...scenesWithDuration[i], localPath: r.localPath }))
    .filter(s => s.localPath);
  if (!validScenes.length) throw new Error('이미지 생성 실패 — 사용 가능한 클립 없음');

  // ── Step 5: FFmpeg 합성 (나레이션 길이 기준 씬 클립 생성) ──────
  progress('5/5 영상 합성 중...');
  await sendTg(chatId, `🎬 <b>Step 5/5</b> ${validScenes.length}개 씬 합성 중...\n⏱️ 총 오디오: ${actualAudioSec.toFixed(1)}초`);

  const [outW, outH] = ratio === '9:16' ? [1080, 1920] : [1920, 1080];

  const clipPaths = [];
  for (let i = 0; i < validScenes.length; i++) {
    const scene = validScenes[i];
    const duration_s = scene.calculatedDuration;
    const fps = 25;
    const frames = Math.round(duration_s * fps);
    const clipPath = path.join(TMP_DIR, `${jobId}_clip${i}.mp4`);
    const kenFilter = `zoompan=z='min(zoom+${(0.10 / frames).toFixed(6)},1.10)':d=${frames}:s=${outW}x${outH}:fps=${fps}`;
    const vf = `scale=${outW * 2}:${outH * 2},${kenFilter},setsar=1`;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(scene.localPath)
        .inputOptions(['-loop 1'])
        .outputOptions([`-t ${duration_s}`, '-c:v libx264', '-pix_fmt yuv420p', `-r ${fps}`, `-vf ${vf}`])
        .output(clipPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    cleanup(scene.localPath);
    clipPaths.push(clipPath);
  }

  // 클립 이어붙이기
  const listPath = path.join(TMP_DIR, `${jobId}_list.txt`);
  fs.writeFileSync(listPath, clipPaths.map(p => `file '${p}'`).join('\n'));
  const concatPath = path.join(TMP_DIR, `${jobId}_concat.mp4`);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .output(concatPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
  cleanup(listPath, ...clipPaths);

  // 나레이션 합성
  const narPath = path.join(TMP_DIR, `${jobId}_nar.mp4`);
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatPath)
      .input(audioPath)
      .complexFilter('[1:a]apad[aout]')
      .outputOptions(['-map 0:v:0', '-map [aout]', '-c:v copy', '-c:a aac', '-shortest'])
      .output(narPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
  cleanup(concatPath, audioPath);

  // 자막 burn-in (calculatedDuration 기준)
  const assContent = generateAss(validScenes.map(s => ({ ...s, estimatedDuration: s.calculatedDuration })), ratio);
  const assPath = path.join(TMP_DIR, `${jobId}.ass`);
  fs.writeFileSync(assPath, assContent, 'utf8');
  const finalPath = path.join(TMP_DIR, `${jobId}_final.mp4`);

  await new Promise((resolve, reject) => {
    ffmpeg(narPath)
      .outputOptions([`-vf ass=${assPath}`, '-c:a copy'])
      .output(finalPath)
      .on('end', resolve)
      .on('error', (err) => { cleanup(assPath); reject(err); })
      .run();
  });
  cleanup(assPath, narPath);

  jobs[jobId].resultFile = finalPath;
  const railwayUrl = `${SERVER_BASE_URL}/jobs/${jobId}/result`;

  progress('Firebase 업로드 중...');
  const destPath = `auto-pipeline/${jobId}/final.mp4`;
  const firebaseUrl = await uploadToFirebase(finalPath, destPath);

  const downloadUrl = firebaseUrl || railwayUrl;
  const urlNote = firebaseUrl ? '☁️ Firebase에 영구 저장됨' : '⏳ 임시 링크 (1시간 유효)';

  await sendTg(chatId,
    `✅ <b>영상 제작 완료!</b>\n\n` +
    `📹 씬 수: ${validScenes.length}개\n` +
    `⏱️ 영상 길이: ${actualAudioSec.toFixed(1)}초\n` +
    `${urlNote}\n` +
    `🔗 <a href="${downloadUrl}">영상 다운로드</a>\n\n` +
    `<i>아래에서 영상을 바로 확인하세요 👇</i>`
  );
  await sendTgVideo(chatId, downloadUrl, `🎬 자동 제작 완성 영상 (${actualAudioSec.toFixed(1)}초, ${validScenes.length}씬)`);

  return downloadUrl;
}

// ── 도우인 자막 ASS 생성 (script 분할 + 폰트/위치 반영) ──────────
function generateDouyinAss(script, totalSec, fontId, position) {
  const fontMap = {
    gmarket:      'Gmarket Sans TTF Bold',
    nanumgothic:  'NanumGothic',
    nanummyeongjo:'NanumMyeongjo',
    blackhansans: 'Black Han Sans',
    dohyeon:      'Do Hyeon',
    jua:          'Jua',
  };
  const fontName = fontMap[fontId] || 'NanumGothic';
  const playResX = 1080;
  const playResY = 1920;
  // ASS Alignment: 8=top-center, 5=mid-center, 2=bottom-center
  const alignment = position === 'top' ? 8 : position === 'middle' ? 5 : 2;
  const marginV = position === 'middle' ? 0 : Math.round(playResY * 0.12);

  // 문장 단위 분할 → 30자 초과 시 쉼표 기준 재분할
  const sentences = script.replace(/\n+/g, ' ').split(/(?<=[.!?。！？])\s*/).filter(s => s.trim());
  const chunks = [];
  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length <= 30) { chunks.push(s); continue; }
    const parts = s.split(/(?<=[,，、])\s*/);
    let buf = '';
    for (const p of parts) {
      if ((buf + p).length <= 30) buf += p;
      else { if (buf) chunks.push(buf.trim()); buf = p; }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  if (chunks.length === 0) chunks.push(script.trim());

  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
  const toAss = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.round((sec % 1) * 100);
    return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
  };

  let t = 0;
  const events = chunks.map(chunk => {
    const dur = Math.max(0.8, totalSec * (chunk.length / totalChars));
    const lines = chunk.length > 15 ? chunk.match(/.{1,15}/g).join('\\N') : chunk;
    const line = `Dialogue: 0,${toAss(t)},${toAss(t + dur - 0.05)},Default,,0,0,0,,${lines}`;
    t += dur;
    return line;
  }).join('\n');

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},68,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,${alignment},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

// ── 작업: 도우인 변환 영상 합성 (영상 + TTS 오디오 + 한국어 자막 + 블러) ──
// 입력: { videoUrl, audioBase64, font, subtitlePosition, videoFilter, script }
async function jobDouyinMerge(jobId, job) {
  const {
    videoUrl, audioBase64,
    font = 'nanumgothic',
    subtitlePosition = 'bottom',
    videoFilter = '',
    script = '',
  } = job;

  if (!videoUrl) throw new Error('videoUrl 없음');
  if (!audioBase64) throw new Error('audioBase64 없음');

  const videoPath = path.join(TMP_DIR, `${jobId}_video.mp4`);
  const videoRes = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 120000,
  });
  fs.writeFileSync(videoPath, Buffer.from(videoRes.data));

  const audioPath = path.join(TMP_DIR, `${jobId}_audio.mp3`);
  fs.writeFileSync(audioPath, Buffer.from(audioBase64, 'base64'));
  const audioSec = await getAudioDuration(audioPath);

  // Step 1: 영상 루프 + 오디오 교체 (+ 자막영역 블러)
  const mergedPath = path.join(TMP_DIR, `${jobId}_merged.mp4`);
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath).inputOptions(['-stream_loop -1'])
      .input(audioPath);

    if (videoFilter) {
      // videoFilter는 [vmain]으로 끝나야 함 (finalize route에서 그렇게 구성)
      cmd.outputOptions([
        '-filter_complex', videoFilter,
        '-map', '[vmain]',
        '-map', '1:a:0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25',
        '-c:a', 'aac',
        '-shortest',
      ]);
    } else {
      cmd.outputOptions([
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '25',
        '-c:a', 'aac',
        '-shortest',
      ]);
    }
    cmd.output(mergedPath).on('end', resolve).on('error', reject).run();
  });
  cleanup(videoPath, audioPath);

  // Step 2: 한국어 자막 burn-in
  let outputPath = mergedPath;
  if (script && script.trim()) {
    const assPath = path.join(TMP_DIR, `${jobId}.ass`);
    fs.writeFileSync(assPath, generateDouyinAss(script.trim(), audioSec, font, subtitlePosition), 'utf8');
    const finalPath = path.join(TMP_DIR, `${jobId}_final.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(mergedPath)
        .outputOptions([`-vf ass=${assPath}`, '-c:a copy'])
        .output(finalPath)
        .on('end', resolve)
        .on('error', (err) => { cleanup(assPath); reject(err); })
        .run();
    });
    cleanup(assPath, mergedPath);
    outputPath = finalPath;
  }

  jobs[jobId].resultFile = outputPath;
  return `${SERVER_BASE_URL}/jobs/${jobId}/result`;
}

// ── 작업 1: 영상 + 음성 합성 ─────────────────────────────────────
async function jobMerge(jobId, job) {
  const { videoUrl, audioUrl, audioBase64 } = job;

  const videoPath = await download(videoUrl, 'mp4');
  let audioPath;
  if (audioBase64) {
    audioPath = path.join(TMP_DIR, `${jobId}_audio.mp3`);
    fs.writeFileSync(audioPath, Buffer.from(audioBase64, 'base64'));
  } else {
    audioPath = await download(audioUrl, 'mp3');
  }
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
      // 영상 다운로드 → 나레이션 길이에 맞게 트림/루프 후 재인코딩
      const tmpPath = await download(clip.videoUrl, 'mp4');
      const clipDuration = clip.duration || 5;
      await new Promise((resolve, reject) => {
        const cmd = clip.loop
          ? ffmpeg(tmpPath).inputOptions(['-stream_loop -1'])
          : ffmpeg(tmpPath);
        if (clip.startTime && clip.startTime > 0) {
          cmd.inputOptions([`-ss ${clip.startTime}`]);
        }
        cmd
          .outputOptions([`-t ${clipDuration}`, '-c:v libx264', '-an', '-pix_fmt yuv420p', '-r 25', `-vf ${scaleFilter}`])
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

  // 자막 번인 (ASS 형식)
  if (job.subtitleContent) {
    jobs[jobId].progress = '자막 합성 중';
    const assPath = path.join(TMP_DIR, `${jobId}.ass`);
    fs.writeFileSync(assPath, job.subtitleContent, 'utf8');
    const subbedPath = path.join(TMP_DIR, `${jobId}_subbed.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(outputPath)
        .outputOptions([`-vf ass=${assPath}`, '-c:a copy'])
        .output(subbedPath)
        .on('end', resolve)
        .on('error', (err) => { cleanup(assPath); reject(err); })
        .run();
    });
    cleanup(assPath, outputPath);
    outputPath = subbedPath;
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

// 도우인 변환 합성 (비동기, jobId 반환 → /douyin-merge/:jobId로 폴링)
app.post('/douyin-merge', (req, res) => {
  const jobId = uuidv4();
  const job = { ...req.body, type: 'douyin-merge' };
  jobs[jobId] = { ...job, status: 'queued', createdAt: Date.now() };
  processJob(jobId, job).catch(console.error);
  res.json({ jobId, status: 'queued' });
});

// 도우인 변환 상태 조회 (finalize route가 폴링)
app.get('/douyin-merge/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없음' });
  res.json(job);
});

// 작업 등록
app.post('/jobs', (req, res) => {
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
