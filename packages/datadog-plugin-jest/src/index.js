const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

const {
  CI_APP_ORIGIN,
  TEST_STATUS,
  JEST_TEST_RUNNER,
  finishAllTraceSpans,
  getTestEnvironmentMetadata,
  getTestParentSpan,
  getTestCommonTags,
  TEST_PARAMETERS,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS,
  getTestSessionCommonTags,
  getTestSuiteCommonTags
} = require('../../dd-trace/src/plugins/util/test')

function getTestSpanMetadata (tracer, test) {
  const childOf = getTestParentSpan(tracer)

  const { suite, name, runner, testParameters } = test

  const commonTags = getTestCommonTags(name, suite, tracer._version)

  return {
    childOf,
    ...commonTags,
    [JEST_TEST_RUNNER]: runner,
    [TEST_PARAMETERS]: testParameters
  }
}

function getTestSessionSpanMetadata (tracer, command) {
  const childOf = getTestParentSpan(tracer)

  const commonTags = getTestSessionCommonTags(command, tracer._version)

  return {
    childOf,
    ...commonTags
  }
}

class JestPlugin extends Plugin {
  static get name () {
    return 'jest'
  }

  constructor (...args) {
    super(...args)

    this.testEnvironmentMetadata = getTestEnvironmentMetadata('jest', this.config)
    this.codeOwnersEntries = getCodeOwnersFileEntries()

    this.addSub('ci:jest:session:configuration', config => {
      config._ddTestSessionTraceId = this.testSessionSpan.context()._traceId.toString(10)
      config._ddTestSessionSpanId = this.testSessionSpan.context()._spanId.toString(10)
    })

    this.addSub('ci:jest:session:start', (command) => {
      const { childOf, ...testSessionSpanMetadata } = getTestSessionSpanMetadata(this.tracer, command)
      this.command = command
      this.testSessionSpan = this.tracer.startSpan('jest.test_session', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
      this.testSessionSpanContext = this.testSessionSpan.context()
      // suites are run in a different process, so "this.testSessionSpan" will not work
      // get this.testSessionSpan trace id/span id and pass it as testEnvironmentOptions. So these ids are available for
      // the test suite spans
    })

    this.addSub('ci:jest:session:finish', () => {
      this.testSessionSpan.setTag(TEST_STATUS, 'pass')
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter._writer.flush()
    })

    this.addSub('ci:jest:test-suite:start', ({ testSuite, testSessionSpanId, testSessionTraceId }) => {
      if (!this.testSessionSpanContext) { // it's not there because it's in a different process
        this.testSessionSpanContext = this.tracer.extract('text_map', {
          'x-datadog-trace-id': testSessionTraceId,
          'x-datadog-span-id': testSessionSpanId,
          'x-datadog-parent-id': '0000000000000000'
        })
      }

      const testSuiteMetadata = getTestSuiteCommonTags(this.tracer._version, testSuite)
      this.testSuiteSpan = this.tracer.startSpan('jest.test_suite', {
        childOf: this.testSessionSpanContext,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
    })

    this.addSub('ci:jest:test-suite:finish', () => {
      this.testSuiteSpan.setTag(TEST_STATUS, 'pass')
      this.testSuiteSpan.finish()
      this.tracer._exporter._writer.flush()
    })

    this.addSub('ci:jest:test:start', (test) => {
      const store = storage.getStore()
      const span = this.startTestSpan(test)

      this.enter(span, store)
    })

    this.addSub('ci:jest:test:finish', (status) => {
      const span = storage.getStore().span
      span.setTag(TEST_STATUS, status)
      span.finish()
      finishAllTraceSpans(span)
    })

    this.addSub('ci:jest:test:err', (error) => {
      if (error) {
        const span = storage.getStore().span
        span.setTag(TEST_STATUS, 'fail')
        span.setTag('error', error)
      }
    })

    this.addSub('ci:jest:test:skip', (test) => {
      const span = this.startTestSpan(test)
      span.setTag(TEST_STATUS, 'skip')
      span.finish()
    })
  }

  startTestSpan (test) {
    const { childOf, ...testSpanMetadata } = getTestSpanMetadata(this.tracer, test)

    const codeOwners = getCodeOwnersForFilename(test.suite, this.codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    const testSpan = this.tracer
      .startSpan('jest.test', {
        childOf: this.tracer.extract('text_map', {
          'x-datadog-trace-id': this.testSessionSpanContext._traceId.toString(10),
          'x-datadog-parent-id': this.testSuiteSpan.context()._spanId.toString(10)
        }),
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = JestPlugin
