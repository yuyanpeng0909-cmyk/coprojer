const { fs, path, assert, sandbox, fixture } = require('./fixtures/verification-runtime.cjs')

async function main() {
  for (const script of ['node apps/web/server.cjs', 'npm run serve --workspace apps/web', 'npm run serve --workspace apps/web --']) {
    const { service, project, root } = fixture()
    const web = path.join(root, 'apps/web'); fs.mkdirSync(web, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'preview-root', private: true, workspaces: ['apps/web'], scripts: { dev: script } }))
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'preview-web', scripts: { serve: 'node server.cjs' } }))
    fs.writeFileSync(path.join(web, 'server.cjs'), `
const assert = require('node:assert/strict'), http = require('node:http')
const args = process.argv.slice(2)
assert.equal(args[0], '--host'); assert.equal(args[1], '127.0.0.1'); assert.equal(args[2], '--port')
http.createServer((req, res) => res.end('forwarded preview')).listen(Number(args[3]), args[1])
`)
    try {
      const url = await service.startPreview(project.id, 'dev')
      assert.equal(await (await fetch(url)).text(), 'forwarded preview')
      console.log('PASS:', script, 'receives exact host/port and serves the selected origin')
    } finally { service.stopPreview(project.id); service.dispose() }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }))
