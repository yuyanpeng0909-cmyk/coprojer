const { rm } = require('node:fs/promises')
const path = require('node:path')

// A local electronDist includes Electron's demo launcher. It is not part of Coprojer.
module.exports = async ({ appOutDir, electronPlatformName }) => {
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, 'Coprojer.app', 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
  await rm(path.join(resources, 'default_app.asar'), { force: true })
}
