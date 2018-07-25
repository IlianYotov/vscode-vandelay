const { window, workspace } = require('vscode')
const path = require('path')
const fs = require('fs-extra')
const _ = require('lodash')
const anymatch = require('anymatch')
const {
  writeCacheFile,
  getLangFromFilePath,
  getFilepathKey,
} = require('./utils')
const { cacheFileManager } = require('./cacheFileManager')
const { PLUGINS } = require('./plugins')

function shouldIgnore(plugin, filePath) {
  return anymatch(plugin.excludePatterns, filePath)
}

function cacheDir(plugin, dir, recursive = true, data = { _extraImports: {} }) {
  return fs
    .readdir(dir)
    .then(items => {
      const readDirPromises = []

      for (const item of items) {
        const fullPath = path.join(dir, item)
        if (shouldIgnore(plugin, fullPath)) continue

        readDirPromises.push(
          fs.lstat(fullPath).then(stats => {
            if (stats.isFile()) {
              if (
                plugin.language !== getLangFromFilePath(item) ||
                item === plugin.configFile
              )
                return
              plugin.cacheFile(plugin, fullPath, data)
            } else if (recursive) {
              return cacheDir(plugin, fullPath, true, data)
            }
          })
        )
      }

      return Promise.all(readDirPromises)
    })
    .then(() => data)
}

function cacheProjectLanguage(plugin) {
  let cacher = Promise.all(
    plugin.includePaths.map(p => cacheDir(plugin, p))
  ).then(exportObjArrays => {
    const finalData = {}
    const extraImports = {}
    for (const data of exportObjArrays) {
      Object.assign(finalData, data)
      // Merge extra import arrays
      _.mergeWith(extraImports, data._extraImports, (obj, src) => {
        if (!Array.isArray(obj)) return
        return _.uniq(obj.concat(src))
      })
    }
    return Object.assign(finalData, { _extraImports: extraImports })
  })

  if (plugin.processCachedData) cacher = cacher.then(plugin.processCachedData)
  return cacher.then(data => writeCacheFile(plugin, data))
}

function cacheProject() {
  return Promise.all(_.map(PLUGINS, cacheProjectLanguage)).then(() => {
    // Don't return this because that will return a promise that doesn't resolve until the message gets dismissed
    window.showInformationMessage('Project exports have been cached. 🏖️')
  })
}

function onChangeOrCreate(doc) {
  const plugin = PLUGINS[getLangFromFilePath(doc.path)]
  if (
    !plugin ||
    shouldIgnore(plugin, doc.path) ||
    // TODO: Since we are watching all files in the workspace, not just those in plugin.includePaths,
    // we need to make sure that it is actually in that array. Can this be changed so that we only
    // watch files in plugin.includePaths to begin with? Not sure if this can be accomplished with
    // a single glob. If not, we'd need multiple watchers. Would either case be more efficient than
    // what we're currently doing?
    !plugin.includePaths.some(p => doc.path.startsWith(p))
  )
    return

  const data = plugin.cacheFile(plugin, doc.path)
  if (_.isEmpty(data)) return

  _.find(data, (v, k) => k !== '_extraImports').cached = Date.now()

  cacheFileManager(plugin, cachedData => {
    // Concatenate & dedupe named/types arrays. Merge them into data._extraImports since that will in turn get
    // merged back into cachedData
    _.mergeWith(data._extraImports, cachedData._extraImports, (a, b) => {
      if (_.isArray(a)) return _.union(a, b)
    })
    return writeCacheFile(plugin, Object.assign(cachedData, data))
  })
}

function watchForChanges() {
  // TODO: kill on deactivate?
  const watcher = workspace.createFileSystemWatcher('**/*.*')

  watcher.onDidChange(onChangeOrCreate)
  watcher.onDidCreate(onChangeOrCreate)

  watcher.onDidDelete(doc => {
    const plugin = PLUGINS[getLangFromFilePath(doc.path)]
    if (!plugin) return

    cacheFileManager(plugin, cachedData => {
      const key = getFilepathKey(plugin, doc.path)
      if (!cachedData[key]) return
      delete cachedData[key]
      return writeCacheFile(plugin, cachedData)
    })
  })
}

module.exports = {
  cacheProject,
  cacheProjectLanguage,
  watchForChanges,
  getFilepathKey,
  _test: {
    cacheDir,
  },
}
