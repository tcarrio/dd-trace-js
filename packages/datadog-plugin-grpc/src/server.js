'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { ERROR } = require('../../../ext/tags')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

const Plugin = require('../../dd-trace/src/plugins/plugin')
const storage = require('../../datadog-core')

// https://github.com/grpc/grpc/blob/master/doc/statuscodes.md
const OK = 0
const CANCELLED = 1

class GrpcServerPlugin extends Plugin {
  constructor (...args) {
    this.addSub('apm:grpc:server:start', ({ metadata, type, handler }) => {
      const tracer = this.tracer
      const config = this.config
      const childOf = extract(tracer, metadata)
      const span = tracer.startSpan('grpc.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: 'server',
          'span.type': 'web',
          'resource.name': handler,
          'service.name': config.service || `${tracer._service}`,
          'component': 'grpc'
        }
      })

      analyticsSampler.sample(span, config.measured, true)
      addMethodTags(span, handler, type)
      addMetadataTags(span, metadata, filter, 'request')

      this.enter(span, storage.getStore())
    })
    this.addSub('apm:grpc:server:cancelled', () => {
      const { span } = storage.getStore()
      span.setTag('grpc.status.code', CANCELLED)
      span.finish()
    })
    this.addSub('apm:grpc:server:error', (err) => {
      const { span } = storage.getStore()
      span.addTags({
        [ERROR]: err || 1,
        'grpc.status.code': err && err.code
      })

      span.finish()
    })
    this.addSub('apm:grpc:server:status', status => {
      const { span } = storage.getStore()
      if (status) {
        span.setTag('grpc.status.code', status.code)
      }

      if (!status || status.code === 0) {
        span.finish()
      }
    })
    this.addSub('apm:grpc:server:statusCode', (code) => {
      const { span } = storage.getStore()
      span.setTag('grpc.status.code', code)
    })
    this.addSub('apm:grpc:server:finish', ({ err, trailer }) => {
      const { span } = storage.getStore()
      if (err instanceof Error) {
        if (err.code) {
          span.setTag('grpc.status.code', err.code)
        }

        span.setTag(ERROR, err)
      } else {
        span.setTag('grpc.status.code', OK)
      }

      if (trailer && filter) {
        addMetadataTags(span, trailer, this.filter, 'response')
      }

      span.finish()

    })
  }

  configure (config) {
    super.configure(config)
    this.filter = getFilter(this.config, 'metadata')
  }
}

function extract (tracer, metadata) {
  if (!metadata || typeof metadata.getMap !== 'function') return null

  return tracer.extract(TEXT_MAP, metadata.getMap())
}

module.exports = GrpcServerPlugin
