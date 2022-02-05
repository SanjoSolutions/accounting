const ResolveTypeScriptPlugin = require('resolve-typescript-plugin')

module.exports = function override(config) {
  config.resolve.plugins.push(new ResolveTypeScriptPlugin())
  config.ignoreWarnings = [/Failed to parse source map/]
  return config
}
