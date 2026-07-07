import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import express from 'express'
import axios from 'axios'
import cors from 'cors'
import session from 'express-session'
import { RedisStore as ConnectRedisStore } from 'connect-redis'
import { createClient } from 'redis'
import { encoding_for_model } from 'tiktoken'
import wikiModule from 'wikipedia'

const wiki = wikiModule.default || wikiModule
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const port = process.env.PORT

const redisClient = createClient({ url: process.env.REDIS_URL })
await redisClient.connect()

const RedisStore = new ConnectRedisStore({ client: redisClient, prefix: 'sess:' })

app.set('trust proxy', 1)
app.use(cors({ origin: process.env.URL, credentials: true }))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use(
  session({
    store: RedisStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' },  })
)

const encoder = encoding_for_model(process.env.MODEL_ENCODING)

process.on('exit', () => { try { encoder.free() } catch {} })
process.on('SIGINT', () => process.exit())
process.on('SIGTERM', () => process.exit())

const UPTIME_KEY = 'Fortran:serverStartTime'
async function initializeStartTime() {
  let storedStartTime = await redisClient.get(UPTIME_KEY)
  if (!storedStartTime) {
    storedStartTime = Date.now().toString()
    await redisClient.set(UPTIME_KEY, storedStartTime)
  }
  return Number(storedStartTime)
}
const startTime = await initializeStartTime()

let modelStatus = { name: process.env.MODEL, temperature: 0.7, status: 'Active' }

function formatUptime() {
  const diff = Date.now() - startTime
  const seconds = Math.floor(diff / 1000) % 60
  const minutes = Math.floor(diff / (1000 * 60)) % 60
  const hours = Math.floor(diff / (1000 * 60 * 60))
  return `${hours}h ${minutes}m ${seconds}s`
}

async function loadList(key) { const data = await redisClient.get(key); return data ? JSON.parse(data) : [] }
async function saveList(key, list) { await redisClient.set(key, JSON.stringify(list)) }
async function updateList(key, entry, limit = 50) {
  const list = await loadList(key)
  list.push(entry)
  let evicted = []
  if (list.length > limit) evicted = list.splice(0, list.length - limit)
  await saveList(key, list)
  return evicted
}

function extractImageId(message) {
  if (!message || !message.startsWith('[Image generated]')) return null
  const url = message.replace('[Image generated] ', '').trim()
  return url.split('/').pop() || null
}

async function pruneEvictedImages(evictedEntries) {
  for (const e of evictedEntries) {
    const id = extractImageId(e?.message)
    if (id) {
      try { await redisClient.del(`Fortran:img:${id}`) } catch {}
    }
  }
  
}async function getTotalTokens() { const tokenStats = await loadList('Fortran:tokens'); return tokenStats.reduce((sum, t) => sum + t.tokens, 0) }
async function scanKeys(pattern) {
  let cursor = '0'
  const keys = []
  do {
    const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 })
    cursor = result.cursor
    keys.push(...result.keys)
  } while (cursor !== '0')
  return keys
}
async function getLocationFromIP(ip) {
  try {
    const res = await axios.get(`https://ipwho.is/${ip}`)
    if (res.data.success) {
      const { city, region, country } = res.data
      return `${city||'Unknown city'}, ${region||'Unknown region'}, ${country||'Unknown country'}`
    }
  } catch {}
  return 'Unknown location'
}

function sanitizeAnswer(text) {
  const forbidden = [
  /I am (OpenAI|ChatGPT|GPT-4|GPT-3|Gemini|Claude|Llama|Mistral)/i,
  /I('m| am) (an AI (assistant|model) (made|created|developed|trained) by)/i,
  /created by (OpenAI|Google|Anthropic|Meta|Mistral)/i,
  /(powered|built|based) (by|on) (OpenAI|GPT|Gemini|Claude|Llama|Mistral)/i,
  /under the hood.{0,20}(OpenAI|GPT|Gemini|Claude|Llama|Mistral)/i,
]
  for (const p of forbidden) if (p.test(text)) return "I'm Fortran AI, created by Kn3ghtfall."
  return text
}

async function fetchGoogleResults(query) { try { const cx = process.env.GOOGLE_CX, apiKey = process.env.GOOGLE_API_KEY; if (!cx||!apiKey) return null; const res = await axios.get('https://www.googleapis.com/customsearch/v1',{ params:{ key: apiKey, cx, q: query, num: 5 } }); if (!res.data.items||res.data.items.length===0) return null; return res.data.items.map(item => ({ title:item.title, snippet:item.snippet, link:item.link })) } catch { return null } }
function escapeSparqlLiteral(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

async function fetchWikidata(query) { try { const safeQuery = escapeSparqlLiteral(query); const sparql = `SELECT ?item ?itemLabel ?description WHERE {?item ?label "${safeQuery}"@en. ?item schema:description ?description. SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }} LIMIT 1`; const res = await axios.get('https://query.wikidata.org/sparql',{ headers:{ Accept:'application/sparql-results+json' }, params:{ query:sparql } }); const results=res.data.results.bindings; if(results.length===0) return null; const {itemLabel,description}=results[0]; return `${itemLabel.value}: ${description.value}` } catch { return null } }async function fetchNews(query) { try { const apiKey = process.env.NEWS_API_KEY; const res = await axios.get('https://newsapi.org/v2/everything',{ params:{ q:query, sortBy:'publishedAt', language:'en', pageSize:5, apiKey } }); if(!res.data.articles||res.data.articles.length===0) return null; return res.data.articles.map(a=>({ title:a.title, description:a.description||'No description', source:a.source.name, url:a.url })) } catch { return null } }

async function callModel(messages, maxTokens = 10000) {
  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: modelStatus.temperature,
        stop: ['\nuser:', '\nai:']
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } }
    )

    const choice = response.data.choices?.[0]?.message?.content
    if (!choice) return null
    return choice.trim()
  } catch (err) {
    console.error(err.response?.data || err)
    return null
  }
}

function requireAuth(req, res, next) { if (req.session.isAdmin) return next(); return res.status(403).json({ error: 'Forbidden' }) }

async function logIP(req) {
  let ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress
  if (ip && ip.includes(',')) ip = ip.split(',')[0].trim()
  if (!ip) return
  const savedIPs = await loadList('Fortran:uniqueIPs')
  if (!savedIPs.some(entry => entry.ip === ip)) {
    const location = await getLocationFromIP(ip)
    savedIPs.push({ ip, location })
    await saveList('Fortran:uniqueIPs', savedIPs)
    await updateList('Fortran:logs', { timestamp: new Date().toISOString(), message: `New IP logged: ${ip} - Location: ${location}` })
  }
}

function timingSafeStringEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a)).digest()
  const bufB = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(bufA, bufB)
}

function isValidClientId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

const CLIENT_TOKEN_TTL_SECONDS = 60 * 60 * 24

async function getClientTokens(clientId) {
  const val = await redisClient.get(`Fortran:clientTokens:${clientId}`)
  return val ? Number(val) : 0
}

async function addClientTokens(clientId, amount) {
  const updated = await redisClient.incrBy(`Fortran:clientTokens:${clientId}`, amount)
  await redisClient.expire(`Fortran:clientTokens:${clientId}`, CLIENT_TOKEN_TTL_SECONDS)
  return updated
}

app.post('/api/auth', (req, res) => {
  const { password } = req.body
  if (typeof password === 'string' && timingSafeStringEqual(password, process.env.FORTRAN_OS_KEY)) {
    req.session.isAdmin = true
    return res.json({ success: true })
  }
  return res.json({ success: false })
})

app.get('/api/session-check', (req, res) => res.json({ isAdmin: !!req.session.isAdmin }))
app.get('/api/ping', (req, res) => res.send('pong'))

const PUBLIC_API_ROUTES = new Set(['/auth', '/ping', '/session-check', '/logout-beacon'])

app.use('/api', (req, res, next) => {
  if (PUBLIC_API_ROUTES.has(req.path)) return next()
  return requireAuth(req, res, next)
})

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Fortran.html')))
app.get('/Console', (req, res) => res.sendFile(path.join(__dirname, 'public', 'Console.html')))

app.get('/api/token-stats', async (req, res) => { const tokens = await loadList('Fortran:tokens'); res.json(tokens.slice(-50)) })
app.get('/api/securityLogs', async (req, res) => { const logs = await loadList('Fortran:logs'); res.json(logs.slice(-50).reverse()) })
app.get('/api/chatHistory', async (req, res) => { const chats = await loadList('Fortran:chat'); res.json(chats.slice(-50)) })
app.get('/api/stats', async (req, res) => { try { const totalTokensUsed = await getTotalTokens()||0; const uptime = formatUptime()||'0h 0m 0s'; res.json({ uptime, totalTokensUsed, model: modelStatus.name||'Unknown', status: modelStatus.status||'Unknown' }) } catch { res.json({ uptime:'0h 0m 0s', totalTokensUsed:0, model:'Unknown', status:'Offline' }) } })
app.get('/api/ips', async (req, res) => { const ips = await loadList('Fortran:uniqueIPs'); const results = ips.map(({ip,location})=>({ip,location})); res.json({ uniqueIPs: results }) })
app.get('/api/modelStatus', (req, res) => res.json(modelStatus))
app.post('/api/securityLogs/clear', async (req, res) => { await saveList('Fortran:logs', []); res.sendStatus(200) })
app.post('/api/chatHistory/clear', async (req, res) => {
  try {
    const keys = await scanKeys('Fortran:img:*')
    if (keys.length > 0) await redisClient.del(keys)
  } catch {}
  await saveList('Fortran:chat', [])
  res.sendStatus(200)
})
app.post('/api/token-stats/clear', async (req, res) => { await saveList('Fortran:tokens', []); res.sendStatus(200) })
app.post('/api/ips/clear', async (req, res) => { await saveList('Fortran:uniqueIPs', []); res.sendStatus(200) })

app.post('/api/logout', (req, res) => { req.session.destroy(err=>{ if(err) return res.status(500).json({ success:false }); res.clearCookie('connect.sid'); res.json({ success:true }) }) })

app.post('/api/logout-beacon', (req, res) => {
  if (req.session) req.session.destroy(() => {})
  res.sendStatus(204)
})

app.get('/images/:id', async (req, res) => {
  try {
    const data = await redisClient.get(`Fortran:img:${req.params.id}`)
    if (!data) return res.status(404).send('Not found')
    const buf = Buffer.from(data, 'base64')
    res.set('Content-Type', 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=31536000')
    res.send(buf)
  } catch (err) {
    console.error('Image serve error:', err)
    res.status(500).send('Error')
  }
})

app.post('/image', async (req, res) => {
  try {
    await logIP(req)

    const { prompt, clientId } = req.body
    if (!isValidClientId(clientId)) return res.status(400).json({ error: 'System Error' })
    if (!prompt) return res.status(400).json({ error: 'No prompt provided' })

    const currentTokens = await getClientTokens(clientId)
    if (currentTokens >= MAX_SESSION_TOKENS) {
      return res.json({
        error: 'Token limit reached. Please reload the page to start a new session.',
        tokensExceeded: true,
        sessionTokens: currentTokens
      })
    }

    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?nologo=true`
    const id = crypto.randomUUID()
    const localUrl = `/images/${id}`
    const now = new Date().toISOString()

    const promptTokens = encoder.encode(prompt).length
    const syntheticTokens = 50
    const updatedTokens = await addClientTokens(clientId, promptTokens + syntheticTokens)

    await updateList('Fortran:tokens', { role: 'user', tokens: promptTokens, timestamp: now })
    await updateList('Fortran:tokens', { role: 'ai', tokens: syntheticTokens, timestamp: now })
    const evicted1 = await updateList('Fortran:chat', { timestamp: now, role: 'user', message: `${prompt}` })
    const evicted2 = await updateList('Fortran:chat', { timestamp: now, role: 'ai', message: `[Image generated] ${localUrl}` })
    await pruneEvictedImages([...evicted1, ...evicted2])

    res.json({
      imageUrl: pollinationsUrl,
      promptTokens,
      syntheticTokens,
      tokensExceeded: updatedTokens >= MAX_SESSION_TOKENS,
      sessionTokens: updatedTokens
    })

    axios.get(pollinationsUrl, { responseType: 'arraybuffer', timeout: 120000 })
      .then(imageRes => {
        const b64 = Buffer.from(imageRes.data).toString('base64')
        return redisClient.set(`Fortran:img:${id}`, b64)
      })
      .then(() => {})
      .catch(err => console.error(`Failed to save image to Redis (${id}):`, err.message))

  } catch (err) {
    console.error('Image error:', err)
    res.status(500).json({ error: 'Image generation failed' })
  }
})

const MAX_SESSION_TOKENS = 15000

app.post('/chat', async (req, res) => {
  try {
    await logIP(req)

    const { clientId } = req.body
    if (!isValidClientId(clientId)) return res.status(400).json({ reply:'System Error', tokensExceeded:false })

    const currentTokens = await getClientTokens(clientId)
    if (currentTokens >= MAX_SESSION_TOKENS) {
      return res.json({
        reply: "This conversation has gotten too long. Please start a new chat.",
        tokensExceeded: true,
        sessionTokens: currentTokens
      })
    }

    const rawMessages = req.body.messages
    if (!rawMessages||!Array.isArray(rawMessages)||rawMessages.length===0) return res.status(400).json({ reply:'System Error', tokensExceeded:false })

    const messages = rawMessages.filter(m =>
      m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    )
    if (messages.length === 0) return res.status(400).json({ reply:'System Error', tokensExceeded:false })

    const lastMessage = messages[messages.length-1].content?.trim()||''
    const now = new Date().toISOString()
    const [wikiRes, wikidataRes, googleRes, newsRes] = await Promise.all([
    (async()=>{
        try {
          const results = await wiki.search(lastMessage)
          if (results.results.length > 0) {
            const summary = await wiki.summary(results.results[0].title)
            return summary.extract
          }
        } catch {}
        return ''
      })(), 
      fetchWikidata(lastMessage).catch(()=>''),
      fetchGoogleResults(lastMessage).then(r=>r? r.map(x=>`${x.title}:\n${x.snippet||'No snippet'}`).join('\n\n') : '').catch(()=>''),
      fetchNews(lastMessage).then(a=>a? a.map(x=>`[News] ${x.title} (${x.source}):\n${x.description}`).join('\n\n'):'').catch(()=>'')
    ])
    const freshDataText = [wikiRes,wikidataRes,googleRes,newsRes].filter(Boolean).join('\n\n')
    let systemPromptContent = `You are Fortran AI, created by Kn3ghtfall.\n\nYou MUST stay on-topic and add your own thinking to the response to make it sound as human as possible. Use live information silently to answer real queries. Be logical and casual, don't think too deep about the query and just answer. Do not claim you are anything other than Fortran AI which is made by Kn3ghtfall.\n\n`
    if(freshDataText) systemPromptContent += `Live info:\n${freshDataText}`; else systemPromptContent += `No live info available. Still answer the query thoughtfully and clearly, don't leave it blank.`
    const systemPrompt = { role:'system', content: systemPromptContent }
    const finalMessages = [systemPrompt,...messages]
    const aiReply = await callModel(finalMessages,10000)
    if (!aiReply) {
      return res.json({ reply: "Sorry, something went wrong generating a response. Please try again.", tokensExceeded: false, sessionTokens: currentTokens })
    }

    const userTokens = encoder.encode(lastMessage).length
    const aiTokens = encoder.encode(aiReply).length
    const updatedTokens = await addClientTokens(clientId, userTokens + aiTokens)

    await updateList('Fortran:tokens',{ role:'user', tokens:userTokens, timestamp:now })
    await updateList('Fortran:tokens',{ role:'ai', tokens:aiTokens, timestamp:now })
    const evicted1 = await updateList('Fortran:chat',{ timestamp:now, role:'user', message:lastMessage })
    const evicted2 = await updateList('Fortran:chat',{ timestamp:now, role:'ai', message:aiReply })
    await pruneEvictedImages([...evicted1, ...evicted2])

    res.json({
      reply: sanitizeAnswer(aiReply),
      tokensExceeded: updatedTokens >= MAX_SESSION_TOKENS,
      sessionTokens: updatedTokens
    })
  } catch (err) {
    console.error('Chat error:', err)
    res.json({ reply:"I'm Fortran AI, created by Kn3ghtfall.", tokensExceeded:false, sessionTokens: 0 })
  }
})

app.listen(port,()=>{ console.log(`Hello World`) })