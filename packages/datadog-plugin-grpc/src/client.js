'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { ERROR } = require('../../../ext/tags')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

const Plugin = require('../../dd-trace/src/plugins/plugin')
const storage = require('../../datadog-core')

class GrpcClientPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub('apm:grpc:client:start', ({ path, methodKind, metadata }) => {
      const childOf = tracer.scope().active()
      const tags = {
        [Tags.SPAN_KIND]: 'client',
        'span.type': 'http',
        'resource.name': path,
        'service.name': this.config.service || `${this.tracer._service}-grpc-client`,
        'component': 'grpc'
      }
      const span = this.tracer.startSpan('grpc.request', {
        childOf,
        tags
      })

      if (metadata) {
        addMetadataTags(span, metadata, this.filter, 'request')
        if (typeof metadata.set === 'function') {
          const carrier = {}

          this.tracer.inject(span, TEXT_MAP, carrier)

          for (const key in carrier) {
            metadata.set(key, carrier[key])
          }
        }
      }

      analyticsSampler.sample(span, this.config.measured)
      addMethodTags(span, path, methodKind)

      this.enter(span, storage.getStore())
    })

    this.addSub('apm:grpc:client:error', err => {
      const { span } = storage.getStore()
      span.setTag(ERROR, err || 1)
    })

    this.addSub('apm:grpc:client:status', status => {
      const { span } = storage.getStore()
      if (status) {
        span.setTag('grpc.status.code', status.code)

        addMetadataTags(span, status.metadata, this.filter, 'response')
      }

      span.finish()
    })
  }

  configure (config) {
    super.configure(config)
    this.filter = getFilter(this.config, 'metadata')
  }
}

module.exports = GrpcClientPlugin
