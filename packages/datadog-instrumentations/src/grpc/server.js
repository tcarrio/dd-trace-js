'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const kinds = require('./kinds')

const startCh = channel('apm:grpc:server:start')
const cancelledCh = channel('apm:grpc:server:cancelled')
const errorCh = channel('apm:grpc:server:error')
const statusCh = channel('apm:grpc:server:status')
const statusCodeCh = channel('apm:grpc:server:statusCode')
const finishCh = channel('apm:grpc:server:finish')

function isEmitter (obj) {
  return typeof obj.emit === 'function' && typeof obj.once === 'function'
}

function wrapSendStatus (sendStatus, span) {
  return function sendStatusWithTrace (status) {
    statusCodeCh.publish(status.code)
    return sendStatus.apply(this, arguments)
  }
}

function wrapStream (call, ar) {
  const emit = call.emit

  if (call.call && call.call.sendStatus) {
    call.call.sendStatus = wrapSendStatus(call.call.sendStatus, span)
  }

  call.emit = function (eventName, ...args) {
    return ar.runInAsyncScope(() => {
      switch (eventName) {
        case 'error':
          errorCh.publish(args[0])
          break
        case 'finish':
          statusCh.publish(call.status)
          break
      }

      return emit.apply(this, arguments)
    })
  }
}

function wrapCallback (innerAr, outerAr, callback) {
  return function (err, value, trailer, flags) {
    innerAr.runInAsyncScope(() => finishCh.publish({ err, trailer }))

    if (callback) {
      return outerAr.runInAsyncScope(callback.bind(this, ...arguments))
    }
  }
}

function wrapHandler (handler, func) {
  return function wrapHandler (func) {
    const isValid = (server, args) => {
      if (!server || !server.type) return false
      if (!args[0]) return false
      if (server.type !== 'unary' && !isEmitter(args[0])) return false
      if (server.type === 'unary' && typeof args[1] !== 'function') return false

      return true
    }

    return function wrappedHandler (call, callback) {
      if (!isValid(this, arguments)) return func.apply(this, arguments)

      const outerAr = new AsyncResource('bound-anonymous-fn')
      const innerAr = new AsyncResource('bound-anonymous-fn')

      const metadata = call.metadata
      const type = kinds[this.type]
      const isStream = type !== 'unary'

      return innerAr.runInAsyncScope(() => {
        startCh.publish({ metadata, type, handler })

        call.once('cancelled', innerAr.bind(() => {
          cancelledCh.publish()
        }))

        if (isStream) {
          wrapStream(call, innerAr)
        } else {
          arguments[1] = wrapCallback(innerAr, outerAr, callback)
        }

        return func.apply(this, arguments)
      })
    }
  }
}

function wrapRegister (register) {
  return function wrapped (name, handler) {
    if (typeof handler === 'function') {
      arguments[1] = wrapHandler(name, handler)
    }

    return register.apply(this, arguments)
  }
}

addHook({ name: 'grpc', versions: ['>=1.20.2'], file: 'src/server.js' }, server => {
  shimmer.wrap(server.Server.prototype, 'register', wrapRegister)
  return server
})
addHook({ name: '@grpc/grpc-js', versions: ['>=1'], file: 'build/src/server.js' }, server => {
  shimmer.wrap(server.Server.prototype, 'register', wrapRegister)
  return server
})
