const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const w = require('../main.js')
const { state, parseUri, matchItems, decide, buildTab, tick, lockStale, checkServer, parseAutoLock } = w._test

const fakeBw = path.join(__dirname, 'fake-bw.js')
fs.chmodSync(fakeBw, 0o755)
const items = require('./items.json').filter(i => i.type === 1).map(it => ({
  id: it.id, name: it.name, username: it.login.username, uris: it.login.uris.map(u => u.uri), hasPassword: true
}))

let dir
const clipboard = { text: '' }
w._test.setApi({
  log () {},
  clipboard: { write: async t => { clipboard.text = t }, read: async () => clipboard.text }
})

const cfg = extra => ({ serverUrl: 'https://vault.example.com/', email: 'Stefan@example.com', bwPath: fakeBw, ...extra })
const fake = () => JSON.parse(fs.readFileSync(path.join(dir, 'bw', 'fake.json'), 'utf8'))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-'))
  process.env.ELECTERM_VW_DIR = dir
  if (state.watcher) clearInterval(state.watcher)
  Object.assign(state, { session: '', items: null, syncedAt: 0, server: '', email: '', refreshing: null, lastUsed: 0, lastTick: 0, autoLockMs: null, lockReason: '', clipboardPw: '', watcher: null, startup: null })
  clipboard.text = ''
})

test('parseUri', () => {
  assert.deepEqual(parseUri('ssh://Web.LAN:22'), { scheme: 'ssh', host: 'web.lan', port: 22 })
  assert.deepEqual(parseUri('pi.lan:2222'), { scheme: '', host: 'pi.lan', port: 2222 })
  assert.deepEqual(parseUri('rdp://10.0.0.5'), { scheme: 'rdp', host: '10.0.0.5', port: 0 })
  assert.deepEqual(parseUri('https://nas.lan:5001/x'), { scheme: 'https', host: 'nas.lan', port: 5001 })
  assert.deepEqual(parseUri('[fe80::1]:22'), { scheme: '', host: 'fe80::1', port: 22 })
  assert.equal(parseUri(''), null)
})

test('matchItems und decide', () => {
  const m = matchItems(items, { type: 'ssh', host: 'web.lan', port: 22 })
  assert.deepEqual(m.entries.map(e => e.id), ['a1', 'a2'])
  // Benutzer im Lesezeichen entscheidet
  assert.equal(decide(m, 'deploy').use.id, 'a2')
  // ohne Benutzer: Auswahl
  assert.deepEqual(decide(m, '').choose.entries.map(e => e.id), ['a1', 'a2'])
  // falscher Port passt nicht
  assert.equal(matchItems(items, { type: 'ssh', host: 'web.lan', port: 2200 }).entries.map(e => e.id).join(), 'a2')
  assert.equal(decide(matchItems(items, { type: 'ssh', host: 'pi.lan', port: 2222 }), '').use.id, 'e1')
  assert.ok(decide(matchItems(items, { type: 'ssh', host: 'pi.lan', port: 22 }), '').none)
  // rdp-URI nicht für ssh
  assert.ok(decide(matchItems(items, { type: 'ssh', host: '10.0.0.5', port: 22 }), '').none)
  assert.equal(decide(matchItems(items, { type: 'rdp', host: '10.0.0.5', port: 3389 }), 'admin').use.id, 'b1')
  // Web-URI und Name nur als Alternative
  const nas = decide(matchItems(items, { type: 'ssh', host: 'nas.lan', port: 22 }), 'admin')
  assert.deepEqual(nas.choose.alternatives.map(e => e.id), ['c1'])
  const r = decide(matchItems(items, { type: 'ssh', host: '192.168.1.1', port: 22, title: 'Router' }), '')
  assert.deepEqual(r.choose.alternatives.map(e => e.id), ['d1'])
})

test('buildTab', () => {
  const t = buildTab({ name: 'Pi', login: { username: 'pi', password: 'x', uris: [{ uri: 'pi.lan:2222' }] } }, 'ssh')
  assert.deepEqual(t, { type: 'ssh', title: 'Pi', host: 'pi.lan', port: 2222, username: 'pi', password: 'x', authType: 'password', enableSsh: true, enableSftp: true })
  assert.equal(buildTab({ name: 'T', login: { uris: [{ uri: 'rdp://10.0.0.5' }] } }, 'rdp').port, 3389)
  // Port einer ssh-URI gilt nicht für RDP
  assert.equal(buildTab({ name: 'W', login: { uris: [{ uri: 'ssh://web.lan:2200' }] } }, 'rdp').port, 3389)
  assert.throws(() => buildTab({ name: 'x', login: { uris: [] } }, 'ssh'))
})

test('gesperrt: getCredentials wirft verständlichen Fehler', async () => {
  await assert.rejects(w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22 }), /gesperrt/)
})

test('Anmelden mit 2FA, Lesezeichen bedienen, speichern, sperren', async () => {
  let r = await w.run(cfg({ masterPassword: 'master' }))
  assert.equal(r.messageType, 'error')
  assert.match(r.message, /Zwei-Faktor/)
  r = await w.run(cfg({ masterPassword: 'master', twoFactorCode: '123 456' }))
  assert.equal(r.messageType, 'success', r.message)
  assert.match(r.message, /6 Logins/)
  assert.equal(fake().server, 'https://vault.example.com')
  // Master-Passwort und Code nie als Argument
  assert.ok(fake().calls.every(c => !c.includes('master')))

  assert.deepEqual(await w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22, username: 'root' }), { pick: { login: 'root', password: 'pw-root' } })
  const ch = await w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22 })
  assert.equal(ch.pick, 'choose')
  assert.equal(ch.url, 'ssh://web.lan:22')
  assert.deepEqual(ch.entries, [{ uuid: 'a1', name: 'Webserver', login: 'root' }, { uuid: 'a2', name: 'Webserver deploy', login: 'deploy' }])
  assert.ok(ch.entries.every(e => !('password' in e)))
  assert.deepEqual(await w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22, uuid: 'a2' }), { pick: { login: 'deploy', password: 'pw-deploy' } })
  assert.deepEqual(await w.getCredentials({ type: 'ssh', host: 'unbekannt', port: 22 }), { pick: null })

  // neuer Eintrag
  assert.deepEqual(await w.saveCredentials({ target: { type: 'ssh', host: 'neu.lan', port: 22, title: 'Neu' }, login: 'bob', password: 'pw-neu' }), { ok: true, url: 'ssh://neu.lan:22' })
  assert.deepEqual(await w.getCredentials({ type: 'ssh', host: 'neu.lan', port: 22 }), { pick: { login: 'bob', password: 'pw-neu' } })
  // vorhandenen reparieren
  await w.saveCredentials({ target: { type: 'ssh', host: 'pi.lan', port: 2222 }, login: 'pi', password: 'pw-pi-2', uuid: 'e1' })
  assert.deepEqual(await w.getCredentials({ type: 'ssh', host: 'pi.lan', port: 2222 }), { pick: { login: 'pi', password: 'pw-pi-2' } })

  // Passwörter nie in der Befehlszeile (Einträge gehen per stdin an bw)
  assert.ok(fake().calls.every(c => !c.includes('pw-')), fake().calls.join('\n'))
  assert.ok(fake().calls.filter(c => /^(create|edit) /.test(c)).every(c => c.split(' ').length <= 3))

  // Suche + Aktionen
  r = await w.run(cfg({ query: 'webserver' }))
  assert.deepEqual(r.table.rows.map(x => x.id), ['a1', 'a2'])
  assert.ok(JSON.stringify(r).indexOf('pw-') < 0, 'keine Passwörter in der Tabelle')
  const o = await w.openSsh(r.table.rows[1])
  assert.equal(o.openTab.password, 'pw-deploy')
  assert.equal(o.openTab.host, 'web.lan')
  await w.copyPassword({ id: 'b1' })
  assert.equal(clipboard.text, 'pw-rdp')
  const d = await w.details({ id: 'b1' })
  assert.ok(JSON.stringify(d).indexOf('pw-') < 0, 'kein Passwort in den Details')
  assert.match(JSON.stringify(d), /gespeichert/)

  r = await w.lockAction()
  assert.equal(clipboard.text, '', 'Sperren leert die Zwischenablage')
  await assert.rejects(w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22 }), /gesperrt/)
  // entsperren (bereits angemeldet) ohne Passwort geht nicht, mit schon
  r = await w.run(cfg())
  assert.match(r.message, /Master-Passwort/)
  r = await w.run(cfg({ masterPassword: 'falsch' }))
  assert.equal(r.message, 'Master-Passwort oder E-Mail falsch.')
  r = await w.run(cfg({ masterPassword: 'master' }))
  assert.equal(r.messageType, 'success', r.message)
})

test('API-Schlüssel; alte session.dat wird gelöscht, nach Neustart gesperrt', async () => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.dat'), 'alt')
  const r = await w.run(cfg({ masterPassword: 'master', clientId: 'user.x', clientSecret: 'geheim' }))
  assert.equal(r.messageType, 'success', r.message)
  assert.ok(!fs.existsSync(path.join(dir, 'session.dat')))
  assert.deepEqual(await w.getCredentials({ type: 'rdp', host: '10.0.0.5', port: 3389 }), { pick: { login: 'admin', password: 'pw-rdp' } })
  // „Neustart“: Speicher leer → gesperrt
  Object.assign(state, { session: '', items: null, syncedAt: 0 })
  await assert.rejects(w.getCredentials({ type: 'rdp', host: '10.0.0.5', port: 3389 }), /gesperrt/)
})

test('anderes Konto: abmelden und neu anmelden', async () => {
  await w.run(cfg({ masterPassword: 'master', twoFactorCode: '1' }))
  Object.assign(state, { session: '' })
  const r = await w.run(cfg({ email: 'anna@example.com', masterPassword: 'master', twoFactorCode: '1' }))
  assert.equal(r.messageType, 'success', r.message)
  assert.ok(fake().calls.includes('logout'))
  assert.equal(fake().email, 'anna@example.com')
})

test('Datenordner nur für den eigenen Benutzer', { skip: process.platform === 'win32' }, async () => {
  fs.chmodSync(dir, 0o755)
  fs.mkdirSync(path.join(dir, 'bw'), { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'bw', 'data.json'), '{}', { mode: 0o644 })
  await w.run(cfg({ masterPassword: 'master', twoFactorCode: '1' }))
  const mode = f => fs.statSync(f).mode & 0o777
  assert.equal(mode(dir), 0o700)
  assert.equal(mode(path.join(dir, 'bw')), 0o700)
  assert.equal(mode(path.join(dir, 'bw', 'data.json')), 0o600)
  assert.equal(mode(path.join(dir, 'settings.json')), 0o600)
})

test('nur https (http nur für localhost)', async () => {
  assert.doesNotThrow(() => checkServer('https://vault.example.com'))
  assert.doesNotThrow(() => checkServer('http://localhost:8080'))
  assert.doesNotThrow(() => checkServer('http://127.0.0.1'))
  assert.throws(() => checkServer('http://vault.example.com'), /https/)
  assert.throws(() => checkServer('ftp://vault.example.com'), /https/)
  assert.throws(() => checkServer('https://u:p@vault.example.com'), /ohne Benutzer/)
  const r = await w.run(cfg({ serverUrl: 'http://vault.example.com', masterPassword: 'master' }))
  assert.equal(r.messageType, 'error')
  assert.ok(!fs.existsSync(path.join(dir, 'bw', 'fake.json')), 'bw wurde gar nicht erst aufgerufen')
})

test('Telnet/FTP: URI ohne Schema nur zur Auswahl', () => {
  // a2 hat die URI „web.lan“ ohne Schema
  const t = decide(matchItems(items, { type: 'telnet', host: 'web.lan', port: 23 }), 'deploy')
  assert.ok(!t.use, 'nie automatisch')
  assert.deepEqual(t.choose.alternatives.map(e => e.id), ['a2'])
  // für SSH weiterhin automatisch
  assert.equal(decide(matchItems(items, { type: 'ssh', host: 'web.lan', port: 22 }), 'deploy').use.id, 'a2')
})

test('automatische Sperre nach Inaktivität und Ruhezustand', async () => {
  assert.equal(parseAutoLock(undefined), 30 * 60000)
  assert.equal(parseAutoLock(0), 0)
  assert.equal(parseAutoLock(-5), 30 * 60000)
  assert.equal(parseAutoLock(99999), 24 * 60 * 60000)

  let r = await w.run(cfg({ masterPassword: 'master', twoFactorCode: '1', autoLockMinutes: 5 }))
  assert.match(r.message, /nach 5 min/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).autoLockMinutes, 5)
  const t0 = Date.now()
  // Benutzung hält offen
  await tick(t0 + 60000)
  await tick(t0 + 120000)
  assert.ok(state.session)
  state.lastUsed = t0
  await tick(t0 + 180000)
  await tick(t0 + 240000)
  await tick(t0 + 300000)
  assert.equal(state.session, '')
  assert.equal(fake().status, 'locked', 'bw lock ausgeführt')
  await assert.rejects(w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22 }), /automatisch gesperrt: nach 5 min/)

  // Ruhezustand: große Lücke zwischen zwei Prüfungen, auch wenn die Sperre aus ist
  r = await w.run(cfg({ masterPassword: 'master', autoLockMinutes: 0 }))
  assert.equal(r.messageType, 'success', r.message)
  assert.match(r.message, /Automatische Sperre aus/)
  const t1 = Date.now()
  state.lastTick = t1
  await tick(t1 + 60000)
  assert.ok(state.session)
  await tick(t1 + 60000 + 10 * 60000)
  assert.equal(state.session, '')
  await assert.rejects(w.getCredentials({ type: 'ssh', host: 'web.lan', port: 22 }), /Ruhezustand/)
})

test('beim Start: offen gelassenen Tresor sperren', async () => {
  await w.run(cfg({ masterPassword: 'master', twoFactorCode: '1' }))
  assert.equal(fake().status, 'unlocked')
  // „Absturz“: Speicher weg, Tresor auf der Platte noch entsperrt
  Object.assign(state, { session: '', items: null })
  await lockStale()
  assert.equal(fake().status, 'locked')
})

test('Geheimnisse aus der Umgebung von electerm gehen nicht an bw', async () => {
  process.env.BW_PASSWORD = 'aus-der-umgebung'
  try {
    const r = await w.run(cfg({ masterPassword: 'master', twoFactorCode: '1' }))
    assert.equal(r.messageType, 'success', r.message)
  } finally {
    delete process.env.BW_PASSWORD
  }
})
