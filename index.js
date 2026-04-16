require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

const institutions = require('../data/institutions.json');
const activeCalls = new Map();

// ── WebSocket ──────────────────────────────────────────────────────────
const wsClients = new Map();
wss.on('connection', (ws, req) => {
  const sid = new URL('http://x' + req.url).searchParams.get('session') || Date.now().toString();
  wsClients.set(sid, ws);
  ws.on('close', () => wsClients.delete(sid));
});

function push(sessionId, data) {
  const ws = wsClients.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function log(callId, type, message, extra = {}) {
  const s = activeCalls.get(callId);
  if (!s) return;
  s.log.push({ time: Date.now(), type, message, ...extra });
  push(s.sessionId, { type, callId, message, ...extra });
  console.log(`[${callId.slice(0,8)}] [${type}] ${message}`);
}

// ── 설정 API ──────────────────────────────────────────────────────────
// 앱에서 API 키를 입력받아 서버 환경변수로 사용
let runtimeConfig = {
  twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhone: process.env.TWILIO_PHONE_NUMBER || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  baseUrl: process.env.BASE_URL || ''
};

app.get('/api/config-status', (req, res) => {
  res.json({
    twilio: !!(runtimeConfig.twilioSid && runtimeConfig.twilioToken && runtimeConfig.twilioPhone),
    anthropic: !!runtimeConfig.anthropicKey,
    baseUrl: !!runtimeConfig.baseUrl
  });
});

app.post('/api/config', (req, res) => {
  const { twilioSid, twilioToken, twilioPhone, anthropicKey, baseUrl } = req.body;
  if (twilioSid) runtimeConfig.twilioSid = twilioSid;
  if (twilioToken) runtimeConfig.twilioToken = twilioToken;
  if (twilioPhone) runtimeConfig.twilioPhone = twilioPhone;
  if (anthropicKey) runtimeConfig.anthropicKey = anthropicKey;
  if (baseUrl) runtimeConfig.baseUrl = baseUrl;
  res.json({ ok: true });
});

// ── 기관 목록 ──────────────────────────────────────────────────────────
app.get('/api/institutions', (req, res) => res.json(institutions));

// ── 의도 분석 ──────────────────────────────────────────────────────────
app.post('/api/intent', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '텍스트가 필요합니다.' });
  if (!runtimeConfig.anthropicKey) return res.status(400).json({ error: 'Anthropic API 키를 먼저 설정해주세요.' });

  const claude = new Anthropic({ apiKey: runtimeConfig.anthropicKey });
  const list = institutions.map(i =>
    `- ${i.name} (별칭:${(i.aliases||[]).join(',')}) 서비스:${Object.keys(i.services||{}).join(',')}`
  ).join('\n');

  try {
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: `사용자 요청에서 기관과 서비스를 추출해 JSON으로만 응답. 다른 텍스트 금지.
{"institution":"기관명","service":"서비스명","confidence":0.9,"reason":"근거"}
기관목록:\n${list}`,
      messages: [{ role: 'user', content: text }]
    });

    let parsed;
    try { parsed = JSON.parse(msg.content[0].text.trim()); }
    catch { const m = msg.content[0].text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed) return res.status(422).json({ error: '분석 실패' });

    const found = institutions.find(i =>
      i.name === parsed.institution ||
      (i.aliases||[]).some(a => parsed.institution?.includes(a) || a.includes(parsed.institution||''))
    );
    if (!found) return res.status(404).json({ error: `"${parsed.institution}" 기관을 찾을 수 없습니다.` });

    const dtmf = found.services?.[parsed.service] || found.services?.['상담원'] || ['0'];
    res.json({ institution: found, service: parsed.service, dtmfSequence: dtmf, reason: parsed.reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 전화 발신 ──────────────────────────────────────────────────────────
app.post('/api/call/start', async (req, res) => {
  const { phone, institution, service, dtmfSequence, sessionId } = req.body;
  if (!runtimeConfig.twilioSid) return res.status(400).json({ error: 'Twilio 설정이 필요합니다.' });

  let num = phone.replace(/[-\s]/g, '');
  if (num.startsWith('0')) num = '+82' + num.slice(1);
  else if (!num.startsWith('+')) num = '+82' + num;

  const callId = uuidv4();
  activeCalls.set(callId, { sessionId, institution, service, dtmfSequence: dtmfSequence||[], dtmfStep:0, phase:'dialing', log:[], startTime:Date.now() });

  try {
    const client = twilio(runtimeConfig.twilioSid, runtimeConfig.twilioToken);
    const baseUrl = runtimeConfig.baseUrl;
    const call = await client.calls.create({
      to: num,
      from: runtimeConfig.twilioPhone,
      url: `${baseUrl}/twilio/voice?callId=${callId}`,
      statusCallback: `${baseUrl}/twilio/status?callId=${callId}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated','ringing','answered','completed'],
      timeout: 60
    });
    activeCalls.get(callId).twilioSid = call.sid;
    push(sessionId, { type:'call_started', callId, institution, service, phone: num });
    res.json({ success:true, callId });
  } catch (err) {
    activeCalls.delete(callId);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/call/hangup', async (req, res) => {
  const s = activeCalls.get(req.body.callId);
  if (!s?.twilioSid) return res.status(404).json({ error: '통화 없음' });
  try {
    const client = twilio(runtimeConfig.twilioSid, runtimeConfig.twilioToken);
    await client.calls(s.twilioSid).update({ status: 'completed' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Twilio 웹훅 ───────────────────────────────────────────────────────
const VoiceResponse = twilio.twiml.VoiceResponse;

async function arsDecide(arsText, institution, service, dtmfSeq, step) {
  if (dtmfSeq && step < dtmfSeq.length) {
    return { action:'press', digit: dtmfSeq[step], reason:'사전 설정 경로' };
  }
  if (!runtimeConfig.anthropicKey) return { action:'agent', reason:'API 키 없음' };
  try {
    const claude = new Anthropic({ apiKey: runtimeConfig.anthropicKey });
    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 200,
      system: `ARS 안내를 보고 "${institution}"의 "${service}"를 위해 눌러야 할 번호를 JSON으로만 답하세요.
완료됐으면 action:"done", 상담원 필요시 action:"agent", 번호 누를때 action:"press"
{"action":"press"|"agent"|"done"|"wait","digit":"번호","reason":"이유"}`,
      messages: [{ role:'user', content: `ARS: "${arsText}"` }]
    });
    const m = msg.content[0].text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { action:'agent', reason:'파싱실패' };
  } catch(e) { return { action:'agent', reason: e.message }; }
}

app.post('/twilio/voice', async (req, res) => {
  const callId = req.query.callId;
  const s = activeCalls.get(callId);
  const twiml = new VoiceResponse();
  if (!s) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  s.phase = 'connected';
  log(callId, 'call_connected', '📞 전화 연결됨');

  const g = twiml.gather({ input:'speech dtmf', language:'ko-KR', speechTimeout:'auto',
    timeout:8, action:`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`, method:'POST', numDigits:1 });
  g.pause({ length:2 });
  twiml.redirect(`${runtimeConfig.baseUrl}/twilio/voice?callId=${callId}`);
  res.type('text/xml').send(twiml.toString());
});

app.post('/twilio/gather', async (req, res) => {
  const callId = req.query.callId;
  const s = activeCalls.get(callId);
  const twiml = new VoiceResponse();
  if (!s) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  const speech = req.body.SpeechResult || '';
  if (speech) log(callId, 'ars_speech', `🔊 "${speech}"`);

  const agentKw = ['상담사','상담원','연결해 드리겠습니다','연결합니다','잠시만 기다려'];
  const doneKw  = ['조회 결과','잔액은','처리 완료','처리되었습니다'];

  if (agentKw.some(k => speech.includes(k))) {
    s.phase = 'agent_connecting';
    log(callId, 'agent_connecting', '👤 상담원 연결 중...');
    const g = twiml.gather({ input:'speech', language:'ko-KR', speechTimeout:'auto',
      timeout:30, action:`${runtimeConfig.baseUrl}/twilio/agent?callId=${callId}`, method:'POST' });
    g.pause({ length:1 });
  } else if (doneKw.some(k => speech.includes(k))) {
    s.phase = 'done';
    log(callId, 'service_done', `✅ 완료: "${speech}"`, { result: speech });
    twiml.pause({ length:2 }); twiml.hangup();
  } else if (speech) {
    const decision = await arsDecide(speech, s.institution, s.service, s.dtmfSequence, s.dtmfStep);
    if (decision.action === 'press') {
      s.dtmfStep++;
      log(callId, 'ai_action', `🤖 ${decision.digit}번 선택 — ${decision.reason}`, { digit: decision.digit });
      twiml.pause({ length:1 });
      twiml.play({ digits: decision.digit });
      const g = twiml.gather({ input:'speech dtmf', language:'ko-KR', speechTimeout:'auto',
        timeout:8, action:`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`, method:'POST', numDigits:1 });
      g.pause({ length:2 });
      twiml.redirect(`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`);
    } else if (decision.action === 'done') {
      s.phase = 'done';
      log(callId, 'service_done', `✅ 완료`, { result: speech });
      twiml.pause({ length:2 }); twiml.hangup();
    } else if (decision.action === 'agent') {
      s.phase = 'need_agent';
      log(callId, 'need_agent', '📢 상담원 연결 필요');
      const g = twiml.gather({ input:'speech', language:'ko-KR', speechTimeout:'auto',
        timeout:60, action:`${runtimeConfig.baseUrl}/twilio/agent?callId=${callId}`, method:'POST' });
      g.pause({ length:1 });
    } else {
      const g = twiml.gather({ input:'speech dtmf', language:'ko-KR', speechTimeout:'auto',
        timeout:10, action:`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`, method:'POST', numDigits:1 });
      g.pause({ length:3 });
      twiml.redirect(`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`);
    }
  } else {
    const g = twiml.gather({ input:'speech dtmf', language:'ko-KR', speechTimeout:'auto',
      timeout:8, action:`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`, method:'POST', numDigits:1 });
    g.pause({ length:3 });
    twiml.redirect(`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`);
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/twilio/agent', async (req, res) => {
  const callId = req.query.callId;
  const s = activeCalls.get(callId);
  const twiml = new VoiceResponse();
  if (!s) { twiml.hangup(); return res.type('text/xml').send(twiml.toString()); }

  const speech = req.body.SpeechResult || '';
  const greetKw = ['안녕하세요','무엇을','도와드릴','말씀하세요','상담사'];

  if (greetKw.some(k => speech.includes(k)) || s.phase === 'need_agent') {
    s.phase = 'agent_connected';
    log(callId, 'agent_connected', '🔔 상담원 연결됨! 고객에게 알림', { agentSpeech: speech });
    twiml.say({ language:'ko-KR', voice:'Polly.Seoyeon' }, '잠시만 기다려 주세요. 고객을 연결해 드리겠습니다.');
    twiml.pause({ length:10 });
    const g = twiml.gather({ input:'speech', language:'ko-KR', timeout:120,
      action:`${runtimeConfig.baseUrl}/twilio/agent?callId=${callId}`, method:'POST' });
    g.pause({ length:5 });
  } else {
    const g = twiml.gather({ input:'speech', language:'ko-KR', speechTimeout:'auto',
      timeout:30, action:`${runtimeConfig.baseUrl}/twilio/agent?callId=${callId}`, method:'POST' });
    g.pause({ length:2 });
    twiml.redirect(`${runtimeConfig.baseUrl}/twilio/gather?callId=${callId}`);
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/twilio/status', (req, res) => {
  const callId = req.query.callId;
  const { CallStatus, CallDuration } = req.body;
  const s = activeCalls.get(callId);
  if (s) {
    const typeMap = { completed:'call_ended', failed:'call_failed', busy:'call_busy', 'no-answer':'call_noanswer' };
    const msgMap  = { completed:`✅ 통화 종료 (${CallDuration}초)`, failed:'❌ 통화 실패', busy:'📵 통화 중', 'no-answer':'📵 응답 없음' };
    if (typeMap[CallStatus]) {
      s.phase = CallStatus;
      log(callId, typeMap[CallStatus], msgMap[CallStatus] || CallStatus, { duration: CallDuration });
    }
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 서버 시작: http://localhost:${PORT}`));
