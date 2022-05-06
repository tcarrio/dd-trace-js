'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const ClientPlugin = require('./client')
const ServerPlugin = require('./server')

class GrpcPlugin extends Plugin {
  static get name () {
    return 'grpc'
  }

  constructor (...args) {
    super(...args)
    this.client = new ClientPlugin(...args)
    this.server = new ServerPlugin(...args)
  }

  configure (config) {
    super.configure(config)
    this.client.configure(config)
    this.server.configure(config)
  }
}

module.exports = GrpcPlugin
