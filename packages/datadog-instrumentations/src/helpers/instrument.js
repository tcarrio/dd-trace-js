'use strict'

const dc = require('diagnostics_channel')
const path = require('path')
const semver = require('semver')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const { AsyncResource } = require('async_hooks')
const log = require('../../../dd-trace/src/log')
const {prototype} = require('events')

const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')
const channelMap = {}
exports.channel = function channel (name) {
  const maybe = channelMap[name]
  if (maybe) return maybe
  const ch = dc.channel(name)
  channelMap[name] = ch
  return ch
}

exports.addHook = function addHook ({ name, versions, file }, hook) {
  const fullFilename = filename(name, file)

  Hook([name], (moduleExports, moduleName, moduleBaseDir) => {
    moduleName = moduleName.replace(pathSepExpr, '/')

    if (moduleName !== fullFilename || !matchVersion(getVersion(moduleBaseDir), versions)) {
      return moduleExports
    }

    try {
      return hook(moduleExports)
    } catch (e) {
      log.error(e)
      return moduleExports
    }
  })
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (name, file) {
  return [name, file].filter(val => val).join('/')
}

class DDAsyncResource extends AsyncResource {
  bind (fn, thisArg) {
    let bound
    if (thisArg === undefined) {
      const resource = this
      bound = function (...args) {
        args.unshift(fn, this)
        return Reflect.apply(resource.runInAsyncScope, resource, args)
      }
    } else {
      bound = this.runInAsyncScope.bind(this, fn, thisArg)
    }
    Object.defineProperty(bound, 'length', {
      configurable: true,
      enumerable: false,
      value: fn.length,
      writable: false
    })
    bound.asyncResource = this
    return bound
  }
}

// AsyncResource.bind exists and binds `this` properly only from 17.8.0 and up.
// https://nodejs.org/api/async_context.html#asyncresourcebindfn-thisarg
if (!semver.satisfies(process.versions.node, '>=17.8.0')) {
  DDAsyncResource.bind = function (fn, type, thisArg) {
    type = type || fn.name
    return (new exports.AsyncResource(type || 'bound-anonymous-fn')).bind(fn, thisArg)
  }
}

exports.AsyncResource = DDAsyncResource
