'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const kinds = require('./kinds')

const startCh = channel('apm:grpc:client:start')
const errorCh = channel('apm:grpc:client:error')
const statusCh = channel('apm:grpc:client:status')

const patched = new WeakSet()
const instances = new WeakMap()

function getGrpc (client) {
  let proto = client

  do {
    const instance = instances.get(proto)
    if (instance) return instance
  } while ((proto = Object.getPrototypeOf(proto)))
}

function ensureMetadata (client, args, index) {
  const grpc = getGrpc(client)

  if (!client || !grpc) return args

  const meta = args[index]
  const normalized = []

  for (let i = 0; i < index; i++) {
    normalized.push(args[i])
  }

  if (!meta || !meta.constructor || meta.constructor.name !== 'Metadata') {
    normalized.push(new grpc.Metadata())
  }

  if (meta) {
    normalized.push(meta)
  }

  for (let i = index + 1; i < args.length; i++) {
    normalized.push(args[i])
  }

  return normalized
}

function wrapStream (stream, ar) {
  if (!stream || typeof stream.emit !== 'function') return

  const emit = stream.emit

  stream.emit = function (eventName, thing) {
    return ar.runInAsyncScope(() => {
      switch (eventName) {
        case 'error':
          errorCh.publish(thing)
          break
        case 'status':
          statusCh.publish(thing)
          break
      }

      return emit.apply(this, arguments)
    })
  }
}

function wrapCallback (innerAr, outerAr, callback) {
  return function (err) {
    if (err) innerAr.runInAsyncScope(() => errorCh.publish(err))
    if (callback) {
      return outerAr.runInAsyncScope(() => callback.apply(this, arguments))
    }
  }
}

function callMethod (client, method, args, path, metadata, methodKind) {
  const length = args.length
  const callback = args[length - 1]

  const outerAr = new AsyncResource('bound-anonymous-fn')

  const ar = new AsyncResource('bound-anonymous-fn')
  return ar.runInAsyncScope(() => {
    startCh.publish({ path, methodKind, metadata })

    if (methodKind === kinds.unary || methodKind === kinds.client_stream) {
      if (typeof callback === 'function') {
        args[length - 1] = wrapCallback(outerAr, callback)
      } else {
        args[length] = wrapCallback(outerAr)
      }
    }

    const result = method.apply(client, args)
    wrapStream(result)
    return result
  })
}

function wrapMakeRequest (methodKind) {
  return function (makeRequest) {
    return function wrapped (path) {
      const args = ensureMetadata(this, arguments, 4)

      return callMethod(this, makeRequest, args, path, args[4], methodKind)
    }
  }
}

function patch (grpc) {
  const proto = grpc.Client.prototype

  shimmer.wrap(proto, 'makeBidiStreamRequest', wrapMakeRequest(kinds.bidi))
  shimmer.wrap(proto, 'makeClientStreamRequest', wrapMakeRequest(kinds.clientStream))
  shimmer.wrap(proto, 'makeServerStreamRequest', wrapMakeRequest(kinds.serverStream))
  shimmer.wrap(proto, 'makeUnaryRequest', wrapMakeRequest(kinds.unary))
}

addHook({ name: 'grpc', versions: ['>=1.20.2'] }, patch)
addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'] }, patch)

function getMethodKind (definition) {
  if (definition.requestStream) {
    if (definition.responseStream) {
      return kinds.bidi
    }

    return kinds.client_stream
  }

  if (definition.responseStream) {
    return kinds.server_stream
  }

  return kinds.unary
}

function wrapMethod (method, path, methodKind) {
  if (typeof method !== 'function' || patched.has(method)) {
    return method
  }

  const methodWithTrace = function methodWithTrace () {
    const args = ensureMetadata(this, arguments, 1)

    return callMethod(this, method, args, path, args[1], methodKind)
  }

  Object.assign(methodWithTrace, method)

  patched.add(methodWithTrace)

  return methodWithTrace
}

function wrapClientConstructor (ServiceClient, methods) {
  const proto = ServiceClient.prototype

  if (typeof methods !== 'object' || 'format' in methods) return

  Object.keys(methods)
    .forEach(name => {
      if (!methods[name]) return

      const originalName = methods[name].originalName
      const path = methods[name].path
      const methodKind = getMethodKind(methods[name])

      if (methods[name]) {
        proto[name] = wrapMethod(proto[name], path, methodKind)
      }

      if (originalName) {
        proto[originalName] = wrapMethod(proto[originalName], path, methodKind)
      }
    })
}

addHook({ name: 'grpc', versions: ['>=1.20.2'], file: 'src/client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', makeClientConstructor => {
    return function wrapped (methods) {
      const ServiceClient = makeClientConstructor.apply(this, arguments)

      wrapClientConstructor(ServiceClient, methods)

      return ServiceClient
    }
  })
  return client
})

function wrapPackageDefinition (def) {
  for (const name in def) {
    if (def[name].format) continue
    if (def[name].service && def[name].prototype) {
      wrapClientConstructor(def[name], def[name].service)
    } else {
      wrapPackageDefinition(def[name])
    }
  }
}

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'], file: 'build/src/make-client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', makeClientConstructor => {
    return function wrapped (methods) {
      const ServiceClient = makeClientConstructor.apply(this, arguments)

      wrapClientConstructor(ServiceClient, methods)

      return ServiceClient
    }
  })
  shimmer.wrap(client, 'loadPackageDefinition', loadPackageDefinition => {
    return function wrapped (methods) {
      const result = loadPackageDefinition.apply(this, arguments)

      if (!result) return result

      wrapPackageDefinition(result)

      return result
    }
  })

  return client
})
