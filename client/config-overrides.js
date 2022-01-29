const ResolveTypeScriptPlugin = require('resolve-typescript-plugin')

module.exports = function override(config) {
  config.resolve.plugins.push(new ResolveTypeScriptPlugin())
  return config
}
