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
  getTestSessionCommonTags,
  getTestSuiteCommonTags,
  TEST_PARAMETERS,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS,
  TEST_SESSION_ID,
  TEST_SUITE_ID,
  TEST_COMMAND
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

class JestPlugin extends Plugin {
  static get name () {
    return 'jest'
  }

  constructor (...args) {
    super(...args)

    this.testEnvironmentMetadata = getTestEnvironmentMetadata('jest', this.config)
    this.codeOwnersEntries = getCodeOwnersFileEntries()

    this.addSub('ci:jest:session:start', (command) => {
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, this.tracer._version)

      this.command = command
      this.testSessionSpan = this.tracer.startSpan('jest.test_session', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
    })

    this.addSub('ci:jest:session:finish', (status) => {
      this.testSessionSpan.setTag(TEST_STATUS, status)
      this.testSessionSpan.finish()
      finishAllTraceSpans(this.testSessionSpan)
      this.tracer._exporter._writer.flush()
    })

    // Test suites are run in different processes from the jest's main one.
    // This subscriber changes the configuration objects from jest to inject the trace id
    // of the test session to the processes that run the test suites.
    this.addSub('ci:jest:session:configuration', configs => {
      configs.forEach(config => {
        config._ddTestSessionId = this.testSessionSpan.context()._traceId.toString(10)
      })
    })

    this.addSub('ci:jest:test-suite:start', ({ testSuite, testSessionId }) => {
      const testSessionSpanContext = this.tracer.extract('text_map', {
        'x-datadog-trace-id': testSessionId,
        'x-datadog-span-id': testSessionId,
        'x-datadog-parent-id': '0000000000000000'
      })

      this.testSessionId = testSessionId
      const testSuiteMetadata = getTestSuiteCommonTags(this.tracer._version, testSuite)

      this.testSuiteSpan = this.tracer.startSpan('jest.test_suite', {
        childOf: testSessionSpanContext,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSuiteMetadata
        }
      })
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

    this.addSub('ci:jest:test-suite:finish', ({ status, errorMessage }) => {
      this.testSuiteSpan.setTag(TEST_STATUS, status)
      if (errorMessage) {
        this.testSuiteSpan.setTag('error', new Error(errorMessage))
      }
      this.testSuiteSpan.finish()
      this.tracer._exporter._writer.flush()
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
    const testSuiteId = this.testSuiteSpan.context()._traceId.toString(10)

    const {
      childOf,
      ...testSpanMetadata
    } = getTestSpanMetadata(this.tracer, test)

    const codeOwners = getCodeOwnersForFilename(test.suite, this.codeOwnersEntries)

    if (codeOwners) {
      testSpanMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    const testSpan = this.tracer
      .startSpan('jest.test', {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testSpanMetadata,
          [TEST_SUITE_ID]: testSuiteId,
          [TEST_SESSION_ID]: this.testSessionId,
          [TEST_COMMAND]: this.command
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }
}

module.exports = JestPlugin
