/**
 * electerm-Widget: Passwörter aus Vaultwarden (oder Bitwarden) über die Bitwarden-CLI `bw`.
 *
 * - Panel (`run`): anmelden/entsperren, suchen, Verbindungen öffnen, Passwort kopieren.
 * - Passwort-Manager für Lesezeichen (`getCredentials` / `saveCredentials`): electerm fragt
 *   beim Verbinden eines Lesezeichens mit „Passwort-Manager verwenden“ und ohne eigenes Passwort.
 *
 * Die CLI bekommt einen eigenen Datenordner (~/.electerm-vaultwarden/bw), damit sie einer
 * sonst benutzten bw-Anmeldung nicht in die Quere kommt. Das Master-Passwort geht nur per
 * Umgebungsvariable an `bw` und wird nirgends gespeichert. Im Speicher bleibt die Liste der
 * Einträge ohne Passwörter; ein Passwort wird erst geholt, wenn es gebraucht wird.
 */

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let api = null
try {
  api = require('@electerm/widget-api')
} catch (e) {
  // außerhalb von electerm (Tests)
}

/** Einträge höchstens so alt, dann vor dem nächsten Nachschlagen mit dem Server abgleichen. */
const SYNC_MS = 10 * 60 * 1000
/** Kopiertes Passwort nach dieser Zeit aus der Zwischenablage entfernen. */
const CLIPBOARD_CLEAR_MS = 30 * 1000
const DEFAULT_PORTS = { ssh: 22, telnet: 23, ftp: 21, rdp: 3389, vnc: 5900, spice: 5900 }

const state = {
  session: '',
  /** [{ id, name, username, uris: [string], hasPassword }] */
  items: null,
  syncedAt: 0,
  server: '',
  email: '',
  refreshing: null
}

function appDir () {
  return process.env.ELECTERM_VW_DIR || path.join(os.homedir(), '.electerm-vaultwarden')
}

const settingsFile = () => path.join(appDir(), 'settings.json')
const sessionFile = () => path.join(appDir(), 'session.dat')

function readSettings () {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch (e) {
    return {}
  }
}

function writeSettings (s) {
  fs.mkdirSync(appDir(), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
}

// ---------------------------------------------------------------- bw aufrufen

function bwFile () {
  return readSettings().bwPath || 'bw'
}

/** bw schreibt vor die eigentliche Meldung (letzte Zeile) oft Stacktraces und Fehlerobjekte. */
function cleanError (text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^(\(node:\d+\)|at |Use `node --trace|[{}]$|[a-zA-Z]+: '|Unable to fetch ServerConfig|Could not find)/.test(l))
  const last = lines[lines.length - 1] || ''
  if (/FetchError|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|certificate/i.test(last)) {
    return `Vaultwarden-Server nicht erreichbar: ${last.replace(/^.*reason:\s*/, '')}`
  }
  return last
}

/** Sitzungsschlüssel aus `--raw`: die letzte Zeile (davor kann ein Hinweis stehen). */
const lastLine = out => out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() || ''

/**
 * `bw` ausführen; liefert stdout. Geheimnisse nur über `env`, nie als Argument.
 * @param {string[]} args
 * @param {{ session?: string, env?: object }} [opts]
 */
function bw (args, opts = {}) {
  const file = bwFile()
  // .cmd/.bat (npm-Installation unter Windows) lassen sich nur über die Shell starten
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  if (shell && args.some(a => !/^[\w@.:/+=%-]*$/.test(a))) {
    return Promise.reject(new Error('Ungültiges Zeichen für den Aufruf von bw.cmd. Besser bw.exe verwenden.'))
  }
  const env = { ...process.env, BITWARDENCLI_APPDATA_DIR: path.join(appDir(), 'bw'), BW_NOINTERACTION: 'true', ...opts.env }
  delete env.BW_SESSION
  const session = opts.session === undefined ? state.session : opts.session
  if (session) env.BW_SESSION = session
  return new Promise((resolve, reject) => {
    execFile(shell ? `"${file}"` : file, [...args, '--nointeraction'], {
      env,
      shell,
      timeout: 120000,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(new Error(`Bitwarden-CLI nicht gefunden (${file}). Installieren (Windows: „winget install Bitwarden.CLI“) oder im Feld „Bitwarden-CLI“ den Pfad angeben.`))
        }
        return reject(new Error(cleanError(stderr) || cleanError(stdout) || err.message))
      }
      resolve(String(stdout).trim())
    })
  })
}

function parseJson (out) {
  const i = out.search(/[[{]/)
  if (i < 0) throw new Error('Unerwartete Antwort von bw: ' + out.slice(0, 200))
  return JSON.parse(out.slice(i))
}

const b64 = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

const normServer = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase()

async function status (session) {
  return parseJson(await bw(['status'], { session }))
}

// ---------------------------------------------------------------- Sitzung

/** Rest der früheren Option „Entsperrt bleiben“ (bis 0.1.0): gespeicherten Sitzungsschlüssel löschen. */
function forgetStoredSession () {
  try {
    fs.unlinkSync(sessionFile())
  } catch (e) {}
}

/** Entsperrte Sitzung oder ein Fehler, den electerm einmal anzeigt (dann normale Passwortabfrage). */
async function ensureSession () {
  if (state.session) return
  throw new Error('Vaultwarden ist gesperrt. Im Widget „Vaultwarden“ einmal entsperren.')
}

function hint (e) {
  const m = e.message
  if (/two.?step|two.?factor|2fa|verification code/i.test(m)) {
    return new Error(`${m} – Zwei-Faktor-Code eintragen und nochmal ausführen, oder den API-Schlüssel (client_id/client_secret) verwenden.`)
  }
  if (/new device|device verification|otp/i.test(m)) {
    return new Error(`${m} – Vaultwarden will ein neues Gerät bestätigen lassen. Mit dem API-Schlüssel (client_id/client_secret) anmelden, dann entfällt das.`)
  }
  if (/invalid master password|username or password is incorrect/i.test(m)) {
    return new Error('Master-Passwort oder E-Mail falsch.')
  }
  return e
}

/** Anmelden (falls nötig), entsperren, abgleichen. */
async function unlock (cfg) {
  const server = normServer(cfg.serverUrl)
  const email = String(cfg.email || '').trim().toLowerCase()
  if (!server || !email) throw new Error('Server und E-Mail angeben.')
  if (!/^https?:\/\//.test(server)) throw new Error('Server bitte mit https:// angeben.')

  if (state.session && state.server === server && state.email === email) {
    const st = await status().catch(() => ({}))
    if (st.status === 'unlocked') return false
    state.session = ''
  }
  state.session = ''
  const pw = String(cfg.masterPassword || '')
  let st = await status('')
  const sameAccount = normServer(st.serverUrl) === server && String(st.userEmail || '').toLowerCase() === email
  if (st.status !== 'unauthenticated' && !sameAccount) {
    await bw(['logout'], { session: '' }).catch(() => {})
    st = { status: 'unauthenticated', serverUrl: st.serverUrl }
  }
  if (!pw) throw new Error(st.status === 'unauthenticated' ? 'Zum Anmelden das Master-Passwort eingeben.' : 'Gesperrt: Master-Passwort eingeben.')
  const secretEnv = { BW_PASSWORD: pw }
  try {
    if (st.status === 'unauthenticated') {
      if (normServer(st.serverUrl) !== server) await bw(['config', 'server', server], { session: '' })
      if (cfg.clientId && cfg.clientSecret) {
        await bw(['login', '--apikey'], { session: '', env: { BW_CLIENTID: String(cfg.clientId).trim(), BW_CLIENTSECRET: String(cfg.clientSecret).trim() } })
      } else {
        const code = String(cfg.twoFactorCode || '').replace(/\s/g, '')
        const args = ['login', email, '--passwordenv', 'BW_PASSWORD', '--raw']
        if (code) args.push('--method', '0', '--code', code)
        const session = lastLine(await bw(args, { session: '', env: secretEnv }))
        if (session) state.session = session
      }
    }
    if (!state.session) {
      state.session = lastLine(await bw(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { session: '', env: secretEnv }))
    }
  } catch (e) {
    state.session = ''
    throw hint(e)
  }
  if (!state.session) throw new Error('bw hat keinen Sitzungsschlüssel geliefert.')
  state.server = server
  state.email = email
  await refresh(true)
  return true
}

async function lock () {
  await bw(['lock']).catch(() => {})
  Object.assign(state, { session: '', items: null, syncedAt: 0 })
  forgetStoredSession()
}

// ---------------------------------------------------------------- Einträge

function toMeta (it) {
  const login = it.login || {}
  return {
    id: it.id,
    name: it.name || '',
    username: login.username || '',
    uris: (login.uris || []).map(u => u && u.uri).filter(Boolean),
    hasPassword: !!login.password
  }
}

/** Mit dem Server abgleichen (wenn `force` oder zu alt) und die Liste neu einlesen. Offline: lokale Kopie. */
async function refresh (force = false) {
  if (state.refreshing) return state.refreshing
  if (!force && state.items && Date.now() - state.syncedAt < SYNC_MS) return
  state.refreshing = (async () => {
    try {
      await bw(['sync']).then(() => { state.syncedAt = Date.now() }, e => {
        if (!state.items) state.syncedAt = Date.now() - SYNC_MS + 60000 // offline: in 1 min nochmal
        if (api) api.log('warn', 'bw sync: ' + e.message)
      })
      const items = parseJson(await bw(['list', 'items']))
      state.items = items.filter(it => it.type === 1).map(toMeta)
    } finally {
      state.refreshing = null
    }
  })()
  return state.refreshing
}

async function getItem (id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('Ungültige Eintrags-ID.')
  return parseJson(await bw(['get', 'item', id]))
}

/**
 * Adresse aus einer URI: `ssh://host:22`, `rdp://10.0.0.5`, `host:2222`, `https://host/…`.
 * @return {{ scheme: string, host: string, port: number }|null}
 */
function parseUri (value) {
  const s = String(value || '').trim()
  if (!s) return null
  const m = s.match(/^([a-z][a-z\d+.-]*):\/\//i)
  try {
    const u = new URL(m ? s : 'x://' + s)
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return null
    return { scheme: m ? m[1].toLowerCase() : '', host, port: Number(u.port) || 0 }
  } catch (e) {
    return null
  }
}

const WEB = ['http', 'https']

/**
 * Einträge zu einem Ziel: `entries` passen über die URI (Host, Port falls angegeben, Schema
 * gleich oder keins), `alternatives` nur über eine Web-URI auf denselben Host oder den Namen.
 */
function matchItems (items, target) {
  const host = String(target.host || '').trim().toLowerCase()
  const type = String(target.type || 'ssh').toLowerCase()
  const port = Number(target.port) || DEFAULT_PORTS[type] || 0
  const title = String(target.title || '').trim().toLowerCase()
  const entries = []
  const alternatives = []
  for (const it of items || []) {
    let exact = false
    let near = false
    for (const raw of it.uris) {
      const u = parseUri(raw)
      if (!u || u.host !== host) continue
      if (u.scheme === '' || u.scheme === type) {
        if (!u.port || u.port === port) exact = true
      } else if (WEB.includes(u.scheme)) {
        near = true
      }
    }
    const name = it.name.trim().toLowerCase()
    if (!exact && name && (name === host || (title && name === title))) near = true
    if (exact) entries.push(it)
    else if (near) alternatives.push(it)
  }
  return { entries, alternatives }
}

/** Was electerm bekommt: genau ein passender Eintrag → direkt, mehrere → Auswahl, keiner → null. */
function decide (match, username) {
  const { entries, alternatives } = match
  const user = String(username || '').toLowerCase()
  const sameUser = user ? entries.filter(e => e.username.toLowerCase() === user) : []
  if (sameUser.length === 1) return { use: sameUser[0] }
  if (entries.length === 1 && (!user || !entries[0].username)) return { use: entries[0] }
  if (!entries.length && !alternatives.length) return { none: true }
  const order = list => user ? [...list].sort((a, b) => (b.username.toLowerCase() === user) - (a.username.toLowerCase() === user)) : list
  return { choose: { entries: order(entries), alternatives: order(alternatives) } }
}

const entryUrl = t => `${t.type || 'ssh'}://${t.host}${t.port ? ':' + t.port : ''}`
const asEntry = it => ({ uuid: it.id, name: it.name, login: it.username })

// ---------------------------------------------------------------- Passwort-Manager-Schnittstelle

/**
 * electerm.credentialProvider.get: `{ type, host, port, username, title, uuid? }`.
 */
async function getCredentials (target = {}) {
  await ensureSession()
  if (target.uuid) {
    const it = await getItem(target.uuid)
    return { pick: { login: (it.login && it.login.username) || '', password: (it.login && it.login.password) || '' } }
  }
  await refresh()
  const d = decide(matchItems(state.items, target), target.username)
  if (d.none) return { pick: null }
  if (d.use) {
    const it = await getItem(d.use.id)
    return { pick: { login: (it.login && it.login.username) || '', password: (it.login && it.login.password) || '' } }
  }
  return {
    pick: 'choose',
    url: entryUrl(target),
    entries: d.choose.entries.map(asEntry),
    alternatives: d.choose.alternatives.map(asEntry)
  }
}

/**
 * electerm.credentialProvider.save: Login, der funktioniert hat, speichern. Mit `uuid` wird
 * dieser Eintrag aktualisiert, sonst ein neuer angelegt (URI z. B. ssh://host:22).
 */
async function saveCredentials ({ target = {}, login = '', password = '', uuid = '' } = {}) {
  await ensureSession()
  const url = entryUrl(target)
  if (uuid) {
    const it = await getItem(uuid)
    it.login = { ...(it.login || {}), password }
    if (login) it.login.username = login
    await bw(['edit', 'item', uuid, b64(it)])
  } else {
    await bw(['create', 'item', b64({
      type: 1,
      name: target.title || `${login ? login + '@' : ''}${target.host}`,
      notes: 'Angelegt von electerm',
      favorite: false,
      folderId: null,
      organizationId: null,
      reprompt: 0,
      fields: [],
      login: { username: login, password, totp: null, uris: [{ match: null, uri: url }] }
    })])
  }
  state.syncedAt = 0
  await refresh(true).catch(() => {})
  return { ok: true, url }
}

// ---------------------------------------------------------------- Panel

function failure (e) {
  return { message: e.message || String(e), messageType: 'error' }
}

const actionButtons = () => [
  { label: 'Synchronisieren', action: 'syncNow' },
  { label: 'Sperren', action: 'lockAction', danger: true }
]

function statusResult (prefix = '') {
  const n = state.items ? state.items.length : 0
  const when = state.syncedAt ? new Date(state.syncedAt).toLocaleTimeString('de-DE') : 'noch nie'
  return {
    message: `${prefix}Entsperrt: ${state.email} auf ${state.server}. ${n} Logins, abgeglichen ${when}.`,
    messageType: 'success',
    buttons: actionButtons()
  }
}

function search (query) {
  const q = query.toLowerCase()
  const hits = state.items.filter(it =>
    it.name.toLowerCase().includes(q) ||
    it.username.toLowerCase().includes(q) ||
    it.uris.some(u => u.toLowerCase().includes(q))
  )
  const rows = hits.slice(0, 100).map(it => ({ id: it.id, name: it.name, username: it.username, address: it.uris[0] || '' }))
  return {
    message: hits.length ? `${hits.length} Treffer${hits.length > 100 ? ' (die ersten 100)' : ''}` : `Nichts gefunden für „${query}“.`,
    messageType: hits.length ? 'success' : 'warning',
    table: {
      columns: [
        { key: 'name', title: 'Name' },
        { key: 'username', title: 'Benutzer', copy: true },
        { key: 'address', title: 'Adresse', copy: true }
      ],
      rows,
      rowButtons: [
        { label: 'SSH', action: 'openSsh' },
        { label: 'RDP', action: 'openRdp' },
        { label: 'Passwort kopieren', action: 'copyPassword' },
        { label: 'Details', action: 'details' }
      ]
    },
    buttons: actionButtons()
  }
}

async function run (cfg = {}) {
  try {
    const s = readSettings()
    const { rememberSession, ...rest } = s
    writeSettings({ ...rest, bwPath: String(cfg.bwPath || '').trim() })
    forgetStoredSession()
    const fresh = await unlock(cfg)
    if (!state.items) await refresh(true)
    const query = String(cfg.query || '').trim()
    if (query) return search(query)
    return statusResult(fresh ? 'Angemeldet. ' : '')
  } catch (e) {
    return failure(e)
  }
}

async function syncNow () {
  try {
    await ensureSession()
    await refresh(true)
    return statusResult()
  } catch (e) {
    return failure(e)
  }
}

async function lockAction () {
  await lock()
  return { message: 'Gesperrt. Sitzungsschlüssel und Eintragsliste sind gelöscht.', messageType: 'info' }
}

/** Verbindung aus einem Eintrag: Adresse aus der passenden URI, sonst der ersten brauchbaren. */
function buildTab (it, type) {
  const login = it.login || {}
  const uris = (login.uris || []).map(u => parseUri(u && u.uri)).filter(Boolean)
  const u = uris.find(x => x.scheme === type) || uris.find(x => x.scheme === '') || uris.find(x => !WEB.includes(x.scheme)) || uris[0]
  if (!u) throw new Error('Der Eintrag hat keine Adresse (URI).')
  const port = (u.scheme === type || u.scheme === '') && u.port ? u.port : DEFAULT_PORTS[type]
  const tab = { type, title: it.name || `${type.toUpperCase()} ${u.host}`, host: u.host, port, username: login.username || '', password: login.password || '' }
  if (type === 'ssh') Object.assign(tab, { authType: 'password', enableSsh: true, enableSftp: true })
  return tab
}

async function open (row, type) {
  try {
    await ensureSession()
    const tab = buildTab(await getItem(row.id), type)
    return { openTab: tab, message: `Öffne ${type.toUpperCase()} ${tab.username ? tab.username + '@' : ''}${tab.host}:${tab.port}`, messageType: 'success' }
  } catch (e) {
    return failure(e)
  }
}

async function copyPassword (row) {
  try {
    await ensureSession()
    const it = await getItem(row.id)
    const pw = (it.login && it.login.password) || ''
    if (!pw) return { message: 'Der Eintrag hat kein Passwort.', messageType: 'warning' }
    await api.clipboard.write(pw)
    setTimeout(async () => {
      try {
        if (await api.clipboard.read() === pw) await api.clipboard.write('')
      } catch (e) {}
    }, CLIPBOARD_CLEAR_MS).unref?.()
    return { message: `Passwort von „${it.name}“ kopiert, wird in 30 s aus der Zwischenablage entfernt.`, messageType: 'success' }
  } catch (e) {
    return failure(e)
  }
}

async function details (row) {
  try {
    await ensureSession()
    const it = await getItem(row.id)
    const login = it.login || {}
    return {
      details: [
        { label: 'Name', value: it.name || '', copy: true },
        { label: 'Benutzer', value: login.username || '', copy: true },
        { label: 'Passwort', value: login.password || '', secret: true, copy: true },
        ...(login.uris || []).map((u, i) => ({ label: `URI ${i + 1}`, value: u.uri || '', copy: true }))
      ]
    }
  } catch (e) {
    return failure(e)
  }
}

module.exports = {
  run,
  syncNow,
  lockAction,
  openSsh: row => open(row, 'ssh'),
  openRdp: row => open(row, 'rdp'),
  copyPassword,
  details,
  getCredentials,
  saveCredentials,
  // für Tests
  _test: { state, parseUri, matchItems, decide, buildTab, setApi: a => { api = a } }
}
